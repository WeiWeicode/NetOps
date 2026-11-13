/**
 * V-a 活動熱力圖與時段明細(docs/VIZ-RULES-DESIGN.md §4.2、§4.3):期間與格子、分級、null vs 0、熱 / 冷路由、30 秒轉工作、冷查詢 429、權限與錯誤格式。
 * ClickHouse 以假 HeatReader 注入;SQL 在真 ClickHouse 的驗證見 test/integration/heat.int.test.ts。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ClickHouseError } from '../../src/infra/clickhouse/index.js';
import { createHeatReader, threatWhere, type HeatReader, type HeatRow, type SliceData } from '../../src/infra/clickhouse/heat.js';
import { COLD_LOCK_KEY, createColdLock } from '../../src/infra/redis/cold-lock.js';
import { buildCells, heatRange, parseDay, quantileLevel, quantileThresholds, threatLevel, threatScore } from '../../src/modules/pa-heat/heat.js';
import { mergeSlices, type ColdSlice } from '../../src/modules/pa-heat/service.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createTestApp, type TestApp } from '../helpers.js';

const DAY = 86_400_000;
// 2026-11-11(週三)10:07:30 台灣時間
const NOW = Date.parse('2026-11-11T10:07:30+08:00');
const row = (t: number, x: Partial<HeatRow> = {}): HeatRow => ({ t, sessions: 0, bytes: 0, sent: 0, recv: 0, deny: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, topBytes: [], topDeny: [], topThreat: [], ...x });
const sliceData = (x: Partial<SliceData> = {}): SliceData => ({
  summary: { sessions: 2, bytes: 300, sent: 100, recv: 200, deny: 1, threats: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } },
  top: { src: [{ key: '10.0.0.1', sessions: 2, bytes: 300 }] },
  rows: [{ time: '2026/11/11 08:01:00', src: '10.0.0.1', bytes: 100 }],
  more: false,
  ...x,
});

describe('熱力圖期間與格子', () => {
  it('年視圖:今天所在週(週一開始)為最後一欄,往前 53 週;今天之後的格不回', () => {
    const r = heatRange('year', parseDay('2026-11-11'), NOW);
    assert.equal(r.grain, '1d');
    assert.equal(r.fromMs, parseDay('2025-11-10'));
    assert.equal(r.toMs, parseDay('2026-11-16'));
    assert.equal(r.cells.length, 53 * 7 - 4); // 週四到週日還沒到
    assert.equal(r.cells.at(-1), parseDay('2026-11-11'));
  });

  it('月視圖每小時、日視圖每 5 分鐘;過去的期間格子完整', () => {
    const m = heatRange('month', parseDay('2026-10-05'), NOW);
    assert.equal(m.cells.length, 31 * 24);
    assert.equal(m.fromMs, parseDay('2026-10-01'));
    const d = heatRange('day', parseDay('2026-11-11'), NOW);
    assert.equal(d.cells.length, 10 * 12 + 2); // 00:00–10:05
    assert.equal(heatRange('day', parseDay('2026-11-10'), NOW).cells.length, 288);
  });

  it('威脅分數 10 / 5 / 2 / 1 與最高嚴重度分級', () => {
    assert.equal(threatScore({ critical: 1, high: 2, medium: 3, low: 4 }), 10 + 10 + 6 + 4);
    assert.equal(threatLevel(row(0, { critical: 1 })), 4);
    assert.equal(threatLevel(row(0, { high: 9 })), 3);
    assert.equal(threatLevel(row(0, { medium: 1 })), 2);
    assert.equal(threatLevel(row(0, { info: 5 })), 1);
    assert.equal(threatLevel(row(0)), 0);
  });

  it('流量分級:非 0 格的 25 / 50 / 75 百分位', () => {
    const t = quantileThresholds([0, 10, 20, 30, 40, 50]);
    assert.deepEqual(t, [20, 30, 40]);
    assert.equal(quantileLevel(0, t), 0);
    assert.equal(quantileLevel(5, t), 1);
    assert.equal(quantileLevel(20, t), 2);
    assert.equal(quantileLevel(50, t), 4);
    assert.deepEqual(quantileThresholds([0, 0]), []);
  });

  it('null 和 0 分開:彙總表最早的格子之前是 null;缺口內的格子 partial', () => {
    const r = heatRange('day', parseDay('2026-11-10'), NOW);
    const since = parseDay('2026-11-10') + 3600_000;
    const day = parseDay('2026-11-10');
    const rows = [row(since + 300_000, { bytes: 500, sessions: 3, topBytes: ['10.1.1.1'] }), row(day + 35 * 300_000, { bytes: 1 }), row(day + 36 * 300_000, { bytes: 1 })];
    const gap = { fromMs: since + 7200_000, toMs: since + 3 * 3600_000, reason: 'recon-gap' };
    const { cells, levels } = buildCells(r, 'traffic', rows, since, [gap]);
    assert.equal(cells[0]!.v, null);
    assert.equal(cells[0]!.level, 0);
    // C1:since 之後、彙總表沒有列的格子也是 null(沒有資料,不是 0)
    assert.equal(cells[12]!.v, null);
    assert.equal(cells[12]!.level, 0);
    assert.equal(cells[13]!.v, 500);
    assert.equal(cells[13]!.tip.topIp.traffic, '10.1.1.1');
    assert.equal(cells[13]!.t, '2026-11-10T01:05:00+08:00');
    assert.equal(cells[36]!.partial, true);
    assert.equal(cells[35]!.partial, false);
    assert.equal(levels.method, 'quantile');
    assert.ok(buildCells(r, 'traffic', [], null, []).cells.every((c) => c.v === null));
  });

  it('C1:彙總表缺的格子 v = null,連續格子合併成 no-data 缺口(最後 10 分鐘內的格子不列)', () => {
    const day = parseDay('2026-11-13');
    const now = day + 9 * 3600_000; // 09:00
    const r = heatRange('day', day, now);
    // 彙總表從 11-11 開始;11-13 只有 08:35 之後有列(00:00–08:30 未彙總)
    const rows = [];
    for (let t = day + 8 * 3600_000 + 35 * 60_000; t <= day + 8 * 3600_000 + 45 * 60_000; t += 300_000) rows.push(row(t, { critical: 1, sessions: 5 }));
    const { cells, missing } = buildCells(r, 'threat', rows, day - 2 * 86_400_000, [], now);
    assert.equal(cells[0]!.v, null);
    assert.equal(cells[0]!.partial, true);
    assert.equal(cells[102]!.v, null); // 08:30
    assert.equal(cells[103]!.v, 10); // 08:35
    assert.equal(cells[103]!.partial, false);
    // 08:50(結束 08:55,距現在 5 分鐘)還在寬限內;08:55、09:00 進行中
    assert.deepEqual(missing, [{ fromMs: day, toMs: day + 8 * 3600_000 + 35 * 60_000, reason: 'no-data' }]);
    assert.equal(cells[106]!.v, null);
    assert.equal(cells[106]!.partial, false);
  });
});

describe('時段明細合併與條件', () => {
  it('跨熱 / 冷分界:總數相加、排行依鍵合併、明細依時間新到舊', () => {
    const a = sliceData({ rows: [{ time: '2026/10/01 08:00:00', bytes: 1 }] });
    const b = sliceData({ top: { src: [{ key: '10.0.0.2', sessions: 1, bytes: 900 }] }, rows: [{ time: '2026/10/01 09:00:00', bytes: 2 }] });
    const m = mergeSlices(a, b, 1, 'time');
    assert.equal(m.summary.sessions, 4);
    assert.equal(m.summary.threats.high, 2);
    assert.deepEqual(m.top.src!.map((x) => x.key), ['10.0.0.2', '10.0.0.1']);
    assert.equal(m.rows.length, 1);
    assert.equal(m.rows[0]!.time, '2026/10/01 09:00:00');
    assert.equal(m.more, true);
  });

  it('威脅條件:log_type、嚴重度(info → informational)、名稱都用參數', () => {
    const { where, params } = threatWhere({ fromMs: 0, toMs: 3600_000, ip: '10.0.0.1', severity: 'info', threatName: "x'; DROP" });
    assert.ok(where.includes(`log_type = 'threat'`));
    assert.ok(Object.values(params).includes('informational'));
    assert.ok(Object.values(params).includes("x'; DROP"));
    assert.ok(!where.join(' ').includes('DROP'));
  });

  it('HeatReader:別名不和欄位同名、條件用 query_params、IPv4 去掉 ::ffff:', async () => {
    const reqs: { url: URL; body: string }[] = [];
    const reader = createHeatReader({ url: 'http://ch:8123', user: 'netops_reader', password: 'x' }, (async (u: URL, init: RequestInit) => {
      reqs.push({ url: u, body: String(init.body) });
      return new Response('');
    }) as unknown as typeof fetch);
    await reader.slice('traffic', { fromMs: 0, toMs: 3600_000, src: '10.0.0.0/24' }, 10, 'time', 50);
    for (const r of reqs) {
      assert.ok(!/ AS (src|dst|bytes|action|severity)\b/.test(r.body), r.body);
      assert.equal(r.url.searchParams.get('param_from'), '0');
      assert.ok(Number(r.url.searchParams.get('max_execution_time')) <= 50);
    }
    reqs.length = 0;
    await reader.heatRows('1h', 0, DAY);
    assert.match(reqs[0]!.body, /FROM netops\.pa_heat_1h/);
    assert.match(reqs[0]!.body, /topKWeightedMerge\(3\)/);
  });
});

describe('冷查詢鎖', () => {
  it('NX + PX;只釋放自己的鎖', async () => {
    const calls: unknown[][] = [];
    let held: string | null = null;
    const lock = createColdLock({
      set: async (k, v, _px, ms, _nx) => (calls.push([k, ms]), held ? null : ((held = v), 'OK')),
      eval: async (_s, _n, _k, v) => (held === v ? ((held = null), 1) : 0),
      quit: async () => 'OK',
    });
    assert.equal(await lock.acquire('a'), true);
    assert.equal(await lock.acquire('b'), false);
    await lock.release('b');
    assert.equal(held, 'a');
    await lock.release('a');
    assert.equal(held, null);
    assert.deepEqual(calls[0], [COLD_LOCK_KEY, 120_000]);
  });
});

/** 假 HeatReader:slice 可以延遲 */
function fakeReader(opts: { since?: number | null; rows?: HeatRow[]; sliceDelayMs?: number; fail?: boolean } = {}) {
  const calls = { slice: 0, heat: 0 };
  const reader: HeatReader = {
    async heatRows() {
      calls.heat++;
      if (opts.fail) throw new ClickHouseError('ClickHouse 連線失敗:ECONNREFUSED', undefined, undefined);
      return opts.rows ?? [];
    },
    async heatEarliest() {
      return opts.since === undefined ? parseDay('2026-11-01') : opts.since;
    },
    insightFlows: async () => [],
    insightTopApps: async () => [],
    insightTopSrc: async () => [],
    threatCountries: async () => [],
    threatTopInternalSrc: async () => [],
    threatTopNames: async () => [],
    async slice() {
      calls.slice++;
      if (opts.sliceDelayMs) await new Promise((r) => setTimeout(r, opts.sliceDelayMs));
      return sliceData();
    },
  };
  return { reader, calls };
}

describe('GET /v1/pa/heatmap', () => {
  let t: TestApp;
  const fake = fakeReader({ rows: [row(parseDay('2026-11-11') + 8 * 3600_000, { bytes: 2_000, critical: 1, high: 2 })] });
  before(async () => {
    t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fake.reader, now: () => NOW } });
  });
  after(() => t.close());

  it('月視圖:格子到現在為止、bucketSeconds 3600、coverage', async () => {
    const res = await t.call({ url: '/v1/pa/heatmap?granularity=month&metric=traffic&date=2026-11-11' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.bucketSeconds, 3600);
    assert.equal(b.cells.length, 10 * 24 + 11);
    assert.equal(b.from, '2026-11-01T00:00:00+08:00');
    assert.equal(b.coverage.since, '2026-11-01T00:00:00+08:00');
    assert.equal(b.coverage.gapsKnown, false);
    const c = b.cells.find((x: { t: string }) => x.t === '2026-11-11T08:00:00+08:00');
    assert.equal(c.v, 2000);
    assert.equal(c.level, 4);
    // C1:彙總表沒有列的格子 null,並列進 coverage.gaps
    assert.equal(b.cells[0].v, null);
    assert.deepEqual(b.coverage.gaps[0], { from: '2026-11-01T00:00:00+08:00', to: '2026-11-11T08:00:00+08:00', reason: 'no-data' });
  });

  it('威脅:v 為加權分數、依最高嚴重度分級', async () => {
    const b = (await t.call({ url: '/v1/pa/heatmap?granularity=day&metric=threat&date=2026-11-11' })).json();
    const c = b.cells.find((x: { t: string }) => x.t === '2026-11-11T08:00:00+08:00');
    assert.equal(c.v, 20);
    assert.equal(c.level, 4);
    assert.equal(b.levels.method, 'severity');
  });

  it('ad 回 409、日視圖超過 1 年回 422(details.earliest)、未來日期 400、缺參數 400', async () => {
    assert.equal((await t.call({ url: '/v1/pa/heatmap?granularity=year&metric=ad' })).json().code, 'NETOPS_HEATMAP_METRIC_UNAVAILABLE');
    const r = await t.call({ url: '/v1/pa/heatmap?granularity=day&metric=traffic&date=2025-11-10' });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().code, 'NETOPS_HEATMAP_OUT_OF_RETENTION');
    assert.equal(r.json().details.earliest, '2025-11-11');
    assert.equal((await t.call({ url: '/v1/pa/heatmap?granularity=day&metric=traffic&date=2025-11-11' })).statusCode, 200);
    assert.equal((await t.call({ url: '/v1/pa/heatmap?granularity=day&metric=traffic&date=2026-11-12' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa/heatmap?granularity=week&metric=traffic' })).statusCode, 400);
  });

  it('ClickHouse 失敗回 503 NETOPS_CLICKHOUSE_UNAVAILABLE,不帶出原文;沒有設定 ClickHouse 也是 503', async () => {
    const bad = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader({ fail: true }).reader, now: () => NOW } });
    const none = await createTestApp({ ftp: createFakeFtp(), heat: { reader: null, now: () => NOW } });
    try {
      const r = await bad.call({ url: '/v1/pa/heatmap?granularity=day&metric=traffic' });
      assert.equal(r.statusCode, 503);
      assert.equal(r.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
      assert.ok(!r.body.includes('ECONNREFUSED'));
      assert.equal((await none.call({ url: '/v1/pa/heatmap?granularity=day&metric=traffic' })).statusCode, 503);
    } finally {
      await bad.close();
      await none.close();
    }
  });
});

describe('GET /v1/pa/slice', () => {
  const q = (start: string, end: string, extra = '') => `/v1/pa/slice?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${extra}`;

  it('熱資料 30 秒內完成回 200;時間轉 ISO;同條件重送重用', async () => {
    const fake = fakeReader();
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fake.reader, now: () => NOW } });
    try {
      const url = q('2026-11-11T08:00:00+08:00', '2026-11-11T09:00:00+08:00', '&ip=10.0.0.1&rows=50');
      const res = await t.call({ url });
      assert.equal(res.statusCode, 200);
      const b = res.json();
      assert.equal(b.source, 'hot');
      assert.equal(b.rows[0].time, '2026-11-11T08:01:00+08:00');
      assert.deepEqual(b.filters, { ip: '10.0.0.1' });
      assert.equal(b.rowsLimit, 50);
      assert.equal((await t.call({ url })).statusCode, 200);
      assert.equal(fake.calls.slice, 1);
    } finally {
      await t.close();
    }
  });

  it('超過等待時間回 202,輪詢到 done;同條件重送回同一個工作;別人查不到;取消冪等', async () => {
    const fake = fakeReader({ sliceDelayMs: 150 });
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fake.reader, now: () => NOW, syncMs: 20 } });
    try {
      const url = q('2026-11-11T08:00:00+08:00', '2026-11-11T09:00:00+08:00');
      const r1 = await t.call({ url });
      assert.equal(r1.statusCode, 202);
      const id = r1.json().id;
      const r2 = await t.call({ url });
      assert.equal(r2.statusCode, 202);
      assert.equal(r2.json().id, id);
      assert.equal((await t.call({ url: `/v1/pa/slices/${id}`, emp: 'S999999' })).statusCode, 404);
      await new Promise((r) => setTimeout(r, 250));
      const done = (await t.call({ url: `/v1/pa/slices/${id}` })).json();
      assert.equal(done.status, 'done');
      assert.equal(done.result.source, 'hot');
      assert.equal(fake.calls.slice, 1);
      assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa/slices/${id}` })).statusCode, 204);
      assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa/slices/${id}` })).statusCode, 204);
    } finally {
      await t.close();
    }
  });

  it('超過 1 天、結束早於開始、萬用字元 IP 回 400', async () => {
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader().reader, now: () => NOW } });
    try {
      assert.equal((await t.call({ url: q('2026-11-10T08:00:00+08:00', '2026-11-11T08:01:00+08:00') })).statusCode, 400);
      assert.equal((await t.call({ url: q('2026-11-11T09:00:00+08:00', '2026-11-11T08:00:00+08:00') })).statusCode, 400);
      assert.equal((await t.call({ url: q('2026-11-11T08:00:00+08:00', '2026-11-11T09:00:00+08:00', '&ip=10.*') })).statusCode, 400);
      assert.equal((await t.call({ url: q('2026-11-11T08:00:00+08:00', '2026-11-11T09:00:00+08:00', '&rows=201') })).statusCode, 400);
    } finally {
      await t.close();
    }
  });

  it('早於熱表保留(測試區 2 天前):冷歸檔未提供回 409 NETOPS_COLD_ARCHIVE_DISABLED', async () => {
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader().reader, now: () => NOW } });
    try {
      // 測試區 TTL 3 天 → 熱表從 2026-11-09 00:00 起
      assert.equal((await t.call({ url: q('2026-11-09T00:00:00+08:00', '2026-11-09T01:00:00+08:00') })).statusCode, 200);
      const r = await t.call({ url: q('2026-11-08T23:00:00+08:00', '2026-11-09T01:00:00+08:00') });
      assert.equal(r.statusCode, 409);
      assert.equal(r.json().code, 'NETOPS_COLD_ARCHIVE_DISABLED');
      assert.equal(r.json().details.hotFrom, '2026-11-09T00:00:00+08:00');
    } finally {
      await t.close();
    }
  });

  it('冷查詢全系統 1 個:第 2 個回 429 + Retry-After;結束後釋放;跨界時合併', async () => {
    let held: string | null = null;
    const coldLock = createColdLock({ set: async (_k, v) => (held ? null : ((held = v), 'OK')), eval: async (_s, _n, _k, v) => (held === v ? ((held = null), 1) : 0), quit: async () => 'OK' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cold: ColdSlice = {
      query: async () => {
        await gate;
        return sliceData({ rows: [{ time: '2026/11/08 23:30:00', bytes: 5 }] });
      },
    };
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader().reader, cold, coldLock, now: () => NOW, syncMs: 20 } });
    try {
      const r1 = await t.call({ url: q('2026-11-08T23:00:00+08:00', '2026-11-09T01:00:00+08:00') });
      assert.equal(r1.statusCode, 202);
      const r2 = await t.call({ url: q('2026-11-08T08:00:00+08:00', '2026-11-08T09:00:00+08:00'), emp: 'S000002' });
      assert.equal(r2.statusCode, 429);
      assert.equal(r2.json().code, 'NETOPS_COLD_QUERY_BUSY');
      assert.equal(r2.headers['retry-after'], '10');
      assert.equal(r2.json().details.retryAfter, 10);
      release();
      await new Promise((r) => setTimeout(r, 50));
      const done = (await t.call({ url: `/v1/pa/slices/${r1.json().id}` })).json();
      assert.equal(done.status, 'done');
      assert.equal(done.result.source, 'mixed');
      assert.equal(done.result.summary.sessions, 4);
      assert.equal(held, null);
      assert.equal((await t.call({ url: q('2026-11-08T08:00:00+08:00', '2026-11-08T09:00:00+08:00'), emp: 'S000002' })).statusCode, 200);
    } finally {
      await t.close();
    }
  });
});

describe('時段明細的併發(程式碼審查 #2、#3)', () => {
  const q = (start: string, end: string) => `/v1/pa/slice?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  it('冷資料同條件同時送兩次:重用同一個工作,不回 429', async () => {
    let held: string | null = null;
    const coldLock = createColdLock({ set: async (_k, v) => (held ? null : ((held = v), 'OK')), eval: async (_s, _n, _k, v) => (held === v ? ((held = null), 1) : 0), quit: async () => 'OK' });
    const cold: ColdSlice = { query: async () => (await new Promise((r) => setTimeout(r, 80)), sliceData()) };
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader().reader, cold, coldLock, now: () => NOW, syncMs: 10 } });
    try {
      const url = q('2026-11-08T08:00:00+08:00', '2026-11-08T09:00:00+08:00');
      const [a, b] = await Promise.all([t.call({ url }), t.call({ url })]);
      assert.deepEqual([a.statusCode, b.statusCode], [202, 202]);
      assert.equal(a.json().id, b.json().id);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(held, null);
    } finally {
      await t.close();
    }
  });

  it('熱查詢同時 2 個:第三個排隊,前面完成後開始執行,同步等待期間會輪詢狀態並回 200', async () => {
    const t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader({ sliceDelayMs: 300 }).reader, now: () => NOW, syncMs: 5000 } });
    try {
      // 熱查詢同時 2 個:前兩個佔滿,第三個排隊
      const busy = [t.call({ url: q('2026-11-11T01:00:00+08:00', '2026-11-11T02:00:00+08:00'), emp: 'S000011' }), t.call({ url: q('2026-11-11T02:00:00+08:00', '2026-11-11T03:00:00+08:00'), emp: 'S000012' })];
      await new Promise((r) => setTimeout(r, 20));
      const t0 = Date.now();
      const third = t.call({ url: q('2026-11-11T03:00:00+08:00', '2026-11-11T04:00:00+08:00'), emp: 'S000013' });
      await new Promise((r) => setTimeout(r, 50));
      const r3 = await third;
      assert.equal(r3.statusCode, 200);
      assert.ok(Date.now() - t0 < 2000);
      await Promise.all(busy);
    } finally {
      await t.close();
    }
  });
});
