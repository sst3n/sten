# fomo-copytrader

Copy-trades Solana wallets of top [FOMO](https://fomo.family) traders: when a
watched wallet buys a token, the bot buys a fixed SOL amount of it through
Jupiter; when that wallet sells, the bot sells the same fraction of its position.

**Paper mode is the default.** Nothing is signed or sent until you set
`"mode": "live"` and provide a private key.

## How it gets FOMO's trades

FOMO has no public API. Every FOMO user trades from their own on-chain wallet,
so the bot polls those wallets over Solana RPC every few seconds and reads each
new transaction's balance changes. It does not talk to FOMO at all.

Two ways to choose who to copy; they can be combined:

- **`leaderboard`** (automatic): ranks FOMO wallets from chain data through
  [Bitquery](https://docs.bitquery.io/docs/blockchain/Solana/fomo-api/) and
  copies the top ones, refreshing on a schedule. Needs `BITQUERY_TOKEN`.
- **`leaders`** (manual): wallet addresses you list yourself.

### What the leaderboard is, and is not

It is this bot's own ranking, **not FOMO's in-app leaderboard**: FOMO profiles
are not on-chain, so usernames cannot be linked to wallets.

- Wallets are ranked by profit realized on tokens they both bought and sold
  within the window. Bags still held, or bought before the window, do not count.
- Bitquery's data reaches back about 12 hours, so this finds who was hot today,
  not who is consistently good. A lucky wallet looks the same as a skilled one.
- FOMO trades are recognised by the wallet that signs all of them
  (`leaderboard.signer`). Bitquery inferred that address; FOMO has not confirmed
  it. If FOMO changes it the refresh fails with a clear error and the bot keeps
  its current list.
- A wallet that drops off the board stays watched until positions copied from
  it are closed.

## Setup

```sh
npm install
cp config.example.json config.json   # add leader wallets, set limits
cp .env.example .env                 # add RPC_URL, BITQUERY_TOKEN
npm start
```

Requires Node 22.18+.

## Config

| Key | Meaning |
| --- | --- |
| `mode` | `paper` (quotes only, simulated fills) or `live` |
| `leaders` | Wallets to copy: `{ "address", "label" }` |
| `leaderboard.top` | How many ranked wallets to copy |
| `leaderboard.hours` | Look-back window, at most about 12 |
| `leaderboard.minRoundTrips` | Tokens bought and sold in the window needed to qualify |
| `leaderboard.minProfitUsd` | Realized profit needed to qualify |
| `leaderboard.refreshMinutes` | How often the list is rebuilt |
| `buySol` | SOL spent per copied buy |
| `maxOpenPositions` | Stop opening positions beyond this many |
| `maxDailySol` | Cap on SOL spent on buys per UTC day |
| `minLeaderBuySol` / `minLeaderBuyUsd` | Ignore leader buys smaller than this. FOMO users mostly pay in USDC, so the USD one usually applies |
| `pollSeconds` | Pause between polling rounds. Each round costs one RPC call per leader |
| `maxTradeAgeSec` | Ignore buys seen later than this (sells are always followed) |
| `slippageBps`, `priorityFeeLamports` | Swap execution settings |
| `blockedMints` | Tokens never to buy |
| `jupiterBaseUrl` | Jupiter Swap API base; change if Jupiter moves it |

Positions and realized PnL are kept in `state.json`.

## Limits you should know

- Exits only happen when the leader sells. There is no stop-loss or take-profit.
- A leader trade is seen up to one polling round late. Trades made while the bot
  is stopped are not replayed.
- No token safety checks (honeypots, freeze authority, liquidity).
- Token-to-token swaps by a leader are ignored; only SOL/USDC/USDT pairs are copied.
- Solana only. FOMO also runs on other chains.
- You always fill after the leader, at a worse price. Leaders who know they are
  copied can exploit that. Most memecoin copy-trading loses money.

## Tests

```sh
npm test        # trade decoding and copy rules
npm run typecheck
```

Checked against mainnet: leader polling, decoding of real FOMO trades (the
user's wallet co-signs each one), and Jupiter quotes in paper mode. Not yet run
against real services: the Bitquery leaderboard query and live swaps. Run in
paper mode first.
