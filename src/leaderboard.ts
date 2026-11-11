// Builds a "top FOMO traders" list from on-chain data via Bitquery.
//
// FOMO has no API and its in-app leaderboard is not on-chain, so this is our
// own ranking, not FOMO's. Bitquery identifies FOMO trades by the wallet that
// signs every one of them, and reads the user's wallet from the DFlow trade
// row. Its Solana DEX data only reaches back about 12 hours.
// https://docs.bitquery.io/docs/blockchain/Solana/fomo-api/

export interface LeaderboardConfig {
  /** How many wallets to copy. */
  top: number;
  /** Look-back window; Bitquery keeps about 12 hours. */
  hours: number;
  /** How many high-volume wallets to pull before ranking them by profit. */
  candidates: number;
  /** Minimum tokens bought and sold within the window to qualify. */
  minRoundTrips: number;
  /** Minimum realized profit in USD to qualify. */
  minProfitUsd: number;
  refreshMinutes: number;
  /** FOMO's transaction signer. Identified by Bitquery, not confirmed by FOMO. */
  signer: string;
  url: string;
}

export const LEADERBOARD_DEFAULTS: LeaderboardConfig = {
  top: 5,
  hours: 12,
  candidates: 200,
  minRoundTrips: 3,
  minProfitUsd: 100,
  refreshMinutes: 60,
  signer: 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51',
  url: 'https://streaming.bitquery.io/graphql',
};

const QUOTES = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // wrapped SOL
];

const WHERE = (extra = '') => `where: {
  Transaction: {Signer: {is: $signer}},
  Trade: {Dex: {ProtocolName: {is: "dflow"}}, Currency: {MintAddress: {notIn: $quotes}}${extra}},
  Block: {Time: {since_relative: {hours_ago: $hours}}}
}`;
const SELL = '{Trade: {Side: {Type: {is: sell}}}}';
const BUY = '{Trade: {Side: {Type: {is: buy}}}}';

// Step 1: wallets that sold the most. Selling is what realizes profit, and
// this keeps step 2 small enough to fetch.
const CANDIDATES_QUERY = `query ($signer: String, $quotes: [String!], $hours: Int, $n: Int) {
  Solana {
    DEXTradeByTokens(limit: {count: $n}, orderBy: {descendingByField: "sold"}, ${WHERE()}) {
      Trade { Account { Owner } }
      sold: sum(of: Trade_Side_AmountInUSD, if: ${SELL})
    }
  }
}`;

// Step 2: per-token totals for those wallets.
const ROWS_QUERY = `query ($signer: String, $quotes: [String!], $hours: Int, $wallets: [String!]) {
  Solana {
    DEXTradeByTokens(limit: {count: 20000}, ${WHERE(', Account: {Owner: {in: $wallets}}')}) {
      Trade { Account { Owner } Currency { MintAddress } }
      soldUsd: sum(of: Trade_Side_AmountInUSD, if: ${SELL})
      boughtUsd: sum(of: Trade_Side_AmountInUSD, if: ${BUY})
      soldAmt: sum(of: Trade_Amount, if: ${SELL})
      boughtAmt: sum(of: Trade_Amount, if: ${BUY})
    }
  }
}`;

export interface TokenRow {
  wallet: string;
  mint: string;
  boughtUsd: number;
  soldUsd: number;
  boughtAmt: number;
  soldAmt: number;
}

export interface RankedWallet {
  address: string;
  profitUsd: number;
  roundTrips: number;
}

/**
 * Ranks wallets by profit realized on tokens they both bought and sold inside
 * the window. Only the matched quantity counts: selling a bag bought before
 * the window, or still holding one, contributes nothing either way.
 */
export function rankWallets(
  rows: TokenRow[],
  opts: Pick<LeaderboardConfig, 'top' | 'minRoundTrips' | 'minProfitUsd'>,
): RankedWallet[] {
  const byWallet = new Map<string, RankedWallet>();
  for (const r of rows) {
    if (!r.wallet || !(r.boughtAmt > 0) || !(r.soldAmt > 0)) continue;
    const matched = Math.min(r.boughtAmt, r.soldAmt);
    const profit = (r.soldUsd * matched) / r.soldAmt - (r.boughtUsd * matched) / r.boughtAmt;
    if (!Number.isFinite(profit)) continue;
    const w = byWallet.get(r.wallet) ?? { address: r.wallet, profitUsd: 0, roundTrips: 0 };
    w.profitUsd += profit;
    w.roundTrips += 1;
    byWallet.set(r.wallet, w);
  }
  return [...byWallet.values()]
    .filter((w) => w.roundTrips >= opts.minRoundTrips && w.profitUsd >= opts.minProfitUsd)
    .sort((a, b) => b.profitUsd - a.profitUsd)
    .slice(0, opts.top);
}

async function gql(cfg: LeaderboardConfig, token: string, query: string, variables: object): Promise<any[]> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Bitquery ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Bitquery: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data?.Solana?.DEXTradeByTokens ?? [];
}

export async function fetchLeaderboard(cfg: LeaderboardConfig, token: string): Promise<RankedWallet[]> {
  const base = { signer: cfg.signer, quotes: QUOTES, hours: cfg.hours };
  const candidates = await gql(cfg, token, CANDIDATES_QUERY, { ...base, n: cfg.candidates });
  const wallets = candidates.map((c) => c.Trade?.Account?.Owner).filter(Boolean);
  if (wallets.length === 0) {
    // Zero FOMO trades in hours means the signer address has most likely changed.
    throw new Error(`no FOMO trades found for signer ${cfg.signer}; it may have moved to a new address`);
  }
  const rows = await gql(cfg, token, ROWS_QUERY, { ...base, wallets });
  return rankWallets(
    rows.map((r) => ({
      wallet: r.Trade?.Account?.Owner,
      mint: r.Trade?.Currency?.MintAddress,
      boughtUsd: Number(r.boughtUsd),
      soldUsd: Number(r.soldUsd),
      boughtAmt: Number(r.boughtAmt),
      soldAmt: Number(r.soldAmt),
    })),
    cfg,
  );
}
