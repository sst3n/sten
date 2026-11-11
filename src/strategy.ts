// Pure copy-trading rules: given a leader's trade and our state, decide what to do.
import type { LeaderTrade } from './decode.ts';

export interface Limits {
  buySol: number;
  maxOpenPositions: number;
  maxDailySol: number;
  minLeaderBuySol: number;
  minLeaderBuyUsd: number;
  maxTradeAgeSec: number;
  blockedMints: string[];
  /** Skip a buy if selling straight back would lose more than this. 0 disables. */
  maxRoundTripLossPct: number;
  /** Skip a buy if our price is this much worse than the leader's fill. 0 disables. */
  maxPriceDriftPct: number;
  /** Sell a position once it is worth this much less than it cost. 0 disables. */
  stopLossPct: number;
  /** Sell a position held longer than this. 0 disables. */
  maxHoldMinutes: number;
  /** Stop buying from a leader who is net negative after this many copied sells. 0 disables. */
  dropLeaderAfter: number;
}

export interface Position {
  leader: string;
  /** Raw token amount held, as a decimal string (bigint doesn't survive JSON). */
  tokens: string;
  costSol: number;
  openedAt: number;
}

export interface ClosedTrade {
  time: number;
  mint: string;
  leader: string;
  proceedsSol: number;
  pnlSol: number;
  /** Why we sold: 'leader sold', 'stop-loss' or 'max hold'. */
  reason: string;
}

export interface State {
  positions: Record<string, Position>;
  spentByDay: Record<string, number>;
  realizedPnlSol: number;
  /** Sells, newest last, for the dashboard. */
  closed: ClosedTrade[];
  /** Our own results from copying each leader, by address. */
  leaderStats: Record<string, { sells: number; pnlSol: number }>;
}

export const emptyState = (): State => ({
  positions: {},
  spentByDay: {},
  realizedPnlSol: 0,
  closed: [],
  leaderStats: {},
});

export type Decision =
  | { type: 'buy'; mint: string; sol: number }
  | { type: 'sell'; mint: string; rawAmount: bigint; all: boolean }
  | { type: 'skip'; reason: string };

const day = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 10);
const skip = (reason: string): Decision => ({ type: 'skip', reason });

export function isDropped(state: State, leader: string, lim: Pick<Limits, 'dropLeaderAfter'>): boolean {
  const s = state.leaderStats[leader];
  return lim.dropLeaderAfter > 0 && !!s && s.sells >= lim.dropLeaderAfter && s.pnlSol < 0;
}

export function decide(trade: LeaderTrade, leader: string, state: State, lim: Limits, nowSec: number): Decision {
  const pos = state.positions[trade.mint];

  if (trade.side === 'sell') {
    // Always follow exits, however late: a late exit beats holding a dumped bag.
    if (!pos) return skip('no position in this token');
    if (pos.leader !== leader) return skip('position was opened from a different leader');
    const held = BigInt(pos.tokens);
    if (trade.tokenPost === 0n) return { type: 'sell', mint: trade.mint, rawAmount: held, all: true };
    const rawAmount = (held * (trade.tokenPre - trade.tokenPost)) / trade.tokenPre;
    if (rawAmount === 0n) return skip('sell fraction rounds to zero');
    return { type: 'sell', mint: trade.mint, rawAmount, all: false };
  }

  if (lim.blockedMints.includes(trade.mint)) return skip('mint is blocked');
  if (isDropped(state, leader, lim)) return skip('leader dropped: copying them has lost money');
  if (trade.blockTime === null || nowSec - trade.blockTime > lim.maxTradeAgeSec) return skip('trade too old');
  const min = trade.quote === 'SOL' ? lim.minLeaderBuySol : lim.minLeaderBuyUsd;
  if (trade.quoteAmount < min) return skip(`leader buy too small (${trade.quoteAmount} ${trade.quote})`);
  if (pos) return skip('already holding this token');
  if (Object.keys(state.positions).length >= lim.maxOpenPositions) return skip('max open positions reached');
  const spent = state.spentByDay[day(nowSec)] ?? 0;
  if (spent + lim.buySol > lim.maxDailySol + 1e-9) return skip('daily spend cap reached');
  return { type: 'buy', mint: trade.mint, sol: lim.buySol };
}

/**
 * Last check before a buy, using real quotes. Returns why to skip, or null.
 * `leaderSolPerToken` is null when the leader's price can't be compared.
 */
export function checkEntry(
  q: { buySol: number; tokensOut: bigint; sellBackSol: number; leaderSolPerToken: number | null },
  lim: Pick<Limits, 'maxRoundTripLossPct' | 'maxPriceDriftPct'>,
): string | null {
  if (q.tokensOut <= 0n) return 'quote returned no tokens';
  const roundTripLoss = (1 - q.sellBackSol / q.buySol) * 100;
  if (lim.maxRoundTripLossPct > 0 && roundTripLoss > lim.maxRoundTripLossPct) {
    return `round trip would lose ${roundTripLoss.toFixed(1)}% (thin liquidity)`;
  }
  if (lim.maxPriceDriftPct > 0 && q.leaderSolPerToken !== null && q.leaderSolPerToken > 0) {
    const drift = (q.buySol / Number(q.tokensOut) / q.leaderSolPerToken - 1) * 100;
    if (drift > lim.maxPriceDriftPct) return `price is ${drift.toFixed(1)}% above the leader's fill`;
  }
  return null;
}

/** Our own exit rules, checked against what the position would sell for now. */
export function exitReason(
  pos: Position,
  valueSol: number,
  nowSec: number,
  lim: Pick<Limits, 'stopLossPct' | 'maxHoldMinutes'>,
): string | null {
  if (lim.stopLossPct > 0 && valueSol <= pos.costSol * (1 - lim.stopLossPct / 100)) return 'stop-loss';
  if (lim.maxHoldMinutes > 0 && nowSec - pos.openedAt >= lim.maxHoldMinutes * 60) return 'max hold';
  return null;
}

export function applyBuy(state: State, mint: string, leader: string, tokensOut: bigint, sol: number, nowSec: number) {
  state.positions[mint] = { leader, tokens: tokensOut.toString(), costSol: sol, openedAt: nowSec };
  const d = day(nowSec);
  state.spentByDay = { [d]: (state.spentByDay[d] ?? 0) + sol }; // older days are no longer needed
}

export function applySell(
  state: State,
  mint: string,
  rawSold: bigint,
  proceedsSol: number,
  nowSec: number,
  reason: string,
) {
  const pos = state.positions[mint];
  const held = BigInt(pos.tokens);
  const costPart = held === 0n ? pos.costSol : (pos.costSol * Number(rawSold)) / Number(held);
  const pnlSol = proceedsSol - costPart;
  state.realizedPnlSol += pnlSol;

  const stats = (state.leaderStats[pos.leader] ??= { sells: 0, pnlSol: 0 });
  stats.sells += 1;
  stats.pnlSol += pnlSol;
  state.closed.push({ time: nowSec, mint, leader: pos.leader, proceedsSol, pnlSol, reason });
  if (state.closed.length > 200) state.closed.shift();

  if (rawSold >= held) {
    delete state.positions[mint];
  } else {
    pos.tokens = (held - rawSold).toString();
    pos.costSol -= costPart;
  }
}
