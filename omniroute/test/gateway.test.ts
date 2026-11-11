import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { Router, type Options, type Target } from '../src/router.ts';
import { createGateway } from '../src/server.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: any) => void;
interface Upstream {
  url: string;
  calls: { auth?: string; body: any }[];
  handler: Handler;
  close(): Promise<void>;
}

async function upstream(handler: Handler): Promise<Upstream> {
  const up = { calls: [] as Upstream['calls'], handler } as Upstream;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    up.calls.push({ auth: req.headers.authorization, body });
    up.handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  up.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  up.close = async () => {
    server.close();
    server.closeAllConnections();
  };
  return up;
}

const completion =
  (text: string): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
  };
const failWith =
  (status: number, headers: Record<string, string> = {}, message = 'nope'): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message } }));
  };

interface Spec {
  name: string;
  handler: Handler;
  model?: string;
}

async function rig(specs: Spec[], opts: Partial<Options> = {}, token?: string) {
  const ups = await Promise.all(specs.map((s) => upstream(s.handler)));
  let clock = 1_000_000;
  const targets: Target[] = specs.map((s, i) => ({
    name: s.name,
    baseUrl: `${ups[i].url}/v1`,
    apiKey: `key-${s.name}`,
    model: s.model ?? `${s.name}-model`,
  }));
  const server = createGateway(new Router(targets, opts, () => clock), { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ups,
    base,
    advance: (seconds: number) => (clock += seconds * 1000),
    chat: (body: object = { model: 'omni', messages: [{ role: 'user', content: 'hi' }] }, headers: Record<string, string> = {}) =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    status: async () => ((await (await fetch(`${base}/status`)).json()) as any).targets as any[],
    async close() {
      server.close();
      server.closeAllConnections();
      await Promise.all(ups.map((u) => u.close()));
    },
  };
}
const text = async (r: Response) => ((await r.json()) as any).choices[0].message.content as string;

test('rate limit: falls over to the next provider, rewrites the model, and skips the cooled one until it expires', async () => {
  let aMode: 'limited' | 'ok' = 'limited';
  const r = await rig([
    { name: 'a', handler: (q, s, b) => (aMode === 'limited' ? failWith(429, { 'retry-after': '30' })(q, s, b) : completion('from a')(q, s, b)) },
    { name: 'b', handler: completion('from b') },
  ]);
  try {
    const first = await r.chat();
    assert.equal(first.status, 200);
    assert.equal(await text(first), 'from b');
    assert.equal(first.headers.get('x-omniroute-target'), 'b');
    assert.match(first.headers.get('x-omniroute-failed')!, /a: HTTP 429 rate limited, cooling 30s/);

    const [a, b] = r.ups;
    assert.equal(a.calls[0].auth, 'Bearer key-a'); // each provider gets its own key
    assert.equal(b.calls[0].auth, 'Bearer key-b');
    assert.equal(b.calls[0].body.model, 'b-model'); // the client's model name is replaced
    assert.deepEqual(b.calls[0].body.messages, [{ role: 'user', content: 'hi' }]);

    await r.chat();
    assert.equal(a.calls.length, 1, 'a was asked again while cooling');
    assert.equal(b.calls.length, 2);
    const cooling = (await r.status())[0];
    assert.equal(cooling.state, 'cooling');
    assert.equal(cooling.cooldownSeconds, 30);

    r.advance(31);
    aMode = 'ok';
    assert.equal(await text(await r.chat()), 'from a'); // back to the preferred provider
    assert.equal((await r.status())[0].state, 'ready');
  } finally {
    await r.close();
  }
});

test('quota exhaustion cools a provider for an hour, key rejection too, and /reset clears it', async () => {
  const r = await rig([
    { name: 'quota', handler: failWith(429, {}, 'You exceeded your current quota, check your billing') },
    { name: 'badkey', handler: failWith(401, {}, 'invalid api key') },
    { name: 'ok', handler: completion('fine') },
  ]);
  try {
    const res = await r.chat();
    assert.equal(await text(res), 'fine');
    assert.match(res.headers.get('x-omniroute-failed')!, /quota: HTTP 429 out of quota/);
    assert.match(res.headers.get('x-omniroute-failed')!, /badkey: HTTP 401 key rejected/);
    const [quota, badkey] = await r.status();
    assert.equal(quota.cooldownSeconds, 3600);
    assert.equal(badkey.cooldownSeconds, 3600);

    await fetch(`${r.base}/reset`, { method: 'POST' });
    assert.deepEqual((await r.status()).map((t) => t.state), ['ready', 'ready', 'ready']);
  } finally {
    await r.close();
  }
});

test('a request the provider calls invalid is returned as is, not retried elsewhere', async () => {
  const r = await rig([
    { name: 'a', handler: failWith(400, {}, 'context too long') },
    { name: 'b', handler: completion('should not be reached') },
  ]);
  try {
    const res = await r.chat();
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error.message, 'context too long');
    assert.equal(r.ups[1].calls.length, 0);
    assert.equal((await r.status())[0].state, 'ready');
  } finally {
    await r.close();
  }
});

test('connection failure and timeout fall over; everything failing gives 502, then 503 with Retry-After', async () => {
  const dead = await upstream(completion('x'));
  const deadUrl = dead.url;
  await dead.close(); // nothing listens here any more

  const r = await rig([{ name: 'slow', handler: () => {} /* never answers */ }, { name: 'b', handler: failWith(500) }], { timeoutSeconds: 0.2 });
  try {
    const first = await r.chat();
    assert.equal(first.status, 502);
    const body: any = await first.json();
    assert.deepEqual(body.error.attempts.map((a: any) => a.target), ['slow', 'b']);
    assert.match(body.error.attempts[0].outcome, /timed out/);
    assert.match(body.error.attempts[1].outcome, /HTTP 500 upstream error/);

    const second = await r.chat();
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '15');
    assert.equal(r.ups[0].calls.length, 1, 'cooling providers must not be hit again');
  } finally {
    await r.close();
  }

  const router = new Router([{ name: 'gone', baseUrl: `${deadUrl}/v1` }, { name: 'up', baseUrl: `${deadUrl}/v1` }]);
  const routed = await router.route({ messages: [] });
  assert.equal(routed.kind, 'unavailable');
  assert.match(routed.attempts[0].outcome, /connection failed/);
});

test('streaming passes through, and a provider that fails before the stream starts is skipped', async () => {
  const sse: Handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => res.write('data: two\n\n'), 30);
    setTimeout(() => res.end('data: [DONE]\n\n'), 60);
  };
  const r = await rig([{ name: 'a', handler: failWith(503) }, { name: 'b', handler: sse }]);
  try {
    const res = await r.chat({ model: 'omni', stream: true, messages: [] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-omniroute-target'), 'b');
    assert.equal(await res.text(), 'data: one\n\ndata: two\n\ndata: [DONE]\n\n');
    assert.equal(r.ups[1].calls[0].body.stream, true);
  } finally {
    await r.close();
  }
});

test('token: required everywhere except /health; status and models never expose keys', async () => {
  const r = await rig([{ name: 'a', handler: completion('hi') }], {}, 'sekret');
  try {
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
    assert.equal((await r.chat()).status, 401);
    assert.equal((await r.chat({ messages: [] }, { authorization: 'Bearer wrong' })).status, 401);
    const ok = await r.chat({ messages: [] }, { authorization: 'Bearer sekret' });
    assert.equal(ok.status, 200);

    const headers = { authorization: 'Bearer sekret' };
    const status = await (await fetch(`${r.base}/status`, { headers })).text();
    const models: any = await (await fetch(`${r.base}/v1/models`, { headers })).json();
    assert.ok(!status.includes('key-a') && !status.includes('sekret'));
    assert.deepEqual(models.data.map((m: any) => m.id), ['omni', 'a-model']);
    assert.equal((await fetch(`${r.base}/nope`, { headers })).status, 404);
    assert.equal((await fetch(`${r.base}/v1/chat/completions`, { method: 'POST', headers, body: '[1]' })).status, 400);
  } finally {
    await r.close();
  }
});

test('config: skips unusable targets and refuses unsafe setups', () => {
  const t = (extra: object) => ({ name: 'a', baseUrl: 'https://x.example/v1', apiKeyEnv: 'KEY_A', model: 'm', ...extra });
  const ok = parseConfig(
    { targets: [t({}), t({ name: 'nokey', apiKeyEnv: 'MISSING' }), t({ name: 'todo', model: 'REPLACE_ME' }), { name: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama' }] },
    { KEY_A: 'secret' },
  );
  assert.deepEqual(ok.targets.map((x) => x.name), ['a', 'local']);
  assert.equal(ok.warnings.length, 2);
  assert.equal(ok.host, '127.0.0.1');
  assert.equal(ok.port, 8789);

  assert.throws(() => parseConfig({ targets: [t({ baseUrl: 'http://remote.example/v1' })] }, { KEY_A: 'k' }), /plain http/);
  assert.throws(() => parseConfig({ host: '0.0.0.0', targets: [t({})] }, { KEY_A: 'k' }), /OMNIROUTE_TOKEN/);
  assert.equal(parseConfig({ host: '0.0.0.0', targets: [t({})] }, { KEY_A: 'k', OMNIROUTE_TOKEN: 'tok' }).token, 'tok');
  assert.throws(() => parseConfig({ targets: [t({ apiKeyEnv: 'MISSING' })] }, {}), /no usable targets/);
  assert.throws(() => parseConfig({ targets: [t({}), t({})] }, { KEY_A: 'k' }), /duplicate/);
  assert.throws(() => parseConfig({ cooldownSeconds: -1, targets: [t({})] }, { KEY_A: 'k' }), /positive/);
  assert.throws(() => parseConfig({ targets: [] }, {}), /empty/);
});
