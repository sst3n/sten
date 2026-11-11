import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { LeaderFeed, makeQueue } from '../src/feed.ts';
import { startPush } from '../src/push.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test('feed: fetches overlap, results come out in arrival order', async () => {
  const delays: Record<string, number> = { a: 120, b: 10, c: 60 };
  const out: string[] = [];
  const feed = new LeaderFeed<string>(
    async (sig) => {
      await sleep(delays[sig]);
      return sig.toUpperCase();
    },
    (item) => out.push(item),
    () => assert.fail('no errors expected'),
  );
  const start = Date.now();
  for (const s of ['a', 'b', 'c']) assert.equal(feed.ingest(s, 'push'), true);
  await waitFor(() => out.length === 3, 'three results');
  assert.deepEqual(out, ['A', 'B', 'C']); // b and c were ready first but wait for a
  assert.ok(Date.now() - start < 250, 'fetches ran one after another instead of in parallel');
});

test('feed: duplicates ignored, failures and non-trades do not block later signatures', async () => {
  const out: { item: string; via: string }[] = [];
  const errors: string[] = [];
  const feed = new LeaderFeed<string>(
    async (sig) => {
      if (sig === 'bad') throw new Error('rpc down');
      return sig === 'skip' ? null : sig;
    },
    (item, meta) => {
      assert.ok(meta.fetchedAt >= meta.seenAt);
      out.push({ item, via: meta.via });
    },
    (sig, e) => errors.push(`${sig}: ${e.message}`),
  );
  assert.equal(feed.ingest('one', 'push'), true);
  assert.equal(feed.ingest('one', 'poll'), false);
  feed.ingest('bad', 'poll');
  feed.ingest('skip', 'poll');
  feed.ingest('two', 'poll');
  await waitFor(() => out.length === 2, 'two results');
  assert.deepEqual(out, [
    { item: 'one', via: 'push' },
    { item: 'two', via: 'poll' },
  ]);
  assert.deepEqual(errors, ['bad: rpc down']);
});

test('queue: one task at a time, in order, and survives a failing task', async () => {
  const errors: string[] = [];
  const queue = makeQueue((e) => errors.push(e.message));
  const order: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const task = (name: string, ms: number, fail = false) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await sleep(ms);
    running--;
    order.push(name);
    if (fail) throw new Error(name);
  };
  queue(task('a', 40));
  queue(task('b', 5, true));
  queue(task('c', 5));
  await waitFor(() => order.length === 3, 'three tasks');
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(errors, ['b']);
});

test('push: subscribes, delivers signatures, drops failed txs, unsubscribes, and recovers from a disconnect', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

  const requests: any[] = [];
  let lastSocket!: ServerSocket;
  let nextSub = 100;
  wss.on('connection', (sock) => {
    lastSocket = sock;
    sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      requests.push(m);
      if (m.method === 'logsSubscribe') sock.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: nextSub++ }));
    });
  });
  const notify = (subscription: number, signature: string, err: unknown = null) =>
    lastSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: { subscription, result: { context: { slot: 1 }, value: { signature, err, logs: [] } } },
      }),
    );

  const got: string[] = [];
  let ready = 0;
  const downs: string[] = [];
  const push = startPush(url, (a, s) => got.push(`${a}:${s}`), { onReady: () => ready++, onDown: (w) => downs.push(w) }, 30);
  try {
    push.add('A');
    push.add('B');
    await waitFor(() => ready === 1, 'first ready');
    assert.equal(push.healthy(), true);
    const subs = requests.filter((r) => r.method === 'logsSubscribe');
    assert.deepEqual(subs.map((r) => r.params[0].mentions[0]).sort(), ['A', 'B']);
    assert.equal(subs[0].params[1].commitment, 'confirmed');
    const subOf = (address: string) => 100 + subs.findIndex((r) => r.params[0].mentions[0] === address);

    notify(subOf('A'), 'sig1');
    notify(subOf('B'), 'failed', { InstructionError: [0, 'x'] }); // failed transactions are ignored
    notify(subOf('B'), 'sig2');
    notify(555, 'unknown-subscription');
    await waitFor(() => got.length === 2, 'two signatures');
    await sleep(30);
    assert.deepEqual(got, ['A:sig1', 'B:sig2']);

    push.remove('A');
    await waitFor(() => requests.some((r) => r.method === 'logsUnsubscribe'), 'unsubscribe');
    assert.deepEqual(requests.find((r) => r.method === 'logsUnsubscribe').params, [subOf('A')]);
    push.add('C');
    await waitFor(() => push.healthy() && requests.filter((r) => r.method === 'logsSubscribe').length === 3, 'C subscribed');

    // Server drops the connection: reports down, reconnects, resubscribes to B and C only.
    requests.length = 0;
    lastSocket.terminate();
    await waitFor(() => downs.length >= 1, 'down report');
    await waitFor(() => ready === 2 && push.healthy(), 'ready again');
    assert.deepEqual(
      requests.filter((r) => r.method === 'logsSubscribe').map((r) => r.params[0].mentions[0]).sort(),
      ['B', 'C'],
    );
  } finally {
    push.close();
    wss.close();
  }
});
