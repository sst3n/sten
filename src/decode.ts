// Turns a confirmed Solana transaction into "wallet X bought/sold token Y",
// using only balance deltas. That keeps it independent of which DEX or router
// (FOMO's, Jupiter, pump.fun...) the leader's app used.

export const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Below these the quote-side movement is rent/fees noise, not a swap.
const SOL_DUST = 3_000_000n; // lamports (~ one token account's rent)
const USD_DUST = 10_000n; // 0.01 at 6 decimals

interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface TxLike {
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
  transaction: { message: { accountKeys: { pubkey: unknown }[] } };
}

export interface LeaderTrade {
  side: 'buy' | 'sell';
  mint: string;
  decimals: number;
  /** Leader's raw balance of `mint` before and after the trade. */
  tokenPre: bigint;
  tokenPost: bigint;
  quote: 'SOL' | 'USD';
  /** Human units of SOL or USD spent (buy) or received (sell). */
  quoteAmount: number;
  blockTime: number | null;
}

export function decodeTrade(tx: TxLike, wallet: string): LeaderTrade | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const keys = tx.transaction.message.accountKeys.map((k) => String(k.pubkey));
  const idx = keys.indexOf(wallet);
  let sol = 0n;
  if (idx >= 0) {
    sol = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
    if (idx === 0) sol += BigInt(meta.fee); // fee payer: don't count the fee as spend
  }

  const tokens = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  const add = (list: TokenBalance[] | null | undefined, field: 'pre' | 'post') => {
    for (const b of list ?? []) {
      if (b.owner !== wallet) continue;
      const t = tokens.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
      t[field] += BigInt(b.uiTokenAmount.amount);
      tokens.set(b.mint, t);
    }
  };
  add(meta.preTokenBalances, 'pre');
  add(meta.postTokenBalances, 'post');

  let usd = 0n;
  const moved: { mint: string; pre: bigint; post: bigint; decimals: number }[] = [];
  for (const [mint, t] of tokens) {
    const delta = t.post - t.pre;
    if (delta === 0n) continue;
    if (mint === WSOL) sol += delta;
    else if (STABLES.has(mint)) usd += delta;
    else moved.push({ mint, ...t });
  }
  // Exactly one non-quote token must move; token-to-token swaps are not copied.
  if (moved.length !== 1) return null;
  const t = moved[0];
  const bought = t.post > t.pre;

  // Buy: quote must go out. Sell: quote must come in. Otherwise it's a transfer.
  const dir = bought ? -1n : 1n;
  let quote: 'SOL' | 'USD';
  let quoteAmount: number;
  if (sol * dir > SOL_DUST) {
    quote = 'SOL';
    quoteAmount = Number(sol * dir) / 1e9;
  } else if (usd * dir > USD_DUST) {
    quote = 'USD';
    quoteAmount = Number(usd * dir) / 1e6;
  } else {
    return null;
  }

  return {
    side: bought ? 'buy' : 'sell',
    mint: t.mint,
    decimals: t.decimals,
    tokenPre: t.pre,
    tokenPost: t.post,
    quote,
    quoteAmount,
    blockTime: tx.blockTime ?? null,
  };
}
