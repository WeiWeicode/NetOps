/**
 * S0 串流驗證(IMPL-PLAN S0、docs/API.md §3.1):GET /v1/pa-live/stream-test
 *   以真實 HTTP 連線(不用 inject)確認:標頭立即送出、open 事件先到、heartbeat 依間隔送出且序號遞增、
 *   Last-Event-ID 接續、最長時間到結束、連線數上限(全系統、每人)、斷線釋放名額、服務關閉時結束串流。間隔縮短為數十毫秒。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

interface SseEvent {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  retry?: number;
  at: number;
}

/** 連線並逐筆解析 SSE;回傳標頭、事件陣列與中斷函式 */
function connect(port: number, headers: Record<string, string>) {
  const events: SseEvent[] = [];
  let req!: http.ClientRequest;
  const started = Date.now();
  const response = new Promise<{ status: number; headers: http.IncomingHttpHeaders; ended: Promise<void> }>((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/v1/pa-live/stream-test', headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: SseEvent = { at: Date.now() - started };
          for (const line of block.split('\n')) {
            const [k, ...v] = line.split(': ');
            const val = v.join(': ');
            if (k === 'id') ev.id = val;
            else if (k === 'event') ev.event = val;
            else if (k === 'data') ev.data = JSON.parse(val);
            else if (k === 'retry') ev.retry = Number(val);
          }
          events.push(ev);
        }
      });
      const ended = new Promise<void>((r) => res.on('close', () => r()));
      resolve({ status: res.statusCode ?? 0, headers: res.headers, ended });
    });
    req.on('error', reject);
  });
  return { response, events, abort: () => req.destroy() };
}

describe('SSE 串流驗證(S0)', () => {
  let t: TestApp;
  let port: number;
  let auth: Record<string, string>;

  before(async () => {
    t = await createTestApp({ streamTest: { heartbeatMs: 40, maxMs: 400, maxStreams: 1 } });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    port = (t.app.server.address() as AddressInfo).port;
    auth = { 'x-internal-token': await t.token(), 'x-request-id': 'req-sse' };
  });
  after(async () => t.close());

  it('立即回 200 與 SSE 標頭,open 先到,heartbeat 依間隔遞增,到最長時間結束', async () => {
    const c = connect(port, auth);
    const res = await c.response;
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(res.headers['set-cookie'], undefined);
    // 標頭與 open 立即送出(不等計時器),事件逐筆到達而不是結束時一次到(沒有被緩衝)
    await waitFor(() => c.events.length >= 1, 2000);
    const first = c.events[0]!;
    assert.equal(first.retry, 5000);
    assert.equal(first.event, 'open');
    assert.equal(first.id, '0');
    assert.equal(first.data!.resumedFrom, null);
    assert.equal(first.data!.connectionId, 'req-sse');

    await res.ended; // maxMs 400 到時由伺服器結束
    const span = c.events.at(-1)!.at - first.at;
    assert.ok(span >= 120, `事件沒有逐筆到達(第一筆到最後一筆只差 ${span} ms)`);
    const beats = c.events.filter((e) => e.event === 'heartbeat');
    assert.ok(beats.length >= 5, `heartbeat 只有 ${beats.length} 個`);
    beats.forEach((b, i) => {
      assert.equal(b.data!.seq, i + 1);
      assert.equal(b.id, String(i + 1));
      assert.ok(!Number.isNaN(Date.parse(String(b.data!.time))) && String(b.data!.time).endsWith('Z'));
    });
  });

  it('Last-Event-ID 重連時序號接續,open 帶 resumedFrom;格式不符時從 0 開始', async () => {
    const c = connect(port, { ...auth, 'last-event-id': '7' });
    await (await c.response).ended;
    assert.equal(c.events[0]!.data!.resumedFrom, 7);
    assert.equal(c.events.find((e) => e.event === 'heartbeat')!.data!.seq, 8);

    const bad = connect(port, { ...auth, 'last-event-id': '-1; drop' });
    await (await bad.response).ended;
    assert.equal(bad.events[0]!.data!.resumedFrom, null);
    assert.equal(bad.events[0]!.id, '0');
  });

  it('超過全系統連線上限回 429 NETOPS_STREAM_BUSY(不回 5xx,避免累積 BFF 斷路器失敗);用戶端斷線後釋放名額', async () => {
    const a = connect(port, auth);
    await a.response;
    await waitFor(() => a.events.length >= 1, 2000);
    const busy = await t.call({ url: '/v1/pa-live/stream-test' });
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.json().code, 'NETOPS_STREAM_BUSY');

    a.abort();
    await waitFor(async () => {
      const b = connect(port, auth);
      const res = await b.response;
      b.abort();
      return res.status === 200;
    }, 2000);
  });

  it('沒有內部 Token 回 401(不開始串流)', async () => {
    const c = connect(port, {});
    const res = await c.response;
    assert.equal(res.status, 401);
    assert.match(String(res.headers['content-type']), /application\/json/);
  });

  it('OpenAPI:x-permission netops.ping.read、x-timeout-ms 60000(大於心跳 15 秒)', async () => {
    const op = (await t.app.inject('/openapi.json')).json().paths['/v1/pa-live/stream-test'].get;
    assert.equal(op.operationId, 'netops.pa-live.stream-test');
    assert.equal(op['x-permission'], 'netops.ping.read');
    assert.equal(op['x-timeout-ms'], 60000);
    assert.ok(op.responses['200'].content['text/event-stream']);
  });
});

describe('SSE 每人上限與服務關閉', () => {
  it('同一人超過每人上限回 429,別人仍可連線', async () => {
    const t = await createTestApp({ streamTest: { heartbeatMs: 40, maxMs: 5000, maxStreams: 5, maxPerUser: 1 } });
    try {
      await t.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (t.app.server.address() as AddressInfo).port;
      const a = connect(port, { 'x-internal-token': await t.token('S112009') });
      assert.equal((await a.response).status, 200);
      const same = await t.call({ url: '/v1/pa-live/stream-test', emp: 'S112009' });
      assert.equal(same.statusCode, 429);
      assert.equal(same.json().code, 'NETOPS_STREAM_BUSY');
      const other = connect(port, { 'x-internal-token': await t.token('S094009') });
      assert.equal((await other.response).status, 200);
      a.abort();
      other.abort();
    } finally {
      await t.close();
    }
  });

  it('服務關閉時結束進行中的串流(不等到最長時間)', async () => {
    const t = await createTestApp({ streamTest: { heartbeatMs: 40, maxMs: 60_000 } });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const c = connect(port, { 'x-internal-token': await t.token() });
    const res = await c.response;
    await waitFor(() => c.events.length >= 2, 2000);
    const started = Date.now();
    await t.close();
    await res.ended;
    assert.ok(Date.now() - started < 5000, '關閉服務後串流沒有結束');
  });
});
