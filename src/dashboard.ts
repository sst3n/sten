// Read-only status page: mode, PnL, open positions, watched leaders, recent log.
import { createServer } from 'node:http';
import type { State } from './strategy.ts';

export interface DashboardData {
  mode: string;
  startedAt: number;
  buySol: number;
  maxDailySol: number;
  maxOpenPositions: number;
  state: State;
  /** Current sale value in SOL of each open position, by mint. */
  marks: Map<string, number>;
  leaders: { address: string; label?: string }[];
  lines: string[];
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const link = (kind: 'account' | 'token', a: string) =>
  `<a href="https://solscan.io/${kind}/${esc(a)}" target="_blank" rel="noreferrer">${esc(short(a))}</a>`;

export function render(d: DashboardData, now = Date.now()): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const spent = d.state.spentByDay[today] ?? 0;
  const pnl = d.state.realizedPnlSol;
  const positions = Object.entries(d.state.positions);
  const upMin = Math.floor((now - d.startedAt) / 60_000);
  const tile = (label: string, value: string, cls = '') =>
    `<div class="tile"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
  const cls = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  const sol = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
  const time = (sec: number) => esc(new Date(sec * 1000).toISOString().slice(11, 19));

  // Unrealized counts only positions that have a price yet.
  const unrealized = positions.reduce((sum, [mint, p]) => sum + (d.marks.has(mint) ? d.marks.get(mint)! - p.costSol : 0), 0);
  const closed = d.state.closed;
  const wins = closed.filter((c) => c.pnlSol > 0).length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>FOMO copytrader</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --fg:#16181d; --dim:#667085; --line:#e4e7ec; --up:#067647; --down:#b42318; --accent:#3538cd; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --fg:#eceef2; --dim:#98a2b3; --line:#2a2f38; --up:#47cd89; --down:#f97066; --accent:#a4bcfd; } }
* { box-sizing:border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui,sans-serif; }
main { max-width:960px; margin:0 auto; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:14px; margin:24px 0 8px; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }
.sub { color:var(--dim); font-size:13px; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; vertical-align:middle; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-top:16px; }
.tile, .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.label { color:var(--dim); font-size:12px; } .value { font-size:20px; font-weight:600; font-variant-numeric:tabular-nums; }
.up { color:var(--up); } .down { color:var(--down); }
.card { overflow-x:auto; padding:0; } table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:8px 14px; border-bottom:1px solid var(--line); white-space:nowrap; font-variant-numeric:tabular-nums; }
th { color:var(--dim); font-size:12px; font-weight:500; } tr:last-child td { border-bottom:0; }
a { color:var(--accent); text-decoration:none; } .empty { padding:14px; color:var(--dim); }
pre { margin:0; padding:12px 14px; font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; word-break:break-all; max-height:420px; overflow-y:auto; }
</style></head><body><main>
<h1>FOMO copytrader <span class="badge">${esc(d.mode)}</span></h1>
<div class="sub">Up ${upMin} min · refreshes every 5 s · ${esc(new Date(now).toISOString().slice(11, 19))} UTC</div>
<div class="tiles">
${tile('Total PnL', sol(pnl + unrealized), cls(pnl + unrealized))}
${tile('Realized', sol(pnl), cls(pnl))}
${tile('Unrealized', sol(unrealized), cls(unrealized))}
${tile('Winning sells', closed.length ? `${wins} / ${closed.length}` : '–')}
${tile('Open positions', `${positions.length} / ${d.maxOpenPositions}`)}
${tile('Spent today', `${spent.toFixed(2)} / ${d.maxDailySol} SOL`)}
</div>
<h2>Open positions</h2>
<div class="card">${
    positions.length === 0
      ? '<div class="empty">None</div>'
      : `<table><tr><th>Token</th><th>Cost</th><th>Value now</th><th>PnL</th><th>Copied from</th><th>Opened (UTC)</th></tr>${positions
          .map(([mint, p]) => {
            const v = d.marks.get(mint);
            const u = v === undefined ? null : v - p.costSol;
            return `<tr><td>${link('token', mint)}</td><td>${p.costSol.toFixed(4)} SOL</td><td>${v === undefined ? '…' : `${v.toFixed(4)} SOL`}</td><td class="${u === null ? '' : cls(u)}">${u === null ? '…' : `${sol(u)} (${((u / p.costSol) * 100).toFixed(1)}%)`}</td><td>${link('account', p.leader)}</td><td>${time(p.openedAt)}</td></tr>`;
          })
          .join('')}</table>`
  }</div>
<h2>Closed trades</h2>
<div class="card">${
    closed.length === 0
      ? '<div class="empty">None yet</div>'
      : `<table><tr><th>Sold (UTC)</th><th>Token</th><th>Proceeds</th><th>PnL</th><th>Copied from</th></tr>${[...closed]
          .reverse()
          .slice(0, 50)
          .map(
            (c) =>
              `<tr><td>${time(c.time)}</td><td>${link('token', c.mint)}</td><td>${c.proceedsSol.toFixed(4)} SOL</td><td class="${cls(c.pnlSol)}">${sol(c.pnlSol)}</td><td>${link('account', c.leader)}</td></tr>`,
          )
          .join('')}</table>`
  }</div>
<h2>Leaders</h2>
<div class="card">${
    d.leaders.length === 0
      ? '<div class="empty">None yet</div>'
      : `<table><tr><th>Label</th><th>Wallet</th></tr>${d.leaders
          .map((l) => `<tr><td>${esc(l.label ?? '')}</td><td>${link('account', l.address)}</td></tr>`)
          .join('')}</table>`
  }</div>
<h2>Activity</h2>
<div class="card"><pre>${d.lines.length ? esc([...d.lines].reverse().join('\n')) : 'Nothing yet'}</pre></div>
</main></body></html>`;
}

export function startDashboard(port: number, host: string, getData: () => DashboardData) {
  createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(render(getData()));
  }).listen(port, host);
}
