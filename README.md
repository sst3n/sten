# fomo-copytrader

Copy-trades Solana wallets of top [FOMO](https://fomo.family) traders: when a
watched wallet buys a token, the bot buys a fixed SOL amount of it through
Jupiter; when that wallet sells, the bot sells the same fraction of its position.

**Paper mode is the default.** Nothing is signed or sent until you set
`"mode": "live"` and provide a private key.

## How it gets FOMO's trades

FOMO has no public API. Every FOMO user trades from their own on-chain wallet,
so the bot watches those wallets over Solana RPC and reads each new
transaction's balance changes. A websocket push feed tells it the moment a
leader transaction confirms; polling runs alongside as a safety net and takes
over by itself if the websocket is down. It does not talk to FOMO at all.

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
| `push` | Use the websocket push feed (`WS_URL`, or derived from `RPC_URL`). Default on |
| `backstopPollSeconds` | Seconds between polls of each leader while push is healthy |
| `pollSeconds` | Seconds between polls of each leader while push is off or down. One RPC call per leader per poll |
| `dashboardPort` | Serve a read-only status page on `http://127.0.0.1:<port>`. Off when unset |
| `maxRoundTripLossPct` | Skip a buy if selling straight back would lose more than this (thin liquidity). 0 disables |
| `maxPriceDriftPct` | Skip a buy if the price is this much above what the leader paid. 0 disables |
| `stopLossPct` | Sell a position once it is worth this much less than it cost. 0 disables |
| `maxHoldMinutes` | Sell a position held longer than this. 0 disables |
| `dropLeaderAfter` | Stop buying from a leader who is net negative for us after this many copied sells. 0 disables |
| `maxTradeAgeSec` | Ignore buys seen later than this (sells are always followed) |
| `slippageBps`, `priorityFeeLamports` | Swap execution settings |
| `blockedMints` | Tokens never to buy |
| `jupiterBaseUrl` | Jupiter Swap API base; change if Jupiter moves it |

Positions and realized PnL are kept in `state.json`.

## Limits you should know

- Exits happen when the leader sells, on the stop-loss, or at the hold limit.
  Positions are re-priced every 15 seconds, so a fast crash can overshoot the
  stop-loss. There is no take-profit.
- Trades made while the bot is stopped are not replayed. A websocket outage is
  covered by polling and a backfill poll when it returns.
- Every leader trade is logged with its detection lag, `[seen +1.2s via push]`:
  seconds from the leader's block to the bot seeing it. Block times are whole
  seconds, so a figure can read up to a second too high.
- Token safety is limited to the round-trip quote check. No checks for freeze
  or mint authority.
- Token-to-token swaps by a leader are ignored; only SOL/USDC/USDT pairs are copied.
- Solana only. FOMO also runs on other chains.
- You always fill after the leader, at a worse price. Leaders who know they are
  copied can exploit that. Most memecoin copy-trading loses money.

## Tests

```sh
npm test        # trade decoding and copy rules
npm run typecheck
```

Checked against mainnet: the push feed (8 leaders subscribed; trades seen
0.9 to 1.8 s after their block), leader polling, decoding of real FOMO trades
(the user's wallet co-signs each one), and Jupiter quotes in paper mode. Not yet run
against real services: the Bitquery leaderboard query and live swaps. Run in
paper mode first.
