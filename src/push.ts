// Websocket push of leader transactions (Solana logsSubscribe, "confirmed").
//
// The RPC tells us the moment a transaction mentioning a leader confirms,
// instead of us asking every few seconds. That removes the polling delay and
// most of the request volume. It reconnects by itself; while it is down the
// caller falls back to polling, and on return a backfill poll covers the gap.
import WebSocket from 'ws';

export interface Push {
  /** True while the socket is open and every wanted address is subscribed. */
  healthy(): boolean;
  add(address: string): void;
  remove(address: string): void;
  close(): void;
}

export interface PushHooks {
  /** Socket open and every wanted address subscribed. Fires once per connection. */
  onReady?: () => void;
  /** Connection failed, closed, or a subscription was refused. Reconnects by itself. */
  onDown?: (why: string) => void;
}

const HEARTBEAT_MS = 20_000;
const SILENCE_LIMIT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export function startPush(
  url: string,
  onSignature: (address: string, signature: string) => void,
  hooks: PushHooks = {},
  reconnectMs = 1000,
  options: WebSocket.ClientOptions = {},
): Push {
  const wanted = new Set<string>();
  const subByAddress = new Map<string, number>();
  const addressBySub = new Map<number, string>();
  const pending = new Map<number, string>(); // request id -> address awaiting a subscription id
  let ws: WebSocket | null = null;
  let isOpen = false;
  let stopped = false;
  let announced = false;
  let delay = reconnectMs;
  let nextId = 1;
  let lastHeard = 0;
  let retry: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const send = (msg: object) => ws?.send(JSON.stringify(msg));
  const healthy = () => isOpen && [...wanted].every((a) => subByAddress.has(a));
  const announce = () => {
    if (announced || !healthy()) return;
    announced = true;
    hooks.onReady?.();
  };

  const subscribe = (address: string) => {
    const id = nextId++;
    pending.set(id, address);
    send({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'confirmed' }] });
  };
  const unsubscribe = (subscription: number) =>
    send({ jsonrpc: '2.0', id: nextId++, method: 'logsUnsubscribe', params: [subscription] });

  const onMessage = (raw: string) => {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const address = pending.get(m.id)!;
      pending.delete(m.id);
      if (typeof m.result !== 'number') return void hooks.onDown?.(`subscribe refused: ${JSON.stringify(m.error ?? m)}`);
      if (!wanted.has(address)) return unsubscribe(m.result); // removed while the request was in flight
      subByAddress.set(address, m.result);
      addressBySub.set(m.result, address);
      announce();
      return;
    }
    if (m.method === 'logsNotification') {
      const address = addressBySub.get(m.params?.subscription);
      const value = m.params?.result?.value;
      if (address && value && !value.err && typeof value.signature === 'string') onSignature(address, value.signature);
    }
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(url, options);
    ws = sock;
    let failure = '';
    sock.on('open', () => {
      isOpen = true;
      announced = false;
      delay = reconnectMs;
      lastHeard = Date.now();
      for (const a of wanted) subscribe(a);
      announce(); // nothing to subscribe yet
      heartbeat = setInterval(() => {
        if (Date.now() - lastHeard > SILENCE_LIMIT_MS) return sock.terminate();
        sock.ping();
      }, HEARTBEAT_MS);
    });
    sock.on('pong', () => (lastHeard = Date.now()));
    sock.on('message', (data) => {
      lastHeard = Date.now();
      onMessage(data.toString());
    });
    sock.on('error', (e) => (failure = e.message)); // 'close' always follows
    sock.on('close', () => {
      isOpen = false;
      clearInterval(heartbeat);
      pending.clear();
      subByAddress.clear();
      addressBySub.clear();
      if (ws === sock) ws = null;
      hooks.onDown?.(failure || 'closed');
      if (stopped) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    });
  };
  connect();

  return {
    healthy,
    add(address) {
      if (wanted.has(address)) return;
      wanted.add(address);
      if (isOpen) subscribe(address);
    },
    remove(address) {
      wanted.delete(address);
      const sub = subByAddress.get(address);
      if (sub === undefined) return;
      subByAddress.delete(address);
      addressBySub.delete(sub);
      if (isOpen) unsubscribe(sub);
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      ws?.close();
    },
  };
}
