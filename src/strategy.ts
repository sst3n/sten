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
}

export interface Position {
  leader: string;
  /** Raw token amount held, as a decimal string (bigint doesn't survive JSON). */
  tokens: string;
  costSol: number;
  openedAt: number;
}

export interface State {
  positions: Record<string, Position>;
  spentByDay: Record<string, number>;
  realizedPnlSol: number;
}

export const emptyState = (): State => ({ positions: {}, spentByDay: {}, realizedPnlSol: 0 });

export type Decision =
  | { type: 'buy'; mint: string; sol: number }
  | { type: 'sell'; mint: string; rawAmount: bigint; all: boolean }
  | { type: 'skip'; reason: string };

const day = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 10);
const skip = (reason: string): Decision => ({ type: 'skip', reason });

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
  if (trade.blockTime === null || nowSec - trade.blockTime > lim.maxTradeAgeSec) return skip('trade too old');
  const min = trade.quote === 'SOL' ? lim.minLeaderBuySol : lim.minLeaderBuyUsd;
  if (trade.quoteAmount < min) return skip(`leader buy too small (${trade.quoteAmount} ${trade.quote})`);
  if (pos) return skip('already holding this token');
  if (Object.keys(state.positions).length >= lim.maxOpenPositions) return skip('max open positions reached');
  const spent = state.spentByDay[day(nowSec)] ?? 0;
  if (spent + lim.buySol > lim.maxDailySol + 1e-9) return skip('daily spend cap reached');
  return { type: 'buy', mint: trade.mint, sol: lim.buySol };
}

export function applyBuy(state: State, mint: string, leader: string, tokensOut: bigint, sol: number, nowSec: number) {
  state.positions[mint] = { leader, tokens: tokensOut.toString(), costSol: sol, openedAt: nowSec };
  const d = day(nowSec);
  state.spentByDay = { [d]: (state.spentByDay[d] ?? 0) + sol }; // older days are no longer needed
}

export function applySell(state: State, mint: string, rawSold: bigint, proceedsSol: number) {
  const pos = state.positions[mint];
  const held = BigInt(pos.tokens);
  const costPart = held === 0n ? pos.costSol : (pos.costSol * Number(rawSold)) / Number(held);
  state.realizedPnlSol += proceedsSol - costPart;
  if (rawSold >= held) {
    delete state.positions[mint];
  } else {
    pos.tokens = (held - rawSold).toString();
    pos.costSol -= costPart;
  }
}
