// Failover core: send one chat request to the first healthy target. When a
// target is rate limited, out of quota, rejects our key, or is failing, put it
// on cooldown and try the next one. No HTTP server in here, so it can be
// tested against fake upstreams.

export interface Target {
  name: string;
  /** OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  /** Sent as a Bearer token. Empty for local servers that need none. */
  apiKey?: string;
  /** Model name sent upstream. When unset, the client's model is passed through. */
  model?: string;
  headers?: Record<string, string>;
}

export interface Options {
  /** Cooldown after a rate limit that gives no Retry-After. */
  cooldownSeconds: number;
  /** Cooldown after a quota or billing failure: usage limits do not clear in a minute. */
  quotaCooldownSeconds: number;
  /** Cooldown after a 5xx, timeout or connection failure. */
  errorCooldownSeconds: number;
  /** Cooldown after the provider rejects our key. */
  authCooldownSeconds: number;
  /** Seconds to wait for a provider's response (for a stream, until it starts). */
  timeoutSeconds: number;
}

export const DEFAULT_OPTIONS: Options = {
  cooldownSeconds: 60,
  quotaCooldownSeconds: 3600,
  errorCooldownSeconds: 15,
  authCooldownSeconds: 3600,
  timeoutSeconds: 60,
};

export interface Attempt {
  target: string;
  outcome: string;
}

export type Routed =
  | {
      kind: 'response';
      target: string;
      status: number;
      contentType: string | null;
      body: Uint8Array | ReadableStream<Uint8Array>;
      /** Targets that failed before this one answered. */
      attempts: Attempt[];
    }
  | { kind: 'unavailable'; status: 502 | 503; retryAfterSeconds?: number; attempts: Attempt[] };

interface State {
  until: number;
  ok: number;
  failed: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

type AttemptResult =
  | { fail: string }
  | { fail?: undefined; status: number; contentType: string | null; body: Uint8Array | ReadableStream<Uint8Array> };

// The request itself is wrong, so another provider will not fix it.
const PASSTHROUGH = new Set([400, 413, 422]);
const QUOTA_WORDS = /quota|billing|credit|insufficient|payment|exceeded your current/i;

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const n = Number(value);
  const seconds = Number.isFinite(n) ? n : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(Math.max(Math.ceil(seconds), 1), 86_400) : null;
}

export class Router {
  readonly targets: Target[];
  private readonly opts: Options;
  private readonly now: () => number;
  private readonly states = new Map<string, State>();

  constructor(targets: Target[], opts: Partial<Options> = {}, now: () => number = Date.now) {
    this.targets = targets;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.now = now;
    for (const t of targets) this.states.set(t.name, { until: 0, ok: 0, failed: 0, lastError: null, lastErrorAt: null });
  }

  private state(t: Target): State {
    return this.states.get(t.name)!;
  }

  /** Per-target health. Holds our own labels only, never upstream text or keys. */
  status() {
    const now = this.now();
    return this.targets.map((t) => {
      const s = this.state(t);
      const left = Math.max(0, Math.ceil((s.until - now) / 1000));
      return {
        name: t.name,
        model: t.model ?? null,
        state: left > 0 ? 'cooling' : 'ready',
        cooldownSeconds: left,
        ok: s.ok,
        failed: s.failed,
        lastError: s.lastError,
        lastErrorAt: s.lastErrorAt === null ? null : new Date(s.lastErrorAt).toISOString(),
      };
    });
  }

  /** Clears every cooldown, for when a guess about a limit was wrong. */
  reset() {
    for (const s of this.states.values()) s.until = 0;
  }

  async route(body: Record<string, unknown>, signal?: AbortSignal): Promise<Routed> {
    const now = this.now();
    const ready = this.targets.filter((t) => this.state(t).until <= now);
    if (ready.length === 0) {
      const soonest = Math.min(...this.targets.map((t) => this.state(t).until));
      return {
        kind: 'unavailable',
        status: 503,
        retryAfterSeconds: Math.max(1, Math.ceil((soonest - now) / 1000)),
        attempts: this.targets.map((t) => ({ target: t.name, outcome: 'cooling down' })),
      };
    }

    const attempts: Attempt[] = [];
    for (const target of ready) {
      if (signal?.aborted) break;
      const r = await this.attempt(target, body, signal);
      if (r.fail !== undefined) {
        attempts.push({ target: target.name, outcome: r.fail });
        continue;
      }
      return { kind: 'response', target: target.name, status: r.status, contentType: r.contentType, body: r.body, attempts };
    }
    return { kind: 'unavailable', status: 502, attempts };
  }

  private async attempt(t: Target, body: Record<string, unknown>, signal?: AbortSignal): Promise<AttemptResult> {
    const stream = body.stream === true;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutSeconds * 1000);
    try {
      let res: Response;
      try {
        res = await fetch(`${t.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}),
            ...t.headers,
          },
          body: JSON.stringify(t.model ? { ...body, model: t.model } : body),
          signal: ctl.signal,
        });
      } catch {
        if (signal?.aborted) return { fail: 'client disconnected' }; // not the provider's fault
        return this.fail(t, ctl.signal.aborted ? 'timed out' : 'connection failed', this.opts.errorCooldownSeconds);
      }

      const contentType = res.headers.get('content-type');
      if (res.ok && stream && res.body) {
        clearTimeout(timer); // a stream can run for minutes; only the wait for it to start is bounded
        this.state(t).ok++;
        return { status: res.status, contentType, body: res.body };
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        if (signal?.aborted) return { fail: 'client disconnected' };
        return this.fail(t, 'connection dropped mid-response', this.opts.errorCooldownSeconds);
      }
      if (res.ok) {
        this.state(t).ok++;
        return { status: res.status, contentType, body: bytes };
      }
      if (PASSTHROUGH.has(res.status)) return { status: res.status, contentType, body: bytes };

      const { seconds, why } = this.classify(res.status, res.headers.get('retry-after'), new TextDecoder().decode(bytes.subarray(0, 2000)));
      return this.fail(t, `HTTP ${res.status} ${why}`, seconds);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private classify(status: number, retryAfter: string | null, text: string): { seconds: number; why: string } {
    const quota = QUOTA_WORDS.test(text);
    if (status === 429 || status === 402 || ((status === 401 || status === 403) && quota)) {
      const asked = parseRetryAfter(retryAfter, this.now());
      if (asked !== null) return { seconds: asked, why: 'rate limited' };
      return quota || status === 402
        ? { seconds: this.opts.quotaCooldownSeconds, why: 'out of quota' }
        : { seconds: this.opts.cooldownSeconds, why: 'rate limited' };
    }
    if (status === 401 || status === 403) return { seconds: this.opts.authCooldownSeconds, why: 'key rejected' };
    return { seconds: this.opts.errorCooldownSeconds, why: 'upstream error' }; // 5xx, 404 (bad model or path), 408, ...
  }

  private fail(t: Target, label: string, seconds: number): { fail: string } {
    const s = this.state(t);
    s.failed++;
    s.lastError = label;
    s.lastErrorAt = this.now();
    s.until = Math.max(s.until, this.now() + seconds * 1000); // never shorten a cooldown already running
    return { fail: `${label}, cooling ${seconds}s` };
  }
}
