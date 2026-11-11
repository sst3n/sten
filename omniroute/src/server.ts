// HTTP front end: an OpenAI-compatible endpoint that hands each request to the router.
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Attempt, Router } from './router.ts';

export interface GatewayOptions {
  /** When set, every request except /health must send it as a Bearer token. */
  token?: string;
  maxBodyBytes?: number;
  /** One line per request. Never includes prompts or keys. */
  log?: (line: string) => void;
}

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
const summary = (attempts: Attempt[]) => attempts.map((a) => `${a.target}: ${a.outcome}`).join('; ');

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const errorBody = (message: string, attempts?: Attempt[]) => ({ error: { message, type: 'omniroute_error', attempts } });

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createGateway(router: Router, opts: GatewayOptions = {}): Server {
  const log = opts.log ?? (() => {});
  const maxBody = opts.maxBodyBytes ?? 10 * 1024 * 1024;

  async function chat(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req, maxBody);
    if (raw === null) return json(res, 413, errorBody('request body too large'));
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8'));
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    } catch {
      return json(res, 400, errorBody('request body must be a JSON object'));
    }

    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    const started = Date.now();
    const routed = await router.route(body, gone.signal);
    const ms = Date.now() - started;
    const failed = summary(routed.attempts);

    if (routed.kind === 'unavailable') {
      const message = routed.status === 503 ? 'every provider is cooling down' : 'every provider failed';
      log(`chat ${routed.status} ${message} (${failed}) ${ms}ms`);
      return json(res, routed.status, errorBody(`${message}: ${failed}`, routed.attempts), {
        ...(routed.retryAfterSeconds ? { 'retry-after': String(routed.retryAfterSeconds) } : {}),
      });
    }

    log(`chat ${routed.status} via ${routed.target}${failed ? ` after ${failed}` : ''} ${ms}ms`);
    res.writeHead(routed.status, {
      'content-type': routed.contentType ?? 'application/json',
      'x-omniroute-target': routed.target,
      ...(failed ? { 'x-omniroute-failed': ascii(failed) } : {}),
    });
    if (routed.body instanceof Uint8Array) return void res.end(routed.body);

    const reader = routed.body.getReader();
    res.on('close', () => void reader.cancel().catch(() => {})); // client left: stop the upstream stream
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
      res.end();
    } catch {
      res.destroy(); // the stream broke after we started answering; it cannot be retried elsewhere
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if (opts.token && !authorized(req, opts.token)) return json(res, 401, errorBody('missing or wrong bearer token'));

    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) return chat(req, res);
    if (req.method === 'GET' && path === '/status') return json(res, 200, { targets: router.status() });
    if (req.method === 'POST' && path === '/reset') {
      router.reset();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const ids = new Set(['omni', ...router.targets.flatMap((t) => (t.model ? [t.model] : []))]);
      return json(res, 200, { object: 'list', data: [...ids].map((id) => ({ id, object: 'model', created: 0, owned_by: 'omniroute' })) });
    }
    return json(res, 404, errorBody(`no route for ${req.method} ${path}`));
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      log(`error: ${e.message}`);
      if (res.headersSent) res.destroy();
      else json(res, 500, errorBody('internal error'));
    });
  });
}
