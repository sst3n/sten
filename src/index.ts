import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { loadConfig, type Config } from './config.ts';
import { decodeTrade, WSOL, type TxLike } from './decode.ts';
import { buildSwap, getQuote, type Quote } from './jupiter.ts';
import { fetchLeaderboard } from './leaderboard.ts';
import { applyBuy, applySell, decide, emptyState, type State } from './strategy.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

const cfg = loadConfig();
const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed', wsEndpoint: cfg.wsUrl });
const state: State = existsSync(cfg.stateFile)
  ? { ...emptyState(), ...JSON.parse(readFileSync(cfg.stateFile, 'utf8')) }
  : emptyState();

function saveState() {
  writeFileSync(cfg.stateFile + '.tmp', JSON.stringify(state, null, 2));
  renameSync(cfg.stateFile + '.tmp', cfg.stateFile);
}

async function fetchTx(signature: string): Promise<TxLike | null> {
  // Right after the log notification the transaction is often not queryable yet.
  for (let i = 0; i < 5; i++) {
    const tx = await conn.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx as unknown as TxLike;
    await sleep(400 * (i + 1));
  }
  return null;
}

async function ourTokenBalance(mint: string): Promise<bigint> {
  const res = await conn.getParsedTokenAccountsByOwner(cfg.keypair!.publicKey, { mint: new PublicKey(mint) });
  return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

/** Paper mode: the quote is the fill. Live mode: sign, send and confirm the swap. */
async function swap(c: Config, inputMint: string, outputMint: string, rawAmount: bigint): Promise<Quote> {
  const quote = await getQuote(c, inputMint, outputMint, rawAmount);
  if (c.mode === 'paper') return quote;

  const kp = c.keypair!;
  const tx = VersionedTransaction.deserialize(Buffer.from(await buildSwap(c, quote, kp.publicKey.toBase58()), 'base64'));
  tx.sign([kp]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const bh = await conn.getLatestBlockhash('confirmed');
  const result = await conn.confirmTransaction({ signature, ...bh }, 'confirmed');
  if (result.value.err) throw new Error(`swap ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`);
  log(`  tx https://solscan.io/tx/${signature}`);
  return quote;
}

async function handle(signature: string, leader: { address: string; label?: string }) {
  const tx = await fetchTx(signature);
  if (!tx) return log(`could not fetch ${signature}, skipping`);
  const trade = decodeTrade(tx, leader.address);
  if (!trade) return; // not a swap we understand (transfer, failed tx, token-to-token...)

  const name = leader.label ?? leader.address.slice(0, 6);
  log(`${name} ${trade.side} ${trade.mint} for ${trade.quoteAmount} ${trade.quote}`);
  const d = decide(trade, leader.address, state, cfg, nowSec());
  if (d.type === 'skip') return log(`  skip: ${d.reason}`);

  const tag = cfg.mode === 'paper' ? '[paper]' : '[live]';
  if (d.type === 'buy') {
    const quote = await swap(cfg, WSOL, d.mint, BigInt(Math.round(d.sol * 1e9)));
    // Live fills can differ slightly from the quote; sells re-check the real balance.
    applyBuy(state, d.mint, leader.address, BigInt(quote.outAmount), d.sol, nowSec());
    log(`  ${tag} bought ${quote.outAmount} raw of ${d.mint} for ${d.sol} SOL`);
  } else {
    let amount = d.rawAmount;
    if (cfg.mode === 'live') {
      const actual = await ourTokenBalance(d.mint);
      if (d.all || amount > actual) amount = actual;
    }
    if (amount === 0n) {
      delete state.positions[d.mint];
      saveState();
      return log('  nothing to sell, position dropped');
    }
    const quote = await swap(cfg, d.mint, WSOL, amount);
    const proceeds = Number(quote.outAmount) / 1e9;
    applySell(state, d.mint, d.all ? BigInt(state.positions[d.mint].tokens) : amount, proceeds);
    log(`  ${tag} sold ${amount} raw of ${d.mint} for ${proceeds} SOL (realized PnL ${state.realizedPnlSol.toFixed(4)} SOL)`);
  }
  saveState();
}

// One trade at a time, so limits and state are never raced.
let queue: Promise<void> = Promise.resolve();
const seen = new Set<string>();
const watched = new Map<string, number>(); // leader address -> log subscription id

function watch(leader: { address: string; label?: string }) {
  if (watched.has(leader.address)) return;
  const id = conn.onLogs(
    new PublicKey(leader.address),
    (logs) => {
      const key = `${logs.signature}:${leader.address}`;
      if (logs.err || seen.has(key)) return;
      seen.add(key);
      if (seen.size > 10_000) seen.clear();
      queue = queue.then(() => handle(logs.signature, leader)).catch((e) => log(`error on ${logs.signature}:`, e));
    },
    'confirmed',
  );
  watched.set(leader.address, id);
}

async function refreshLeaderboard() {
  const board = await fetchLeaderboard(cfg.leaderboard!, cfg.bitqueryToken!);
  log(`leaderboard: ${board.length} wallet(s) qualify`);
  board.forEach((w, i) => {
    log(`  #${i + 1} ${w.address} +$${w.profitUsd.toFixed(0)} over ${w.roundTrips} round trips`);
    watch({ address: w.address, label: `fomo-${w.address.slice(0, 4)}` });
  });

  // Keep watching anyone we still hold a position from, so their exit is followed.
  const keep = new Set([
    ...cfg.leaders.map((l) => l.address),
    ...board.map((w) => w.address),
    ...Object.values(state.positions).map((p) => p.leader),
  ]);
  for (const [address, id] of watched) {
    if (keep.has(address)) continue;
    watched.delete(address);
    await conn.removeOnLogsListener(id);
  }
}

cfg.leaders.forEach(watch);
// Positions opened from a leaderboard wallet in an earlier run still need their exit.
for (const p of Object.values(state.positions)) watch({ address: p.leader });

if (cfg.leaderboard) {
  // A failed refresh keeps the current set; the next one tries again.
  const refresh = () => refreshLeaderboard().catch((e) => log('leaderboard refresh failed:', e.message));
  await refresh();
  setInterval(refresh, cfg.leaderboard.refreshMinutes * 60_000);
}

log(`mode=${cfg.mode} watching ${watched.size} leader(s), ${Object.keys(state.positions).length} open position(s)`);
if (cfg.mode === 'live') log(`trading wallet ${cfg.keypair!.publicKey.toBase58()}`);
