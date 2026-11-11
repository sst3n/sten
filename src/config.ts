import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { LEADERBOARD_DEFAULTS, type LeaderboardConfig } from './leaderboard.ts';
import type { Limits } from './strategy.ts';

export interface Config extends Limits {
  mode: 'paper' | 'live';
  leaders: { address: string; label?: string }[];
  /** When set, top FOMO wallets from Bitquery are copied in addition to `leaders`. */
  leaderboard?: LeaderboardConfig;
  /** Pause between polling rounds over all leaders. */
  pollSeconds: number;
  slippageBps: number;
  priorityFeeLamports: number;
  jupiterBaseUrl: string;
  stateFile: string;
  // From the environment, never from the config file:
  rpcUrl: string;
  wsUrl?: string;
  jupiterApiKey?: string;
  bitqueryToken?: string;
  keypair?: Keypair;
}

const DEFAULTS = {
  mode: 'paper',
  buySol: 0.05,
  maxOpenPositions: 5,
  maxDailySol: 0.25,
  minLeaderBuySol: 0.5,
  minLeaderBuyUsd: 100,
  maxTradeAgeSec: 30,
  pollSeconds: 2,
  slippageBps: 300,
  priorityFeeLamports: 100_000,
  blockedMints: [],
  jupiterBaseUrl: 'https://lite-api.jup.ag/swap/v1',
  stateFile: 'state.json',
};

function parseKey(raw: string): Keypair {
  const bytes = raw.trim().startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim());
  return Keypair.fromSecretKey(bytes);
}

export function loadConfig(): Config {
  const path = process.env.CONFIG ?? 'config.json';
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path} (copy config.example.json to config.json): ${(e as Error).message}`);
  }
  const cfg = { ...DEFAULTS, ...file } as unknown as Config;

  if (cfg.mode !== 'paper' && cfg.mode !== 'live') throw new Error('mode must be "paper" or "live"');
  cfg.leaders ??= [];
  if (cfg.leaderboard) {
    cfg.leaderboard = { ...LEADERBOARD_DEFAULTS, ...cfg.leaderboard };
    if (!process.env.BITQUERY_TOKEN) throw new Error('config.leaderboard requires BITQUERY_TOKEN (see .env.example)');
    cfg.bitqueryToken = process.env.BITQUERY_TOKEN;
  } else if (cfg.leaders.length === 0) {
    throw new Error('nothing to copy: set config.leaders or config.leaderboard');
  }
  for (const l of cfg.leaders) {
    try {
      new PublicKey(l.address);
    } catch {
      throw new Error(`leader address is not a valid Solana public key: ${l.address}`);
    }
  }
  for (const k of ['buySol', 'maxOpenPositions', 'maxDailySol'] as const) {
    if (!(cfg[k] > 0)) throw new Error(`${k} must be a positive number`);
  }

  if (!process.env.RPC_URL) throw new Error('RPC_URL is not set (see .env.example)');
  cfg.rpcUrl = process.env.RPC_URL;
  cfg.wsUrl = process.env.WS_URL || undefined;
  cfg.jupiterApiKey = process.env.JUPITER_API_KEY || undefined;
  if (process.env.PRIVATE_KEY) cfg.keypair = parseKey(process.env.PRIVATE_KEY);
  if (cfg.mode === 'live' && !cfg.keypair) throw new Error('mode "live" requires PRIVATE_KEY');
  return cfg;
}
