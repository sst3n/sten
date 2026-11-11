# fomo-copytrader

Copy-trades Solana wallets of top [FOMO](https://fomo.family) traders: when a
watched wallet buys a token, the bot buys a fixed SOL amount of it through
Jupiter; when that wallet sells, the bot sells the same fraction of its position.

**Paper mode is the default.** Nothing is signed or sent until you set
`"mode": "live"` and provide a private key.

## How it gets FOMO's trades

FOMO has no public API. Every FOMO user trades from their own on-chain wallet,
so the bot watches those wallets directly over a Solana RPC websocket and reads
each transaction's balance changes. It does not talk to FOMO at all.

You supply the wallets in `config.json` (`leaders`). Ways to find them:

| Route | Status |
| --- | --- |
| Take addresses of leaderboard traders from the app / explorers by hand | Works now, manual |
| Rank FOMO wallets yourself from chain data (Bitquery documents FOMO trade queries) | Not built: needs a Bitquery key |
| Third-party "fomo leaderboard" APIs (e.g. Traxer) | Not built: unverified vendor, paid |
| Call FOMO's private mobile API | Not built: undocumented, breaks without notice, likely against their terms |

## Setup

```sh
npm install
cp config.example.json config.json   # add leader wallets, set limits
cp .env.example .env                 # add RPC_URL (needs websockets)
npm start
```

Requires Node 22.18+.

## Config

| Key | Meaning |
| --- | --- |
| `mode` | `paper` (quotes only, simulated fills) or `live` |
| `leaders` | Wallets to copy: `{ "address", "label" }` |
| `buySol` | SOL spent per copied buy |
| `maxOpenPositions` | Stop opening positions beyond this many |
| `maxDailySol` | Cap on SOL spent on buys per UTC day |
| `minLeaderBuySol` / `minLeaderBuyUsd` | Ignore leader buys smaller than this |
| `maxTradeAgeSec` | Ignore buys seen later than this (sells are always followed) |
| `slippageBps`, `priorityFeeLamports` | Swap execution settings |
| `blockedMints` | Tokens never to buy |
| `jupiterBaseUrl` | Jupiter Swap API base; change if Jupiter moves it |

Positions and realized PnL are kept in `state.json`.

## Limits you should know

- Exits only happen when the leader sells. There is no stop-loss or take-profit.
- Trades made while the websocket is disconnected are missed, including sells.
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

The RPC and Jupiter paths have not been run against mainnet; run in paper mode
first and watch the log.
