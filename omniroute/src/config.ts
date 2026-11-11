import { readFileSync } from 'node:fs';
import { DEFAULT_OPTIONS, type Options, type Target } from './router.ts';

export interface Loaded {
  host: string;
  port: number;
  /** Clients must send this as a Bearer token when set. */
  token?: string;
  options: Options;
  targets: Target[];
  warnings: string[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS) as (keyof Options)[];

export function loadConfig(path: string, env: Record<string, string | undefined>): Loaded {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${path} (copy omniroute.config.example.json to it): ${(e as Error).message}`);
  }
  return parseConfig(raw, env);
}

export function parseConfig(raw: unknown, env: Record<string, string | undefined>): Loaded {
  const file = (raw ?? {}) as Record<string, any>;
  if (!Array.isArray(file.targets) || file.targets.length === 0) throw new Error('config.targets is empty');

  const host = String(file.host ?? '127.0.0.1');
  const token = env.OMNIROUTE_TOKEN || undefined;
  // The gateway spends your provider keys for whoever can reach it.
  if (!LOOPBACK.has(host) && !token) throw new Error(`host ${host} is reachable by others: set OMNIROUTE_TOKEN first`);

  const options = { ...DEFAULT_OPTIONS };
  for (const k of OPTION_KEYS) {
    if (file[k] === undefined) continue;
    if (!(Number(file[k]) > 0)) throw new Error(`${k} must be a positive number`);
    options[k] = Number(file[k]);
  }

  const warnings: string[] = [];
  const targets: Target[] = [];
  const names = new Set<string>();
  for (const t of file.targets) {
    const name = String(t?.name ?? '');
    if (!name) throw new Error('every target needs a name');
    if (names.has(name)) throw new Error(`duplicate target name: ${name}`);
    names.add(name);

    let url: URL;
    try {
      url = new URL(String(t.baseUrl));
    } catch {
      throw new Error(`target ${name}: baseUrl is not a valid URL`);
    }
    // A key sent over plain http to a remote host can be read by anyone on the path.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
      throw new Error(`target ${name}: plain http is only allowed for localhost`);
    }

    if (t.model === 'REPLACE_ME') {
      warnings.push(`skipped ${name}: set its "model"`);
      continue;
    }
    let apiKey: string | undefined;
    if (t.apiKeyEnv) {
      apiKey = env[String(t.apiKeyEnv)] || undefined;
      if (!apiKey) {
        warnings.push(`skipped ${name}: ${t.apiKeyEnv} is not set`);
        continue;
      }
    }
    targets.push({ name, baseUrl: String(t.baseUrl), apiKey, model: t.model ? String(t.model) : undefined, headers: t.headers });
  }
  if (targets.length === 0) throw new Error(`no usable targets. ${warnings.join('; ')}`);

  return { host, port: Number(file.port ?? 8789), token, options, targets, warnings };
}
