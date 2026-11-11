// Minimal Jupiter Swap API client (quote + build swap transaction).
import type { Config } from './config.ts';

export interface Quote {
  inAmount: string;
  outAmount: string;
  [k: string]: unknown;
}

async function call(cfg: Config, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(cfg.jupiterBaseUrl + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cfg.jupiterApiKey ? { 'x-api-key': cfg.jupiterApiKey } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Jupiter ${path.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function getQuote(cfg: Config, inputMint: string, outputMint: string, rawAmount: bigint): Promise<Quote> {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: rawAmount.toString(),
    slippageBps: String(cfg.slippageBps),
  });
  return call(cfg, `/quote?${q}`);
}

/** Returns the unsigned swap transaction, base64-encoded. */
export async function buildSwap(cfg: Config, quote: Quote, userPublicKey: string): Promise<string> {
  const body = await call(cfg, '/swap', {
    method: 'POST',
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: cfg.priorityFeeLamports,
    }),
  });
  if (!body.swapTransaction) throw new Error(`Jupiter /swap returned no transaction: ${JSON.stringify(body)}`);
  return body.swapTransaction;
}
