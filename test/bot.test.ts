import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeTrade, WSOL, type TxLike } from '../src/decode.ts';
import { applyBuy, applySell, decide, emptyState, type Limits } from '../src/strategy.ts';

const LEADER = 'Leader1111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const MINT = 'Meme111111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const tb = (mint: string, owner: string, amount: string) => ({ mint, owner, uiTokenAmount: { amount, decimals: 6 } });

function tx(o: {
  keys?: string[];
  pre: number[];
  post: number[];
  preTok?: ReturnType<typeof tb>[];
  postTok?: ReturnType<typeof tb>[];
  err?: unknown;
  fee?: number;
}): TxLike {
  return {
    blockTime: 1000,
    meta: {
      err: o.err ?? null,
      fee: o.fee ?? 5000,
      preBalances: o.pre,
      postBalances: o.post,
      preTokenBalances: o.preTok ?? [],
      postTokenBalances: o.postTok ?? [],
    },
    transaction: { message: { accountKeys: (o.keys ?? [LEADER, OTHER]).map((pubkey) => ({ pubkey })) } },
  };
}

test('decodes a SOL buy and excludes the network fee', () => {
  const t = decodeTrade(
    tx({ pre: [2_000_000_000, 0], post: [999_995_000, 0], postTok: [tb(MINT, LEADER, '500')] }),
    LEADER,
  );
  assert.equal(t?.side, 'buy');
  assert.equal(t?.mint, MINT);
  assert.equal(t?.quote, 'SOL');
  assert.equal(t?.quoteAmount, 1);
  assert.equal(t?.tokenPost, 500n);
});

test('decodes a partial sell paid out in wrapped SOL when the leader is not fee payer', () => {
  const t = decodeTrade(
    tx({
      keys: [OTHER, LEADER],
      pre: [10, 10],
      post: [10, 10],
      preTok: [tb(MINT, LEADER, '1000'), tb(MINT, OTHER, '7')],
      postTok: [tb(MINT, LEADER, '750'), tb(WSOL, LEADER, '2000000000'), tb(MINT, OTHER, '7')],
    }),
    LEADER,
  );
  assert.deepEqual([t?.side, t?.quote, t?.quoteAmount, t?.tokenPre, t?.tokenPost], ['sell', 'SOL', 2, 1000n, 750n]);
});

test('decodes a USDC buy', () => {
  const t = decodeTrade(
    tx({
      pre: [1e9, 0],
      post: [1e9 - 5000, 0],
      preTok: [tb(USDC, LEADER, '250000000')],
      postTok: [tb(USDC, LEADER, '50000000'), tb(MINT, LEADER, '9')],
    }),
    LEADER,
  );
  assert.deepEqual([t?.side, t?.quote, t?.quoteAmount], ['buy', 'USD', 200]);
});

test('ignores transfers, failed transactions and token-to-token swaps', () => {
  // Received tokens, paid nothing.
  assert.equal(decodeTrade(tx({ pre: [1e9, 0], post: [1e9, 0], postTok: [tb(MINT, LEADER, '5')] }), LEADER), null);
  // Sent tokens away and paid rent for the recipient's account.
  assert.equal(
    decodeTrade(tx({ pre: [1e9, 0], post: [1e9 - 2_044_280, 0], preTok: [tb(MINT, LEADER, '5')] }), LEADER),
    null,
  );
  assert.equal(
    decodeTrade(tx({ pre: [2e9, 0], post: [1e9, 0], postTok: [tb(MINT, LEADER, '5')], err: { x: 1 } }), LEADER),
    null,
  );
  assert.equal(
    decodeTrade(
      tx({ pre: [1e9, 0], post: [1e9, 0], preTok: [tb(MINT, LEADER, '5')], postTok: [tb(OTHER, LEADER, '9')] }),
      LEADER,
    ),
    null,
  );
});

const LIM: Limits = {
  buySol: 0.1,
  maxOpenPositions: 2,
  maxDailySol: 0.2,
  minLeaderBuySol: 0.5,
  minLeaderBuyUsd: 100,
  maxTradeAgeSec: 30,
  blockedMints: ['Blocked'],
};
const buy = (mint = MINT, quoteAmount = 1, blockTime = 1000) =>
  ({ side: 'buy', mint, decimals: 6, tokenPre: 0n, tokenPost: 500n, quote: 'SOL', quoteAmount, blockTime }) as const;
const sell = (tokenPre: bigint, tokenPost: bigint) =>
  ({ side: 'sell', mint: MINT, decimals: 6, tokenPre, tokenPost, quote: 'SOL', quoteAmount: 1, blockTime: 1 }) as const;

test('buy rules', () => {
  const s = emptyState();
  assert.deepEqual(decide(buy(), LEADER, s, LIM, 1010), { type: 'buy', mint: MINT, sol: 0.1 });
  assert.equal(decide(buy(MINT, 1, 900), LEADER, s, LIM, 1010).type, 'skip'); // stale
  assert.equal(decide(buy(MINT, 0.1), LEADER, s, LIM, 1010).type, 'skip'); // leader size too small
  assert.equal(decide(buy('Blocked'), LEADER, s, LIM, 1010).type, 'skip');

  applyBuy(s, MINT, LEADER, 1000n, 0.1, 1010);
  assert.equal(decide(buy(), LEADER, s, LIM, 1010).type, 'skip'); // already holding
  assert.equal(decide(buy('B'), LEADER, s, LIM, 1010).type, 'buy');
  applyBuy(s, 'B', LEADER, 1000n, 0.1, 1010);
  const d = decide(buy('C'), LEADER, s, LIM, 1010);
  assert.equal(d.type, 'skip'); // max positions (and daily cap) reached
});

test('daily cap blocks buys even with free position slots, and resets the next day', () => {
  const s = emptyState();
  s.spentByDay = { '1970-01-01': 0.2 };
  assert.deepEqual(decide(buy(), LEADER, s, LIM, 1010), { type: 'skip', reason: 'daily spend cap reached' });
  assert.equal(decide(buy(MINT, 1, 86_400 + 1000), LEADER, s, LIM, 86_400 + 1010).type, 'buy');
});

test('sells mirror the leader fraction, only for the leader that opened the position', () => {
  const s = emptyState();
  assert.equal(decide(sell(1000n, 0n), LEADER, s, LIM, 5000).type, 'skip'); // no position
  applyBuy(s, MINT, LEADER, 800n, 0.1, 1010);

  assert.equal(decide(sell(1000n, 0n), OTHER, s, LIM, 5000).type, 'skip');
  // Old trades are still followed on the way out.
  assert.deepEqual(decide(sell(1000n, 750n), LEADER, s, LIM, 5000), {
    type: 'sell',
    mint: MINT,
    rawAmount: 200n,
    all: false,
  });
  applySell(s, MINT, 200n, 0.05);
  assert.equal(s.positions[MINT].tokens, '600');
  assert.ok(Math.abs(s.positions[MINT].costSol - 0.075) < 1e-12);
  assert.ok(Math.abs(s.realizedPnlSol - 0.025) < 1e-12);

  assert.deepEqual(decide(sell(750n, 0n), LEADER, s, LIM, 5000), { type: 'sell', mint: MINT, rawAmount: 600n, all: true });
  applySell(s, MINT, 600n, 0.05);
  assert.equal(s.positions[MINT], undefined);
  assert.ok(Math.abs(s.realizedPnlSol - 0) < 1e-12);
});
