/**
 * 假 Gateway:PA 即時監控(R1,docs/API.md §3.2)。數字為假資料;MOCK_PA_LIVE=stopped|disabled|unavailable 可看各種停止狀態。
 * 串流每 2 秒送一批假 log、每 10 秒 snapshot、每 15 秒 heartbeat;5 分鐘後結束(同後端)。
 */
import type { ServerResponse } from 'node:http';
import type { MockCtx } from './types.ts';

const STATE = process.env.MOCK_PA_LIVE ?? 'ok';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const rnd = (a: number, b: number) => Math.round(a + Math.random() * (b - a));

function collector() {
  const stopped = STATE === 'stopped';
  const base = {
    state: STATE,
    message:
      { ok: '收集器運作中', stopped: '收集器停止更新:資料不是即時的', disabled: '收集器未啟用(輪詢與接收都關閉;測試區只在測試時開啟)', unavailable: '無法連線即時資料庫(Redis):資料停止更新' }[
        STATE
      ] ?? STATE,
    updatedAt: iso(stopped ? Date.now() - 5 * 60_000 : Date.now()),
    version: '0.1.0',
    poll: { enabled: STATE !== 'disabled', lastOkAt: iso(), error: null, errorAt: null },
    receive: { enabled: STATE !== 'disabled', tls: false, httpLastAt: iso(), syslogLastAt: iso() },
    redis: { error: null, errorAt: null },
    counters: { received: 123456, dropped: 0, rejected: 2, malformed: 1, redisFailed: 0 },
  };
  return base;
}

function snapshot() {
  const live = STATE === 'ok';
  return {
    collector: collector(),
    metrics: live
      ? {
          session: { time: iso(), active: rnd(3500, 4500), max: 262142, utilization: 1.5, tcp: 3100, udp: 800, icmp: 12 },
          cpu: { time: iso(), mgmt: rnd(5, 20), dataplane: rnd(2, 15), memUsed: 4.0e9, memTotal: 8.3e9 },
          throughput: { time: iso(), bps: rnd(60, 120) * 1e6, pps: rnd(8000, 15000), cps: rnd(30, 80) },
          interfaces: {
            time: iso(),
            items: ['ethernet1/1', 'ethernet1/2', 'ethernet1/3'].map((name) => ({ name, rxBps: rnd(1, 80) * 1e6, txBps: rnd(1, 40) * 1e6 })),
          },
        }
      : { session: null, cpu: null, throughput: null, interfaces: null },
  };
}

let seq = 0;
const IPS = ['10.10.1.15', '10.10.2.33', '10.10.130.66', '172.16.5.9', '8.8.8.8', '1.1.1.1', '142.250.66.78'];
const pick = <T>(xs: readonly T[]) => xs[rnd(0, xs.length - 1)]!;
function fakeLog(type: string, ms = Date.now()) {
  const id = `${ms}-${seq++}`;
  const base = { id, type, receivedAt: iso(ms), time: iso(ms), src: pick(IPS), dst: pick(IPS) };
  if (type === 'traffic')
    return { ...base, action: pick(['allow', 'allow', 'allow', 'deny', 'drop']), dport: pick([443, 80, 53, 3389]), proto: 'tcp', app: pick(['ssl', 'web-browsing', 'dns', 'ms-rdp']), rule: pick(['Internet', 'DC-Allow', 'Default-Deny']), bytes: rnd(200, 2e6) };
  if (type === 'globalprotect') return { ...base, status: pick(['success', 'failure']), user: pick(['S112009', 'S100001']), publicIp: pick(IPS), eventId: 'gateway-auth' };
  if (type === 'userid') return { ...base, subtype: 'login', ip: pick(IPS), user: pick(['gsmc\\s112009', 'gsmc\\s100001']) };
  return { ...base, action: pick(['alert', 'reset-both', 'block-url']), severity: pick(['informational', 'low', 'medium', 'high', 'critical']), name: pick(['SSH Brute Force', 'Suspicious DNS Query', 'Microsoft RDP Brute Force']), url: pick(['example.com/a', 'update.microsoft.com/x', '']) };
}

const minutes = (n: number) => Array.from({ length: n }, (_, i) => ({ minute: iso(Date.now() - (n - 1 - i) * 60_000), count: rnd(3000, 9000) }));

export function handlePaLive({ method, path, url, need, send, fail }: MockCtx): boolean {
  if (!path.startsWith('/api/netops/pa-live/') || method !== 'GET') return false;
  if (!need('netops.pa-realtime.read')) return true;
  const sub = path.slice('/api/netops/pa-live/'.length);
  if (sub === 'snapshot') return (send(200, snapshot()), true);
  if (STATE === 'unavailable') return (fail(503, 'NETOPS_REDIS_UNAVAILABLE', '無法讀取即時資料(Redis),請稍後再試;歷史資料請用 Log 明細查詢'), true);
  if (sub === 'series') {
    const m = Number(url.searchParams.get('minutes') ?? 60);
    const pts = STATE === 'ok' ? Array.from({ length: (m * 60) / 15 }, (_, i) => Date.now() - (m * 60 - i * 15) * 1000) : [];
    return (send(200, { metric: url.searchParams.get('metric'), minutes: m, points: pts.map((t) => ({ time: iso(t), mgmt: rnd(5, 20), dataplane: rnd(2, 15), active: rnd(3500, 4500), bps: rnd(60, 120) * 1e6 })) }), true);
  }
  if (sub === 'top') {
    const type = url.searchParams.get('type') ?? 'traffic';
    const m = Number(url.searchParams.get('minutes') ?? 15);
    const list = (xs: string[]) => xs.map((key) => ({ key, value: rnd(100, 9000) })).sort((a, b) => b.value - a.value);
    const tops =
      type === 'traffic'
        ? { src: list(IPS.slice(0, 4)), dst: list(IPS.slice(3)), app: list(['ssl', 'dns', 'web-browsing']), port: list(['tcp/443', 'udp/53', 'tcp/80']), srcBytes: list(IPS.slice(0, 3)).map((x) => ({ ...x, value: x.value * 1e5 })) }
        : { name: list(['SSH Brute Force', 'Suspicious DNS Query']), src: list(IPS.slice(0, 3)) };
    send(200, { type, minutes: m, totals: { count: rnd(1e4, 9e4), ...(type === 'traffic' ? { bytes: rnd(1e9, 9e9), packets: rnd(1e6, 9e6) } : {}) }, kpis: { action: { allow: 9000, deny: 300, drop: 40 } }, tops, perMinute: minutes(m), retentionSec: type === 'traffic' ? 86400 : 172800 });
    return true;
  }
  if (sub === 'logs') {
    const type = url.searchParams.get('type') ?? 'traffic';
    const items = STATE === 'ok' ? Array.from({ length: 30 }, (_, i) => fakeLog(type, Date.now() - (i + 1) * 3000)) : [];
    send(200, { type, items, nextBefore: null, scanned: items.length, truncated: false, earliest: iso(Date.now() - 55 * 60_000), retentionSec: type === 'traffic' ? 3600 : 172800 });
    return true;
  }
  return false;
}

/** SSE(在 gateway.ts 的延遲之前處理,直接寫回應) */
export function streamPaLive(url: URL, res: ServerResponse) {
  const types = (url.searchParams.get('types') ?? 'traffic,threat').split(',');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
  const ev = (event: string, data: unknown, id?: string) => res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 5000\n');
  ev('open', { types, filter: {}, heartbeatSec: 15, maxSec: 300, resumed: false });
  ev('snapshot', snapshot());
  const timers = [
    setInterval(() => {
      if (STATE !== 'ok') return;
      const items = types.flatMap((t) => Array.from({ length: rnd(0, t === 'traffic' ? 6 : 2) }, () => fakeLog(t)));
      if (items.length) ev('logs', { items, dropped: 0, skipped: [] }, types.map((t) => `${t}:${Date.now()}-0`).join(','));
    }, 2000),
    setInterval(() => ev('snapshot', snapshot()), 10_000),
    setInterval(() => ev('heartbeat', { time: iso() }), 15_000),
  ];
  const end = setTimeout(() => res.end(), 5 * 60_000);
  res.on('close', () => {
    timers.forEach(clearInterval);
    clearTimeout(end);
  });
}
