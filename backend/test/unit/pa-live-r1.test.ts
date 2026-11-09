/**
 * PA 即時監控 API(R1,docs/API.md §3.2):假 Redis(test/fixtures/fake-redis.ts)模擬 netops-pa 寫入的資料。
 *   - 收集器狀態:運作中 / 未啟用 / 停止更新 / 沒有心跳 / Redis 連不上(AGENT.md §5:不把舊資料當即時)
 *   - 快照、趨勢、排行、最新 log 與篩選、503
 *   - SSE:open → snapshot → logs(游標)、Last-Event-ID 接續、連線數上限、最長時間
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPaLiveRedis, minuteBucket } from '../../src/infra/redis/index.js';
import { deriveStatus, matchLog, summarizeError } from '../../src/modules/pa-live/service.js';
import { parseCursor } from '../../src/modules/pa-live/live-routes.js';
import { FakeRedis } from '../fixtures/fake-redis.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hbOk = (over: Record<string, string> = {}) => ({
  version: '0.1.0',
  updatedAt: iso(Date.now()),
  pollEnabled: '1',
  receiveEnabled: '1',
  pollOkAt: iso(Date.now()),
  received: '10',
  dropped: '0',
  ...over,
});

describe('收集器狀態(純函式)', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  it('心跳 30 秒內為 ok;超過為 stopped;沒有心跳為 not-running', () => {
    assert.equal(deriveStatus({ updatedAt: '2026-11-05T09:59:40Z', pollEnabled: '1' }, now).state, 'ok');
    assert.equal(deriveStatus({ updatedAt: '2026-11-05T09:59:20Z', pollEnabled: '1' }, now).state, 'stopped');
    assert.equal(deriveStatus(null, now).state, 'not-running');
    assert.equal(deriveStatus({ updatedAt: 'garbage', pollEnabled: '1' }, now).state, 'stopped');
  });
  it('兩個開關都關為 disabled;輪詢錯誤或 Redis 錯誤為 degraded', () => {
    assert.equal(deriveStatus({ updatedAt: '2026-11-05T10:00:00Z', pollEnabled: '0', receiveEnabled: '0' }, now).state, 'disabled');
    const d = deriveStatus({ updatedAt: '2026-11-05T10:00:00Z', pollEnabled: '1', pollError: 'session: Invalid Credential' }, now);
    assert.equal(d.state, 'degraded');
    assert.equal(d.poll.error, 'session:API Key 無效或權限不足');
    assert.equal(deriveStatus({ updatedAt: '2026-11-05T10:00:00Z', receiveEnabled: '1', redisError: 'OOM' }, now).state, 'degraded');
  });
  it('篩選:IP 比對所有 IP 欄位、Port 比對來源或目的', () => {
    assert.ok(matchLog({ src: '10.0.0.1', dst: '8.8.8.8' }, { ip: '8.8.8.8' }));
    assert.ok(matchLog({ publicIp: '1.2.3.4' }, { ip: '1.2.3.4' }));
    assert.ok(!matchLog({ src: '10.0.0.1' }, { ip: '10.0.0.2' }));
    assert.ok(matchLog({ dport: 443, action: 'allow' }, { port: 443, action: 'allow' }));
    assert.ok(!matchLog({ dport: 443, action: 'deny' }, { action: 'allow' }));
  });
  it('錯誤原文只留分類,不含主機與 IP', () => {
    const out = summarizeError("session: URLError: reason=[Errno 111] Connection refused (10.10.1.1:443); dataplane: Invalid Credential")!;
    assert.equal(out, 'session:連不到主機;dataplane:API Key 無效或權限不足');
    assert.doesNotMatch(summarizeError('Error 111 connecting to netops-redis:6379')!, /netops-redis|6379/);
    assert.equal(summarizeError(undefined), null);
  });
  it('游標格式:只接受已知類型與 Stream ID', () => {
    assert.deepEqual(parseCursor('traffic:1762300000000-0,threat:1762299999000-3'), { traffic: '1762300000000-0', threat: '1762299999000-3' });
    for (const bad of ['', 'nope:1-0', 'traffic:abc', 'traffic:1-0;rm', 7]) assert.equal(parseCursor(bad), null);
  });
});

describe('PA 即時監控 REST', () => {
  let t: TestApp;
  let redis: FakeRedis;
  before(async () => {
    redis = new FakeRedis();
    t = await createTestApp({ paLiveRedis: createPaLiveRedis(redis) });
  });
  after(async () => t.close());
  beforeEach(() => {
    redis.fail = false;
    redis.strings.clear();
    redis.hashes.clear();
    redis.streams.clear();
    redis.zsets.clear();
  });

  it('snapshot:收集器運作中時回傳快照', async () => {
    redis.setHeartbeat(hbOk());
    redis.setSnap('session', { time: iso(Date.now()), active: 3912, max: 262142, utilization: 1.5 });
    const res = await t.call({ url: '/v1/pa-live/snapshot' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.collector.state, 'ok');
    assert.equal(body.metrics.session.active, 3912);
    assert.equal(body.metrics.cpu, null, '沒有快照(過期)的指標為 null');
  });

  it('snapshot:收集器停止時不回傳舊快照', async () => {
    redis.setHeartbeat(hbOk({ updatedAt: iso(Date.now() - 120_000) }));
    redis.setSnap('session', { active: 1 });
    const body = (await t.call({ url: '/v1/pa-live/snapshot' })).json();
    assert.equal(body.collector.state, 'stopped');
    assert.match(body.collector.message, /停止更新/);
    assert.ok(Object.values(body.metrics).every((v) => v === null));
  });

  it('snapshot:未啟用與 Redis 連不上都明確標示(200)', async () => {
    redis.setHeartbeat(hbOk({ pollEnabled: '0', receiveEnabled: '0' }));
    assert.equal((await t.call({ url: '/v1/pa-live/snapshot' })).json().collector.state, 'disabled');
    redis.fail = true;
    const res = await t.call({ url: '/v1/pa-live/snapshot' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().collector.state, 'unavailable');
  });

  it('series:依時間由舊到新,只回期間內', async () => {
    const now = Date.now();
    redis.addSeries('cpu', { mgmt: 1 }, now - 2 * 3600_000);
    redis.addSeries('cpu', { mgmt: 2 }, now - 600_000);
    redis.addSeries('cpu', { mgmt: 3 }, now - 60_000);
    const body = (await t.call({ url: '/v1/pa-live/series?metric=cpu&minutes=60' })).json();
    assert.deepEqual(
      body.points.map((p: { mgmt: number }) => p.mgmt),
      [2, 3],
    );
    assert.equal((await t.call({ url: '/v1/pa-live/series?metric=nope' })).statusCode, 400);
  });

  it('top:合併每分鐘排行與統計', async () => {
    const now = Date.now();
    const b0 = minuteBucket(now);
    const b1 = minuteBucket(now - 60_000);
    redis.setAgg('traffic', b0, { count: 10, bytes: 1000, 'action:allow': 8, 'action:deny': 2 });
    redis.setAgg('traffic', b1, { count: 5, bytes: 500, 'action:allow': 5 });
    redis.setTop('traffic', 'src', b0, { '10.0.0.1': 6, '10.0.0.2': 4 });
    redis.setTop('traffic', 'src', b1, { '10.0.0.2': 5 });
    const res = await t.call({ url: '/v1/pa-live/top?type=traffic&minutes=5&dims=src' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.totals, { count: 15, bytes: 1500 });
    assert.deepEqual(body.kpis.action, { allow: 13, deny: 2 });
    assert.deepEqual(body.tops.src, [
      { key: '10.0.0.2', value: 9 },
      { key: '10.0.0.1', value: 6 },
    ]);
    assert.equal(body.perMinute.length, 5);
    assert.equal(body.retentionSec, 86400);
    assert.equal((await t.call({ url: '/v1/pa-live/top?type=traffic&minutes=30' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa-live/top?type=threat&minutes=5&dims=srcBytes' })).statusCode, 400, '該類型沒有的維度回 400,不默默略過');
  });

  it('logs:由新到舊、篩選、分頁與最早時間', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) redis.addLog('threat', { src: i % 2 ? '10.1.2.3' : '10.9.9.9', dst: '8.8.8.8', name: `t${i}` }, now - (5 - i) * 1000);
    const res = await t.call({ url: '/v1/pa-live/logs?type=threat&limit=2' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(
      body.items.map((x: { name: string }) => x.name),
      ['t4', 't3'],
    );
    assert.equal(body.items[0].type, 'threat');
    assert.match(body.items[0].receivedAt, /Z$/);
    assert.ok(body.nextBefore);
    assert.equal(body.earliest, new Date(now - 5000).toISOString());
    const page2 = (await t.call({ url: `/v1/pa-live/logs?type=threat&limit=10&before=${body.nextBefore}` })).json();
    assert.deepEqual(
      page2.items.map((x: { name: string }) => x.name),
      ['t2', 't1', 't0'],
    );
    assert.equal(page2.nextBefore, null);
    const f = (await t.call({ url: '/v1/pa-live/logs?type=threat&ip=10.1.2.3' })).json();
    assert.deepEqual(
      f.items.map((x: { name: string }) => x.name),
      ['t3', 't1'],
    );
  });

  it('logs:參數驗證;Redis 連不上回 424 NETOPS_REDIS_UNAVAILABLE', async () => {
    assert.equal((await t.call({ url: '/v1/pa-live/logs?type=traffic&before=0-0' })).statusCode, 400, '(0-0 是 Redis 的無效區間');
    assert.equal((await t.call({ url: '/v1/pa-live/logs?type=nope' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa-live/logs?type=traffic&ip=1.2.3.4;x' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa-live/logs?type=traffic&before=abc' })).statusCode, 400);
    redis.fail = true;
    const res = await t.call({ url: '/v1/pa-live/logs?type=traffic' });
    assert.equal(res.statusCode, 424, '不用 5xx(BFF 斷路器)');
    assert.equal(res.json().code, 'NETOPS_REDIS_UNAVAILABLE');
    assert.doesNotMatch(res.body, /ECONNREFUSED|netops:pa/, '回應不含原始錯誤與 Redis 鍵');
  });

  it('Redis 回指令錯誤(不是連線問題)回 500,不當成 unavailable', async () => {
    const orig = redis.xrevrange.bind(redis);
    redis.xrevrange = async () => {
      throw Object.assign(new Error('WRONGTYPE Operation against a key'), { name: 'ReplyError' });
    };
    try {
      const res = await t.call({ url: '/v1/pa-live/logs?type=traffic' });
      assert.equal(res.statusCode, 500);
      assert.doesNotMatch(res.body, /WRONGTYPE/);
    } finally {
      redis.xrevrange = orig;
    }
  });

  it('OpenAPI:即時 log 與串流設稽核 meta;串流 x-timeout-ms 60000', async () => {
    const doc = (await t.app.inject({ url: '/openapi.json' })).json();
    const op = (p: string) => doc.paths[p].get;
    assert.equal(op('/v1/pa-live/logs')['x-audit-level'], 'meta');
    assert.equal(op('/v1/pa-live/stream')['x-audit-level'], 'meta');
    assert.equal(op('/v1/pa-live/stream')['x-timeout-ms'], 60000);
    for (const p of ['snapshot', 'series', 'top', 'logs', 'stream']) assert.equal(op(`/v1/pa-live/${p}`)['x-permission'], 'netops.pa-realtime.read');
  });
});

describe('Redis 未設定(dev 沒有 REDIS_URL)', () => {
  let t: TestApp;
  before(async () => (t = await createTestApp()));
  after(async () => t.close());
  it('snapshot 回 unavailable、logs 回 424 NETOPS_PA_LIVE_DISABLED', async () => {
    assert.equal((await t.call({ url: '/v1/pa-live/snapshot' })).json().collector.state, 'unavailable');
    const res = await t.call({ url: '/v1/pa-live/logs?type=traffic' });
    assert.equal(res.statusCode, 424);
    assert.equal(res.json().code, 'NETOPS_PA_LIVE_DISABLED');
  });
});

// ---------- SSE ----------
interface Ev {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
}
function connect(port: number, path: string, headers: Record<string, string>) {
  const events: Ev[] = [];
  let req!: http.ClientRequest;
  const response = new Promise<{ status: number; headers: http.IncomingHttpHeaders; ended: Promise<void>; body: () => string }>((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let buf = '';
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: Ev = {};
          for (const line of block.split('\n')) {
            const [k, ...v] = line.split(': ');
            const val = v.join(': ');
            if (k === 'id') ev.id = val;
            else if (k === 'event') ev.event = val;
            else if (k === 'data') ev.data = JSON.parse(val);
          }
          if (ev.event) events.push(ev);
        }
      });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, ended: new Promise<void>((r) => res.on('close', () => r())), body: () => raw });
    });
    req.on('error', reject);
  });
  return { response, events, abort: () => req.destroy() };
}

describe('PA 即時監控串流(SSE)', () => {
  let t: TestApp;
  let redis: FakeRedis;
  let port: number;
  let auth: Record<string, string>;
  before(async () => {
    redis = new FakeRedis();
    redis.setHeartbeat(hbOk());
    t = await createTestApp({
      paLiveRedis: createPaLiveRedis(redis),
      liveStream: { pollMs: 30, snapshotMs: 1000, heartbeatMs: 50, maxMs: 1500, maxStreams: 3, maxPerUser: 2 },
    });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    port = (t.app.server.address() as AddressInfo).port;
    auth = { 'x-internal-token': await t.token(), 'x-request-id': 'req-r1-sse' };
  });
  after(async () => t.close());

  it('立即送 open 與 snapshot;只送連線後的新 log;依篩選;id 為游標', async () => {
    redis.addLog('traffic', { src: '10.0.0.1', action: 'allow' }, Date.now() - 5000);
    const c = connect(port, '/v1/pa-live/stream?types=traffic&action=deny', auth);
    const res = await c.response;
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
    await waitFor(() => c.events.some((e) => e.event === 'snapshot'), 2000);
    assert.equal(c.events[0]!.event, 'open');
    assert.equal((c.events.find((e) => e.event === 'snapshot')!.data!.collector as { state: string }).state, 'ok');
    redis.addLog('traffic', { src: '10.0.0.2', action: 'allow' });
    redis.addLog('traffic', { src: '10.0.0.3', action: 'deny' });
    await waitFor(() => c.events.some((e) => e.event === 'logs'), 2000);
    const logs = c.events.find((e) => e.event === 'logs')!;
    assert.deepEqual(
      (logs.data!.items as { src: string }[]).map((x) => x.src),
      ['10.0.0.3'],
    );
    assert.match(logs.id!, /^traffic:\d+-\d+$/);
    await waitFor(() => c.events.some((e) => e.event === 'heartbeat'), 2000);
    c.abort();
  });

  it('Last-Event-ID 接續:只收到游標之後的 log', async () => {
    const a = redis.addLog('threat', { name: 'old' });
    redis.addLog('threat', { name: 'after-1' });
    const c = connect(port, '/v1/pa-live/stream?types=threat', { ...auth, 'last-event-id': `threat:${a}` });
    await waitFor(() => c.events.some((e) => e.event === 'logs'), 2000);
    assert.equal(c.events[0]!.data!.resumed, true);
    assert.deepEqual(
      (c.events.find((e) => e.event === 'logs')!.data!.items as { name: string }[]).map((x) => x.name),
      ['after-1'],
    );
    c.abort();
  });

  it('每人上限回 429(不回 5xx);斷線後釋放名額;最長時間到結束', async () => {
    const a = connect(port, '/v1/pa-live/stream', auth);
    const b = connect(port, '/v1/pa-live/stream', auth);
    await a.response;
    await b.response;
    const c = connect(port, '/v1/pa-live/stream', auth);
    const res = await c.response;
    assert.equal(res.status, 429);
    await res.ended;
    assert.match(res.body(), /NETOPS_STREAM_BUSY/);
    a.abort();
    await waitFor(async () => {
      const d = connect(port, '/v1/pa-live/stream', auth);
      const r = await d.response;
      d.abort();
      return r.status === 200;
    }, 2000);
    // b 在 maxMs(1.5 秒)後由伺服器結束
    await Promise.race([(await b.response).ended, new Promise((_, rej) => setTimeout(() => rej(new Error('沒有在最長時間結束')), 4000))]);
  });

  it('某類型讀取失敗:其他類型照常送出,失敗的類型恢復後補上;送 degraded', async () => {
    const c = connect(port, '/v1/pa-live/stream?types=traffic,threat', { ...auth, 'x-internal-token': await t.token('S000003') });
    await waitFor(() => c.events.some((e) => e.event === 'snapshot'), 2000);
    const orig = redis.xrange.bind(redis);
    redis.xrange = async (key, ...rest) => {
      if (key.endsWith(':threat')) throw new Error('timeout');
      return orig(key, ...rest);
    };
    try {
      redis.addLog('traffic', { src: 'ok-traffic' });
      redis.addLog('threat', { name: 'late-threat' });
      await waitFor(() => c.events.some((e) => e.event === 'degraded' && (e.data!.types as string[]).includes('threat')), 2000);
      await waitFor(() => c.events.some((e) => e.event === 'logs' && (e.data!.items as { src?: string }[]).some((x) => x.src === 'ok-traffic')), 2000);
    } finally {
      redis.xrange = orig;
    }
    await waitFor(() => c.events.some((e) => e.event === 'logs' && (e.data!.items as { name?: string }[]).some((x) => x.name === 'late-threat')), 2000);
    c.abort();
  });

  it('Last-Event-ID 比現在早超過 5 分鐘:不接續,列在 gap', async () => {
    const old = redis.addLog('url', { url: 'old.example' }, Date.now() - 10 * 60_000);
    const c = connect(port, '/v1/pa-live/stream?types=url', { ...auth, 'x-internal-token': await t.token('S000004'), 'last-event-id': `url:${old}` });
    await waitFor(() => c.events.some((e) => e.event === 'open'), 2000);
    assert.deepEqual(c.events[0]!.data!.gap, ['url']);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!c.events.some((e) => e.event === 'logs'), '不送舊明細');
    c.abort();
  });

  it('Redis 停止時串流不中斷,snapshot 帶 unavailable', async () => {
    const c = connect(port, '/v1/pa-live/stream?types=traffic', { ...auth, 'x-internal-token': await t.token('S000002') });
    await waitFor(() => c.events.some((e) => e.event === 'open'), 2000);
    redis.fail = true;
    try {
      await waitFor(() => c.events.some((e) => e.event === 'snapshot' && (e.data!.collector as { state: string }).state === 'unavailable'), 3000);
    } finally {
      redis.fail = false;
      c.abort();
    }
  });
});
