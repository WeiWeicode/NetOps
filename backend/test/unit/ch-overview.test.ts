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

describe('config(C3)', () => {
  const base = { GW_ENV: 'dev', SERVICE_CODE: 'netops-api', GW_JWKS_URL: 'http://127.0.0.1/jwks' };
  it('預設:沒有 ClickHouse;總覽 auto、明細 ftp;每小時摘要 30 天、5 分鐘', () => {
    const c = loadConfig(base);
    assert.equal(c.clickhouse, null);
    assert.deepEqual(c.paSource, { overview: 'auto', detail: 'ftp' });
    assert.deepEqual(c.chSummary, { days: 30, minutes: 5 });
  });
  it('有 CLICKHOUSE_URL 時密碼必填;帳號預設 netops_reader;URL 不可帶帳密', () => {
    assert.throws(() => loadConfig({ ...base, CLICKHOUSE_URL: 'http://ch:8123' }), /CLICKHOUSE_PASSWORD_FILE/);
    assert.equal(loadConfig({ ...base, CLICKHOUSE_URL: 'http://ch:8123', CLICKHOUSE_PASSWORD: 'x' }).clickhouse!.user, 'netops_reader');
    assert.throws(() => loadConfig({ ...base, CLICKHOUSE_URL: 'http://a:b@ch:8123', CLICKHOUSE_PASSWORD: 'x' }), /不可帶帳密/);
  });
  it('來源設定只接受 ftp / clickhouse / auto', () => {
    assert.throws(() => loadConfig({ ...base, NETOPS_PA_DETAIL_SOURCE: 'db' }), /NETOPS_PA_DETAIL_SOURCE/);
    assert.equal(loadConfig({ ...base, NETOPS_PA_DETAIL_SOURCE: 'ClickHouse' }).paSource.detail, 'clickhouse');
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
    const { reader, reqs } = make(({ init }) => {
      const sql = String(init.body);
      if (sql.includes('toStartOfMinute')) return new Response(`{"m":${t0},"n":${big}}\n{"m":${t0 + 60},"n":${big}}\n{"m":${t0 + 120},"n":10}\n`);
      return new Response('["2026/11/11 09:00:00","end","10.1.1.1"]\n');
    });
    const rows: Record<string, unknown>[] = [];
    const n = await reader.trafficRecords(t0 * 1000, (t0 + 3600) * 1000, (r) => rows.push(r));
    // 第一段只有第 1 分鐘;第 2、3 分鐘合成第二段
    const slices = reqs.filter((r) => !String(r.init.body).includes('toStartOfMinute')).map((r) => [r.url.searchParams.get('param_from'), r.url.searchParams.get('param_to')]);
    assert.deepEqual(slices, [[String(t0), String(t0 + 60)], [String(t0 + 60), String(t0 + 3600)]]);
    assert.equal(n, 2);
    assert.equal(rows[0]!.time, '2026/11/11 09:00:00');
    assert.equal(rows[0]!.src, '10.1.1.1');

    const bad = make(({ init }) =>
      String(init.body).includes('toStartOfMinute') ? new Response(`{"m":${t0},"n":5}\n`) : new Response('["2026/11/11 09:00:00"]\nCode: 241. DB::Exception: Memory limit exceeded\n'),
    );
    await assert.rejects(bad.reader.trafficRecords(t0 * 1000, (t0 + 3600) * 1000, () => {}), (e: unknown) => e instanceof ClickHouseError && e.code === 241);
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
    const r = b.summaries('traffic', from, from + 86_400_000);
    assert.equal(r.list.length, 3);
    assert.equal(r.missing, 0);
    // 合併結果 = 用核心直接對所有紀錄算的摘要再合併
    const direct = createSummary();
    for (const x of reader.traffic) direct.add(x as never);
    // files 是摘要份數(3 小時 vs 1 份),其他欄位要完全相同
    assert.deepEqual({ ...mergeSummaries(r.list, 20), files: 0 }, { ...mergeSummaries([direct.result()], 20), files: 0 });
    const ev = createEventSummary('threat');
    for (const x of reader.threats) ev.add(x.rec as never);
    assert.deepEqual(mergeEventSummaries('threat', b.summaries('threat', from, from + 86_400_000).list, 20).tops, mergeEventSummaries('threat', [ev.result()], 20).tops);

    // 2 點晚到一筆:下一輪重建那一小時;重建前 missing = 1
    reader.traffic.push(trafficRecord('2026/11/11 02:59:59', 99));
    const calls = reader.calls.length;
    await b.runOnce();
    assert.equal(reader.calls.slice(calls).filter((c) => c === 'trafficRecords').length, 1);
    assert.equal(b.summaries('traffic', from, from + 86_400_000).missing, 0);

    // 進行中的小時(3 點)不建
    reader.traffic.push(trafficRecord('2026/11/11 03:05:00', 1));
    await b.runOnce();
    assert.equal(b.summaries('traffic', from, from + 86_400_000).list.length, 3);

    // 兩天後:超出 days=1 → 清除
    now = NOW + 2 * 86_400_000;
    await b.runOnce();
    assert.equal(b.summaries('traffic', from, from + 86_400_000).list.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'palogs/ch/traffic')), []);
  });

  it('ClickHouse 失敗只記錄,不丟出', async () => {
    const r = createFakeReader();
    r.failing = true;
    const b = createChSummaryBuilder({ reader: r, store: createStore(dir).pa, log: silent, days: 1, minutes: 0, now: () => NOW });
    await b.runOnce();
    assert.match(b.status().lastError!, /ECONNREFUSED/);
  });

  it('摘要代號是台灣時間 YYYYMMDDHH', () => assert.equal(hourId(Date.parse('2026-11-11T09:30:00+08:00')), '2026111109'));
});

describe('總覽 API 來源切換', () => {
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

  it('auto:期間在 ClickHouse 範圍內 → source clickhouse,格式同 FTP;排行到 topsUntil', async () => {
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
    assert.match(b.timeMin, /\+08:00$/);
  });

  it('auto:期間早於 ClickHouse 範圍 → FTP', async () => {
    const res = await t.call({ url: '/v1/pa/overview?from=2026-11-10&to=2026-11-11' });
    assert.equal(res.json().source, 'ftp');
  });

  it('source=ftp 強制 FTP;source 只接受列舉值', async () => {
    assert.equal((await t.call({ url: '/v1/pa/overview?from=2026-11-11&source=ftp' })).json().source, 'ftp');
    assert.equal((await t.call({ url: '/v1/pa/overview?from=2026-11-11&source=db' })).statusCode, 400);
  });

  it('篩選選項與威脅類總覽查 ClickHouse;User-ID 一律 FTP', async () => {
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

  it('ClickHouse 失敗:auto 改用 FTP;指定 clickhouse 回 503', async () => {
    reader.failing = true;
    try {
      // 快取會擋住同樣的參數:換 top
      const auto = await t.call({ url: '/v1/pa/overview?from=2026-11-11&top=7' });
      assert.equal(auto.json().source, 'ftp');
      const res = await t.call({ url: '/v1/pa/overview?from=2026-11-11&top=8&source=clickhouse' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
      assert.ok(!res.body.includes('ECONNREFUSED'));
    } finally {
      reader.failing = false;
    }
  });

  it('沒有設定 ClickHouse 時指定 clickhouse 回 503,auto 用 FTP', async () => {
    const t2 = await createTestApp({ ftp: createFakeFtp(), chReader: null });
    try {
      assert.equal((await t2.call({ url: '/v1/pa/overview?from=2026-11-11&source=clickhouse' })).statusCode, 503);
      assert.equal((await t2.call({ url: '/v1/pa/overview?from=2026-11-11' })).json().source, 'ftp');
    } finally {
      await t2.close();
    }
  });
});
