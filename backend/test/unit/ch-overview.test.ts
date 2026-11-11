/**
 * C3 查詢切換(總覽、安全事件、篩選選項):ClickHouse 唯讀查詢、每小時摘要、來源切換、快取。
 *   - 每小時摘要用和 FTP 相同的核心(createSummary / createEventSummary),合併結果 = 直接對同一批紀錄算的摘要
 *   - 來源:source 參數 > 設定;auto 只在期間開始不早於 ClickHouse 最早一小時時用 ClickHouse
 *   - ClickHouse 失敗:auto 改用 FTP;指定 clickhouse 回 503 NETOPS_CLICKHOUSE_UNAVAILABLE
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { ClickHouseError } from '../../src/infra/clickhouse/index.js';
import { createClickHouseReader, SLICE_ROWS } from '../../src/infra/clickhouse/reader.js';
import { cacheKey, createDashboardCache } from '../../src/infra/redis/cache.js';
import { createStore } from '../../src/infra/store/index.js';
import { createChSummaryBuilder, hourId } from '../../src/modules/pa/ch-summary.js';
import { createSummary, mergeSummaries } from '../../src/modules/pa/core/palog.js';
import { createEventSummary, mergeEventSummaries } from '../../src/modules/pa-events/core/paevents.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createFakeReader, trafficRecord, type FakeReader } from '../fixtures/fake-ch.js';
import { createTestApp, type TestApp } from '../helpers.js';

const silent = { info() {}, warn() {} };
/** 2026-11-11 00:00–02:59 每小時 50 筆 + 威脅 */
function sample() {
  const traffic = [];
  for (const h of ['00', '01', '02']) for (let i = 0; i < 50; i++) traffic.push(trafficRecord(`2026/11/11 ${h}:${String(i % 60).padStart(2, '0')}:00`, i, i === 7 ? { appSubcat: 'artificial-intelligence', app: 'openai-chatgpt', dst: '1.2.3.4' } : {}));
  const threats = [];
  for (let i = 0; i < 12; i++)
    threats.push({ type: 'threat' as const, rec: { time: `2026/11/11 01:${String(i).padStart(2, '0')}:00`, subtype: 'vulnerability', src: '1.1.1.1', dst: '10.10.1.1', action: 'alert', severity: i % 2 ? 'high' : 'low', name: `Test(${i % 3})`, dport: 443, proto: 'tcp', repeat: 2, app: 'ssl', rule: 'r', srcCountry: 'JP' } });
  return { traffic, threats };
}
/** 「現在」= 2026-11-11 03:10(2 點那一小時已結束 3 分鐘以上) */
const NOW = Date.parse('2026-11-11T03:10:00+08:00');
const HOUR = 3600_000;

describe('config(C3)', () => {
  const base = { GW_ENV: 'dev', SERVICE_CODE: 'netops-api', GW_JWKS_URL: 'http://127.0.0.1/jwks' };
  it('預設:dev 可以沒有 ClickHouse;每小時摘要 30 天、5 分鐘;對帳 01:00', () => {
    const c = loadConfig(base);
    assert.equal(c.clickhouse, null);
    assert.deepEqual(c.chSummary, { days: 30, minutes: 5 });
    assert.equal(c.reconHour, 1);
  });
  it('有 CLICKHOUSE_URL 時密碼必填;帳號預設 netops_reader;URL 不可帶帳密', () => {
    assert.throws(() => loadConfig({ ...base, CLICKHOUSE_URL: 'http://ch:8123' }), /CLICKHOUSE_PASSWORD_FILE/);
    assert.equal(loadConfig({ ...base, CLICKHOUSE_URL: 'http://ch:8123', CLICKHOUSE_PASSWORD: 'x' }).clickhouse!.user, 'netops_reader');
    assert.throws(() => loadConfig({ ...base, CLICKHOUSE_URL: 'http://a:b@ch:8123', CLICKHOUSE_PASSWORD: 'x' }), /不可帶帳密/);
  });
  it('test / prod 必須設定 CLICKHOUSE_URL(PA 查詢只用 ClickHouse)', () => {
    const t = { ...base, GW_ENV: 'test', GW_BASE_URL: 'http://gw', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://netops-api:51292', NETOPS_DATA_DIR: '/data', FTP_HOST: 'ftp', FTP_USER: 'u', FTP_PASSWORD: 'p', REDIS_URL: 'redis://r:6379/0' };
    assert.throws(() => loadConfig(t), /CLICKHOUSE_URL/);
    assert.equal(loadConfig({ ...t, CLICKHOUSE_URL: 'http://ch:8123', CLICKHOUSE_PASSWORD: 'x' }).clickhouse!.url, 'http://ch:8123');
  });
});

describe('ClickHouse reader(HTTP)', () => {
  type Req = { url: URL; init: RequestInit };
  const make = (respond: (r: Req) => Response) => {
    const reqs: Req[] = [];
    const reader = createClickHouseReader({ url: 'http://ch:8123', user: 'netops_reader', password: 'pw' }, (async (url: URL, init: RequestInit) => {
      reqs.push({ url, init });
      return respond({ url, init });
    }) as unknown as typeof fetch);
    return { reader, reqs };
  };

  it('帳密放標頭不放 URL;條件用 param_*;不跟隨轉址;帶執行秒數上限', async () => {
    const { reader, reqs } = make(() => new Response('{"h":1794358800,"action":"allow","n":3,"b":10}\n'));
    const r = await reader.trafficHours(1794358800_000, 1794362400_000);
    assert.deepEqual(r, [{ hour: 1794358800_000, action: 'allow', n: 3, bytes: 10 }]);
    const { url, init } = reqs[0]!;
    assert.equal(url.searchParams.get('param_from'), '1794358800');
    assert.equal(url.searchParams.get('param_to'), '1794362400');
    assert.ok(Number(url.searchParams.get('max_execution_time')) <= 50);
    assert.ok(!url.href.includes('pw') && !url.username);
    assert.equal((init.headers as Record<string, string>)['X-ClickHouse-Key'], 'pw');
    assert.equal(init.redirect, 'error');
    assert.match(String(init.body), /FROM netops\.pa_traffic_hourly_app[\s\S]*\{from:UInt32\}/);
  });

  it('HTTP 錯誤 → ClickHouseError(代碼來自標頭,訊息只留第一行)', async () => {
    const { reader } = make(() => new Response('Code: 241. DB::Exception: Memory limit\nsecret line', { status: 500, headers: { 'x-clickhouse-exception-code': '241' } }));
    await assert.rejects(reader.trafficHours(0, 1), (e: unknown) => e instanceof ClickHouseError && e.code === 241 && !e.message.includes('secret'));
  });

  it('連不上 → ClickHouseError', async () => {
    const reader = createClickHouseReader({ url: 'http://ch:8123', user: 'u', password: 'p' }, (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch);
    await assert.rejects(reader.ping(), /ECONNREFUSED/);
  });

  it('原始 log 依每分鐘筆數切段(每段 ≤ SLICE_ROWS),逐列轉成核心紀錄;中途錯誤要丟出', async () => {
    const t0 = 1794358800;
    const big = Math.ceil(SLICE_ROWS * 0.6);
    // 假 ClickHouse:每分鐘 / 每秒筆數照 minutes、seconds 回;資料查詢回該時間段應有的筆數
    const fake = (minutes: [number, number][], seconds: [number, number][] = [], short = 0) =>
      make(({ url, init }) => {
        const sql = String(init.body);
        const from = Number(url.searchParams.get('param_from'));
        const to = Number(url.searchParams.get('param_to'));
        const pick = (xs: [number, number][]) => xs.filter(([m]) => m >= from - 59 && m < to).map(([m, n]) => `{"m":${m},"n":${n}}`).join('\n');
        if (sql.includes('toStartOfMinute')) return new Response(pick(minutes) + '\n');
        if (sql.includes('count() AS n')) return new Response(pick(seconds) + '\n');
        const n = [...minutes, ...seconds].filter(([m, c]) => m >= from && m < to && (c <= SLICE_ROWS || !seconds.length)).reduce((s, [, c]) => s + c, 0);
        return new Response('["2026/11/11 09:00:00","end","10.1.1.1"]\n'.repeat(Math.max(n - short, 0)));
      });
    const dataSlices = (reqs: { url: URL; init: RequestInit }[]) =>
      reqs.filter((r) => !String(r.init.body).includes('count() AS n')).map((r) => [Number(r.url.searchParams.get('param_from')) - t0, Number(r.url.searchParams.get('param_to')) - t0]);

    const { reader, reqs } = fake([[t0, big], [t0 + 60, big], [t0 + 120, 10]]);
    const rows: Record<string, unknown>[] = [];
    const n = await reader.trafficRecords(t0 * 1000, (t0 + 3600) * 1000, (r) => rows.push(r));
    // 第一段只有第 1 分鐘;第 2、3 分鐘合成第二段
    assert.deepEqual(dataSlices(reqs), [[0, 60], [60, 3600]]);
    assert.equal(n, big * 2 + 10);
    assert.equal(rows[0]!.time, '2026/11/11 09:00:00');
    assert.equal(rows[0]!.src, '10.1.1.1');

    const bad = make(({ init }) =>
      String(init.body).includes('toStartOfMinute') ? new Response(`{"m":${t0},"n":5}\n`) : new Response('["2026/11/11 09:00:00"]\nCode: 241. DB::Exception: Memory limit exceeded\n'),
    );
    await assert.rejects(bad.reader.trafficRecords(t0 * 1000, (t0 + 3600) * 1000, () => {}), (e: unknown) => e instanceof ClickHouseError && e.code === 241 && !e.message.includes('Memory'));
  });

  it('讀到的筆數比分段時少(連線截斷)要丟出,不能當成完整', async () => {
    const t0 = 1794358800;
    const { reader } = make(({ init }) =>
      String(init.body).includes('toStartOfMinute') ? new Response(`{"m":${t0},"n":5}\n`) : new Response('["2026/11/11 09:00:00"]\n'.repeat(3)),
    );
    await assert.rejects(reader.trafficRecords(t0 * 1000, (t0 + 3600) * 1000, () => {}), /不完整/);
  });

  it('單一分鐘超過 SLICE_ROWS 時改看每秒切段', async () => {
    const t0 = 1794358800;
    const half = Math.ceil(SLICE_ROWS * 0.6);
    const reqs: string[][] = [];
    const reader = createClickHouseReader({ url: 'http://ch:8123', user: 'u', password: 'p' }, (async (url: URL, init: RequestInit) => {
      const sql = String(init.body);
      if (sql.includes('toStartOfMinute')) return new Response(`{"m":${t0},"n":${half * 2}}\n`);
      if (sql.includes('count() AS n')) return new Response(`{"m":${t0},"n":${half}}\n{"m":${t0 + 30},"n":${half}}\n`);
      reqs.push([url.searchParams.get('param_from')!, url.searchParams.get('param_to')!]);
      return new Response('[1]\n'.repeat(half));
    }) as unknown as typeof fetch);
    assert.equal(await reader.trafficRecords(t0 * 1000, (t0 + 3600) * 1000, () => {}), half * 2);
    assert.deepEqual(reqs, [[String(t0), String(t0 + 30)], [String(t0 + 30), String(t0 + 3600)]]);
  });

  it('字串參數跳脫反斜線與換行', async () => {
    const { reader, reqs } = make(({ init }) => (String(init.body).includes('toStartOfMinute') ? new Response('') : new Response('')));
    await reader.threatRecords('threat', 0, 3600_000, () => {});
    assert.equal(reqs[0]!.url.searchParams.get('param_type'), 'threat');
  });
});

describe('儀表板快取', () => {
  it('第二次讀快取;TTL 不超過 60 秒;Redis 異常時直接計算', async () => {
    const kv = new Map<string, string>();
    const sets: number[] = [];
    const c = createDashboardCache({ get: async (k) => kv.get(k) ?? null, set: async (k, v, _m, s) => (kv.set(k, v), sets.push(s)), quit: async () => 0 });
    let n = 0;
    assert.equal(await c.cached('pa-overview', { a: 1 }, 600, async () => ++n), 1);
    assert.equal(await c.cached('pa-overview', { a: 1 }, 600, async () => ++n), 1);
    assert.deepEqual(sets, [60]);
    const broken = createDashboardCache({ get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, quit: async () => 0 });
    assert.equal(await broken.cached('pa-overview', {}, 60, async () => 'v'), 'v');
    assert.throws(() => cacheKey('bad name', {}), /不合法/);
    assert.match(cacheKey('pa-overview', { a: 1 }), /^netops:cache:pa-overview:[0-9a-f]{24}$/);
  });
});

describe('每小時摘要', () => {
  let dir: string;
  let reader: FakeReader;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ch-'));
    const s = sample();
    reader = createFakeReader(s.traffic, s.threats);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('只建已結束的小時;摘要 = 核心直接算的結果;筆數變了才重建;超出範圍清除', async () => {
    const store = createStore(dir);
    let now = NOW;
    const b = createChSummaryBuilder({ reader, store: store.pa, log: silent, days: 1, minutes: 0, now: () => now });
    await b.runOnce();
    assert.equal(b.status().lastError, null);
    assert.equal(b.earliest(), Date.parse('2026-11-11T00:00:00+08:00'));
    const from = Date.parse('2026-11-11T00:00:00+08:00');
    const r = await b.summaries('traffic', from, from + 86_400_000);
    assert.equal(r.list.length, 3);
    assert.equal(r.missing, 0);
    // 合併結果 = 用核心直接對所有紀錄算的摘要再合併
    const direct = createSummary();
    for (const x of reader.traffic) direct.add(x as never);
    // files 是摘要份數(3 小時 vs 1 份),其他欄位要完全相同
    assert.deepEqual({ ...mergeSummaries(r.list, 20), files: 0 }, { ...mergeSummaries([direct.result()], 20), files: 0 });
    const ev = createEventSummary('threat');
    for (const x of reader.threats) ev.add(x.rec as never);
    assert.deepEqual(mergeEventSummaries('threat', (await b.summaries('threat', from, from + 86_400_000)).list, 20).tops, mergeEventSummaries('threat', [ev.result()], 20).tops);

    // 2 點晚到一筆:下一輪重建那一小時;重建前 missing = 1
    reader.traffic.push(trafficRecord('2026/11/11 02:59:59', 99));
    const calls = reader.calls.length;
    await b.runOnce();
    assert.equal(reader.calls.slice(calls).filter((c) => c === 'trafficRecords').length, 1);
    assert.equal((await b.summaries('traffic', from, from + 86_400_000)).missing, 0);

    // 進行中的小時(3 點)不建
    reader.traffic.push(trafficRecord('2026/11/11 03:05:00', 1));
    await b.runOnce();
    assert.equal((await b.summaries('traffic', from, from + 86_400_000)).list.length, 3);

    // 兩天後:超出 days=1 → 清除
    now = NOW + 2 * 86_400_000;
    await b.runOnce();
    assert.equal((await b.summaries('traffic', from, from + 86_400_000)).list.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'palogs/ch/traffic')), []);
  });

  it('ClickHouse 失敗只記錄,不丟出', async () => {
    const r = createFakeReader();
    r.failing = true;
    const b = createChSummaryBuilder({ reader: r, store: createStore(dir).pa, log: silent, days: 1, minutes: 0, now: () => NOW });
    await b.runOnce();
    // 日誌與狀態只留分類,不留 ClickHouse 原文
    assert.match(b.status().lastError!, /更新失敗/);
    // 還沒成功跑完一輪:state not-ready(呼叫端標示排行不完整,不回看起來正常的空結果)
    assert.equal((await b.summaries('traffic', 0, HOUR)).state, 'not-ready');
  });

  it('太久沒成功跑完一輪就視為過期;單一小時失敗不影響其他小時', async () => {
    const s = sample();
    const r = createFakeReader(s.traffic, s.threats);
    let now = NOW;
    const b = createChSummaryBuilder({ reader: r, store: createStore(fs.mkdtempSync(path.join(dir, 'x-'))).pa, log: silent, days: 1, minutes: 5, now: () => now });
    // 1 點那一小時讀取失敗:其他小時照建,1 點算 missing,30 分鐘內不重試
    const orig = r.trafficRecords;
    r.trafficRecords = async (from, to, onRow, sig) => {
      if (from === Date.parse('2026-11-11T01:00:00+08:00')) throw new ClickHouseError('boom', 396, 200);
      return orig(from, to, onRow, sig);
    };
    await b.runOnce();
    const from = Date.parse('2026-11-11T00:00:00+08:00');
    const res = await b.summaries('traffic', from, from + 86_400_000);
    assert.equal(res.list.length, 2);
    assert.equal(res.missing, 1);
    assert.equal(b.status().failed, 1);
    const before = r.calls.filter((c) => c === 'trafficRecords').length;
    await b.runOnce();
    assert.equal(r.calls.filter((c) => c === 'trafficRecords').length, before);
    assert.equal(res.state, 'ok');
    // ClickHouse 停了 20 分鐘(> 3 輪):state stale
    r.failing = true;
    now += 20 * 60_000;
    await b.runOnce();
    assert.equal((await b.summaries('traffic', from, from + 86_400_000)).state, 'stale');
  });

  it('摘要代號是台灣時間 YYYYMMDDHH', () => assert.equal(hourId(Date.parse('2026-11-11T09:30:00+08:00')), '2026111109'));
});

describe('總覽 API(只查 ClickHouse)', () => {
  let t: TestApp;
  let reader: FakeReader;
  before(async () => {
    const s = sample();
    reader = createFakeReader(s.traffic, s.threats);
    // 背景排程關掉(minutes 0),手動跑一輪;「現在」固定在資料之後
    t = await createTestApp({ ftp: createFakeFtp(), chReader: reader, chNow: () => NOW, env: { NETOPS_CH_SUMMARY_MINUTES: '0' } });
    await t.app.chSummary!.runOnce();
  });
  after(async () => t.close());

  it('總覽:source clickhouse;筆數與每小時統計來自彙總、排行到 topsUntil;coverage 為有資料的範圍', async () => {
    const res = await t.call({ url: '/v1/pa/overview?from=2026-11-11&top=5' });
    assert.equal(res.statusCode, 200, res.body);
    const b = res.json();
    assert.equal(b.source, 'clickhouse');
    assert.equal(b.files, 3);
    assert.equal(b.rows, 150);
    assert.equal(b.allow + b.block, 150);
    assert.equal(b.hours.length, 3);
    assert.equal(b.hours[0].hour, '2026-11-11T00:00:00+08:00');
    assert.equal(b.top.src.length, 5);
    assert.ok(b.top.aiApp.some((x: { key: string }) => x.key === 'openai-chatgpt'));
    assert.equal(b.topsUntil, '2026-11-11T03:00:00+08:00');
    assert.equal(b.topsState, 'ok');
    assert.deepEqual(b.coverage, { from: '2026-11-11', to: '2026-11-11' });
    assert.equal(b.partial, false);
    assert.match(b.timeMin, /\+08:00$/);
  });

  it('期間有一部分在資料之前:partial;整個超過保留期限:404 NETOPS_PA_OUT_OF_RETENTION(不回 0)', async () => {
    const p = (await t.call({ url: '/v1/pa/overview?from=2026-11-10&to=2026-11-11' })).json();
    assert.equal(p.partial, true);
    assert.equal(p.rows, 150);
    const old = await t.call({ url: '/v1/pa/overview?from=2026-10-01&to=2026-10-02' });
    assert.equal(old.statusCode, 404);
    assert.equal(old.json().code, 'NETOPS_PA_OUT_OF_RETENTION');
    assert.match(old.json().message, /2026-11-11/);
    const ev = await t.call({ url: '/v1/pa-events/overview?type=threat&from=2026-10-01' });
    assert.equal(ev.json().code, 'NETOPS_PA_OUT_OF_RETENTION');
  });

  it('有資料的日期與類型清單來自 ClickHouse;source 只接受 clickhouse', async () => {
    const d = (await t.call({ url: '/v1/pa/days' })).json();
    assert.deepEqual(d.days, [{ day: '2026-11-11', files: 3, rows: 150 }]);
    assert.deepEqual(d.coverage, { from: '2026-11-11', to: '2026-11-11' });
    const types = (await t.call({ url: '/v1/pa-events/types' })).json().types;
    const threat = types.find((x: { type: string }) => x.type === 'threat');
    assert.equal(threat.source, 'clickhouse');
    assert.deepEqual(threat.days, ['2026-11-11']);
    assert.equal((await t.call({ url: '/v1/pa/overview?from=2026-11-11&source=clickhouse' })).statusCode, 200);
    assert.equal((await t.call({ url: '/v1/pa/overview?from=2026-11-11&source=ftp' })).statusCode, 400);
  });

  it('篩選選項與威脅類總覽查 ClickHouse;User-ID 不進 ClickHouse,仍是 FTP', async () => {
    const o = (await t.call({ url: '/v1/pa/options?from=2026-11-11' })).json();
    assert.deepEqual(o.apps, ['dns-base', 'openai-chatgpt', 'ssl']);
    assert.deepEqual(o.rules, ['Allow-Web']);
    const ev = (await t.call({ url: '/v1/pa-events/overview?type=threat&from=2026-11-11' })).json();
    assert.equal(ev.source, 'clickhouse');
    assert.equal(ev.rows, 24); // 12 筆 × Repeat Count 2
    assert.equal(ev.hours[0].hour, '2026-11-11T01:00:00+08:00');
    const uid = await t.call({ url: '/v1/pa-events/overview?type=userid&from=2026-11-11' });
    assert.equal(uid.json().source, 'ftp');
  });

  it('ClickHouse 失敗回 503(不改用 FTP),回應不含錯誤原文', async () => {
    reader.failing = true;
    try {
      const res = await t.call({ url: '/v1/pa/overview?from=2026-11-11&top=8' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
      assert.ok(!res.body.includes('ECONNREFUSED'));
    } finally {
      reader.failing = false;
    }
  });

  it('摘要還沒建好:總覽仍回筆數,topsState not-ready、排行為空', async () => {
    const t2 = await createTestApp({ ftp: createFakeFtp(), chReader: createFakeReader(sample().traffic), chNow: () => NOW, env: { NETOPS_CH_SUMMARY_MINUTES: '0' } });
    try {
      const b = (await t2.call({ url: '/v1/pa/overview?from=2026-11-11' })).json();
      assert.equal(b.rows, 150);
      assert.equal(b.topsState, 'not-ready');
      assert.equal(b.topsUntil, '');
    } finally {
      await t2.close();
    }
  });
});
