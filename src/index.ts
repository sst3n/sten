import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { loadConfig } from './config.ts';
import { startDashboard } from './dashboard.ts';
import { decodeTrade, WSOL, type LeaderTrade } from './decode.ts';
import { LeaderFeed, makeQueue, type FeedMeta } from './feed.ts';
import { buildSwap, getQuote, type Quote } from './jupiter.ts';
import { fetchLeaderboard } from './leaderboard.ts';
import { startPush } from './push.ts';
import { applyBuy, applySell, checkEntry, decide, emptyState, exitReason, type State } from './strategy.ts';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MARK_SECONDS = 15; // how often open positions are re-priced

const lines: string[] = []; // recent log, for the dashboard
const log = (...a: unknown[]) => {
  const line = [new Date().toISOString(), ...a].join(' ');
  console.log(line);
  lines.push(line);
  if (lines.length > 200) lines.shift();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
process.on('unhandledRejection', (e) => log('unhandled rejection:', e));

const cfg = loadConfig();
const tag = cfg.mode === 'paper' ? '[paper]' : '[live]';
// Only used for live trading (sending swaps, reading our own balances).
const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed', wsEndpoint: cfg.wsUrl });
const state: State = existsSync(cfg.stateFile)
  ? { ...emptyState(), ...JSON.parse(readFileSync(cfg.stateFile, 'utf8')) }
  : emptyState();

function saveState() {
  writeFileSync(cfg.stateFile + '.tmp', JSON.stringify(state, null, 2));
  renameSync(cfg.stateFile + '.tmp', cfg.stateFile);
}

// Plain JSON-RPC for reading leader activity. FOMO sends version 1 transactions,
// which web3.js v1 refuses to parse, so these calls bypass it.
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 && attempt < 4) {
      await sleep(250 * 2 ** attempt + Math.random() * 100); // rate limited: back off briefly, not for seconds
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}

async function fetchTrade(signature: string, wallet: string): Promise<LeaderTrade | null> {
  // A just-confirmed transaction is sometimes not queryable for a moment.
  for (let i = 0; i < 5; i++) {
    const tx = await rpc('getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
    ]);
    if (tx) return decodeTrade(tx, wallet);
    await sleep(250 * (i + 1));
  }
  throw new Error('transaction not available from the RPC');
}

async function ourTokenBalance(mint: string): Promise<bigint> {
  const res = await conn.getParsedTokenAccountsByOwner(cfg.keypair!.publicKey, { mint: new PublicKey(mint) });
  return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

/** Paper mode: the quote is the fill. Live mode: sign, send and confirm the swap. */
async function execute(quote: Quote) {
  if (cfg.mode === 'paper') return;
  const kp = cfg.keypair!;
  const tx = VersionedTransaction.deserialize(Buffer.from(await buildSwap(cfg, quote, kp.publicKey.toBase58()), 'base64'));
  tx.sign([kp]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const bh = await conn.getLatestBlockhash('confirmed');
  const result = await conn.confirmTransaction({ signature, ...bh }, 'confirmed');
  if (result.value.err) throw new Error(`swap ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`);
  log(`  tx https://solscan.io/tx/${signature}`);
}

let solUsd = { price: 0, at: 0 };
async function solPriceUsd(): Promise<number> {
  if (Date.now() - solUsd.at > 60_000) {
    const q = await getQuote(cfg, WSOL, USDC, 1_000_000_000n);
    solUsd = { price: Number(q.outAmount) / 1e6, at: Date.now() };
  }
  return solUsd.price;
}

/** What the leader paid, in SOL per raw token unit. */
async function leaderPrice(trade: LeaderTrade): Promise<number | null> {
  const tokens = Number(trade.tokenPost - trade.tokenPre);
  if (!(tokens > 0)) return null;
  const sol = trade.quote === 'SOL' ? trade.quoteAmount : trade.quoteAmount / (await solPriceUsd());
  return sol / tokens;
}

async function buy(mint: string, sol: number, leader: Leader, trade: LeaderTrade) {
  const [quote, leaderSolPerToken] = await Promise.all([
    getQuote(cfg, WSOL, mint, BigInt(Math.round(sol * 1e9))),
    leaderPrice(trade).catch(() => null),
  ]);
  const tokensOut = BigInt(quote.outAmount);
  const back = tokensOut > 0n ? await getQuote(cfg, mint, WSOL, tokensOut) : null;
  const reason = checkEntry(
    { buySol: sol, tokensOut, sellBackSol: back ? Number(back.outAmount) / 1e9 : 0, leaderSolPerToken },
    cfg,
  );
  if (reason) return log(`  skip: ${reason}`);

  await execute(quote);
  // Live fills can differ slightly from the quote; sells re-check the real balance.
  applyBuy(state, mint, leader.address, tokensOut, sol, nowSec());
  saveState();
  const after = trade.blockTime === null ? '' : ` (${(Date.now() / 1000 - trade.blockTime).toFixed(1)}s after the leader)`;
  log(`  ${tag} bought ${quote.outAmount} raw of ${mint} for ${sol} SOL${after}`);
}

async function sell(mint: string, rawAmount: bigint, all: boolean, reason: string) {
  let amount = rawAmount;
  if (cfg.mode === 'live') {
    const actual = await ourTokenBalance(mint);
    if (all || amount > actual) amount = actual;
  }
  if (amount === 0n) {
    delete state.positions[mint];
    saveState();
    return log('  nothing to sell, position dropped');
  }
  const quote = await getQuote(cfg, mint, WSOL, amount);
  await execute(quote);
  const proceeds = Number(quote.outAmount) / 1e9;
  applySell(state, mint, all ? BigInt(state.positions[mint].tokens) : amount, proceeds, nowSec(), reason);
  saveState();
  const pnl = state.closed[state.closed.length - 1].pnlSol;
  log(`  ${tag} sold ${amount} raw of ${mint} for ${proceeds} SOL (${reason}, PnL ${pnl.toFixed(4)} SOL)`);
}

type Leader = { address: string; label?: string };

// Seconds from the leader's block to us seeing it, for the dashboard. Block
// times are whole seconds, so each figure can read up to a second too high.
const lagsSec: number[] = [];

async function act(trade: LeaderTrade, leader: Leader, m: FeedMeta) {
  const started = Date.now();
  let timing = '';
  if (trade.blockTime !== null) {
    const lag = m.seenAt / 1000 - trade.blockTime;
    lagsSec.push(lag);
    if (lagsSec.length > 50) lagsSec.shift();
    timing = ` [seen +${lag.toFixed(1)}s via ${m.via}, fetch ${m.fetchedAt - m.seenAt}ms, queued ${started - m.fetchedAt}ms]`;
  }
  const name = leader.label ?? leader.address.slice(0, 6);
  log(`${name} ${trade.side} ${trade.mint} for ${trade.quoteAmount} ${trade.quote}${timing}`);

  const d = decide(trade, leader.address, state, cfg, nowSec());
  if (d.type === 'skip') return log(`  skip: ${d.reason}`);
  if (d.type === 'buy') await buy(d.mint, d.sol, leader, trade);
  else await sell(d.mint, d.rawAmount, d.all, 'leader sold');
}

// Everything that changes positions or spend runs through here, one at a time.
const queue = makeQueue((e) => log('error:', e.message ?? e));

// What each open position would fetch if sold now. Drives our own exits and
// the dashboard.
const marks = new Map<string, number>();

async function markLoop() {
  while (true) {
    await sleep(MARK_SECONDS * 1000);
    const open = Object.entries(state.positions);
    // Price everything in parallel, outside the queue so leader trades never wait on it.
    const quotes = await Promise.all(open.map(([mint, p]) => getQuote(cfg, mint, WSOL, BigInt(p.tokens)).catch(() => null)));
    queue(async () => {
      for (const mint of [...marks.keys()]) if (!state.positions[mint]) marks.delete(mint);
      for (let i = 0; i < open.length; i++) {
        const [mint, seen] = open[i];
        const pos = state.positions[mint];
        const quote = quotes[i];
        if (!quote || !pos || pos.tokens !== seen.tokens) continue; // closed or changed while pricing
        const value = Number(quote.outAmount) / 1e9;
        marks.set(mint, value);
        const reason = exitReason(pos, value, nowSec(), cfg);
        if (!reason) continue;
        log(`${reason} on ${mint}: worth ${value.toFixed(4)} SOL, cost ${pos.costSol.toFixed(4)} SOL`);
        await sell(mint, BigInt(pos.tokens), true, reason).catch((e) => log(`  exit failed for ${mint}:`, e.message));
      }
    });
  }
}

// How we hear about leader trades. Push (websocket) is fastest; polling runs
// alongside as a safety net, and takes over by itself whenever push is down.
type Entry = { leader: Leader; cursor: string | null; feed: LeaderFeed<LeaderTrade> };
const watched = new Map<string, Entry>();

const wsUrl = cfg.wsUrl ?? cfg.rpcUrl.replace(/^http/, 'ws');
let pushDown = false;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const push = cfg.push
  ? startPush(
      wsUrl,
      (address, signature) => {
        const entry = watched.get(address);
        if (entry) entry.feed.ingest(signature, 'push');
      },
      {
        onReady: () => {
          log('push: connected');
          pushDown = false;
          // Trades that landed while it was down.
          for (const e of watched.values()) pollOnce(e).catch((err) => log('backfill failed:', err.message));
        },
        onDown: (why) => {
          if (pushDown) return; // reconnect attempts repeat the same failure
          pushDown = true;
          log(`push: down (${why}); polling every ${cfg.pollSeconds}s until it is back`);
        },
      },
      1000,
      // Websockets do not follow HTTPS_PROXY by themselves.
      proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {},
    )
  : null;

async function watch(leader: Leader) {
  if (watched.has(leader.address)) return;
  // Start from the leader's latest transaction so old trades are not replayed.
  // Retried patiently: starting up looks up every leader at once and can hit rate limits.
  let latest: { signature: string }[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      latest = await rpc('getSignaturesForAddress', [leader.address, { limit: 1, commitment: 'confirmed' }]);
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  const entry: Entry = {
    leader,
    cursor: latest[0]?.signature ?? null,
    feed: new LeaderFeed<LeaderTrade>(
      (signature) => fetchTrade(signature, leader.address),
      (trade, meta) => queue(() => act(trade, leader, meta).catch((e) => log(`error on ${meta.signature}:`, e.message))),
      (signature, e) => log(`error on ${signature}:`, e.message),
    ),
  };
  watched.set(leader.address, entry);
  push?.add(leader.address);
  void pollLoop(entry, Math.random() * cfg.pollSeconds * 1000); // spread leaders across the interval
}

async function pollOnce(entry: Entry) {
  const sigs: { signature: string; err: unknown }[] = await rpc('getSignaturesForAddress', [
    entry.leader.address,
    { limit: 50, commitment: 'confirmed', ...(entry.cursor ? { until: entry.cursor } : {}) },
  ]);
  if (sigs.length === 0) return;
  entry.cursor = sigs[0].signature; // newest first
  for (const s of sigs.reverse()) if (!s.err) entry.feed.ingest(s.signature, 'poll');
}

async function pollLoop(entry: Entry, startDelayMs: number) {
  await sleep(startDelayMs);
  // Each leader polls on its own, so one slow or rate-limited call delays nobody else.
  while (watched.get(entry.leader.address) === entry) {
    await pollOnce(entry).catch((e) => log(`poll failed for ${entry.leader.address}:`, e.message));
    await sleep((push?.healthy() ? cfg.backstopPollSeconds : cfg.pollSeconds) * 1000);
  }
}

async function refreshLeaderboard() {
  const board = await fetchLeaderboard(cfg.leaderboard!, cfg.bitqueryToken!);
  log(`leaderboard: ${board.length} wallet(s) qualify`);
  board.forEach((w, i) => log(`  #${i + 1} ${w.address} +$${w.profitUsd.toFixed(0)} over ${w.roundTrips} round trips`));
  for (const w of board) await watch({ address: w.address, label: `fomo-${w.address.slice(0, 4)}` });

  // Keep watching anyone we still hold a position from, so their exit is followed.
  const keep = new Set([
    ...cfg.leaders.map((l) => l.address),
    ...board.map((w) => w.address),
    ...Object.values(state.positions).map((p) => p.leader),
  ]);
  for (const address of [...watched.keys()]) {
    if (keep.has(address)) continue;
    watched.delete(address); // its poll loop ends on its next turn
    push?.remove(address);
  }
}

if (cfg.dashboardPort) {
  const startedAt = Date.now();
  // Local only by default; the page shows your positions.
  const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
  startDashboard(cfg.dashboardPort, host, () => ({
    mode: cfg.mode,
    startedAt,
    limits: cfg,
    state,
    marks,
    leaders: [...watched.values()].map((w) => w.leader),
    lines,
    lagsSec,
    feed: !push ? 'polling' : push.healthy() ? 'push' : 'polling (push down)',
  }));
  log(`dashboard on http://${host}:${cfg.dashboardPort}`);
}

for (const l of cfg.leaders) await watch(l);
// Positions opened from a leaderboard wallet in an earlier run still need their exit.
for (const p of Object.values(state.positions)) await watch({ address: p.leader });

if (cfg.leaderboard) {
  // A failed refresh keeps the current set; the next one tries again.
  const refresh = () => refreshLeaderboard().catch((e) => log('leaderboard refresh failed:', e.message));
  await refresh();
  setInterval(refresh, cfg.leaderboard.refreshMinutes * 60_000);
}

log(`mode=${cfg.mode} watching ${watched.size} leader(s), ${Object.keys(state.positions).length} open position(s)`);
log(push ? `feed: push (${wsUrl.split('?')[0]}), polling every ${cfg.backstopPollSeconds}s as a safety net` : `feed: polling every ${cfg.pollSeconds}s`);
if (cfg.mode === 'live') log(`trading wallet ${cfg.keypair!.publicKey.toBase58()}`);

void markLoop();
await new Promise<never>(() => {}); // run until stopped
