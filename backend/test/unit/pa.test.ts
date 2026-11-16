/**
 * B2 PA 搬移(IMPL-PLAN B2 完成條件):以同一批假 log 比對舊版與新版的摘要,結果必須完全一致(SUMMARY_VERSION 不變)
 *   - 核心 JS(palog.js、paevents.js)與舊版 server/lib 逐字相同
 *   - 匯入後存下的 TRAFFIC 摘要、其他類型摘要、連線組合統計 = 舊版程式對同一個檔案算出的結果
 *   - 總覽 API = 舊版 mergeSummaries 的結果(只有時間改 ISO 8601)
 *   - FTP Log 檔案 API 的行為(分析、狀態、刪除分析結果、路徑限制、傳輸不完整)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { SUMMARY_VERSION } from '../../src/modules/pa/core/palog.js';
import { createFakeFtp, type FakeFtp } from '../fixtures/fake-ftp.js';
import { gz, threatCsv, trafficCsv } from '../fixtures/fake-logs.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = path.resolve(here, '../../../server/lib');
const NEW_CORE = path.resolve(here, '../../src/modules');
// 舊版核心只用 node 內建模組,可直接載入比對
const legacy = async (name: string) => import(pathToFileURL(path.join(LEGACY, name)).href);
const text = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 假 FTP 上的檔案(TRAFFIC 在根目錄、威脅在 /threat) */
const FILES = {
  '/PA-560_traffic_2026_11_02_last_calendar_day_0.csv': trafficCsv('2026/11/01', 3000, 1),
  '/PA-560_traffic_2026_11_03_last_calendar_day_0.csv.gz': trafficCsv('2026/11/02', 2500, 2),
  '/PA-560_traffic_2026_11_03_last_calendar_day_1.csv': trafficCsv('2026/11/02', 800, 3),
  '/threat/PA-560_threat_2026_11_02_last_calendar_day_0.csv': threatCsv('2026/11/01', 1200, 4),
};
const TRAFFIC = Object.keys(FILES).filter((p) => !p.startsWith('/threat/'));
const MODIFIED = '2026-11-03T00:05:00.000Z';
/** 舊版與新版讀同一個假 FTP 串流(同樣的分段方式) */
const stream = async (p: string) => (await ftp.openStream(p)).stream;

let t: TestApp;
let ftp: FakeFtp;
const data = (p: string) => (p.endsWith('.gz') ? gz(FILES[p as keyof typeof FILES]) : Buffer.from(FILES[p as keyof typeof FILES]));

before(async () => {
  ftp = createFakeFtp();
  for (const p of Object.keys(FILES)) ftp.put(p, data(p));
  t = await createTestApp({ ftp });
  const items = Object.keys(FILES).map((p) => ({ path: p, size: ftp.files.get(p)!.data.length, modified: MODIFIED }));
  const res = await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().added, 4);
  await waitFor(async () => {
    const s = (await t.call({ url: '/v1/ftp/pa/status' })).json();
    return !s.traffic.busy && !s.events.busy;
  });
});

after(async () => t.close());

const index = () => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'palogs/index.json'), 'utf8')).files;
const evIndex = () => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'palogs/events/index.json'), 'utf8')).files;
const strip = ({ analyzedAt: _a, ...rest }: Record<string, unknown>) => rest;

describe('核心邏輯與舊版相同(D4,搬移不改研判)', () => {
  it('palog.js、paevents.js 與舊版 server/lib 逐字相同', () => {
    assert.equal(text(path.join(NEW_CORE, 'pa/core/palog.js')), text(path.join(LEGACY, 'palog.js')));
    assert.equal(text(path.join(NEW_CORE, 'pa-events/core/paevents.js')), text(path.join(LEGACY, 'paevents.js')));
    assert.equal(SUMMARY_VERSION, 4);
  });
});

describe('同一批假 log:舊版與新版摘要完全一致', () => {
  it('TRAFFIC 摘要', async () => {
    const { createSummary, readLog } = await legacy('palog.js');
    const idx = index();
    for (const p of TRAFFIC) {
      const st = idx[p];
      assert.equal(st.status, 'done', `${p}:${st.error}`);
      assert.equal(st.v, 4);
      const sum = createSummary();
      const { bad } = await readLog(await stream(p), path.posix.basename(p), (r: unknown) => sum.add(r));
      const expected = { file: p, name: path.posix.basename(p), size: data(p).length, modified: MODIFIED, bad, ...sum.result() };
      const actual = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'palogs/summaries', st.summary), 'utf8'));
      assert.deepEqual(strip(actual), strip(expected as Record<string, unknown>), p);
      assert.ok(actual.rows > 0);
    }
  });

  it('連線組合統計(舊版 flows.js 原封不動執行,寫檔位置改到暫存目錄)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-legacy-flows-'));
    try {
      // 舊版 flows.js 只有 config.dataDir 依賴設定檔:換成暫存目錄後以 data: URL 載入
      const src = text(path.join(LEGACY, 'flows.js')).replace("import { config } from '../config.js'", `const config = { dataDir: ${JSON.stringify(tmp)} }`);
      const legacyFlows = await import(`data:text/javascript,${encodeURIComponent(src)}`);
      const { readLog } = await legacy('palog.js');
      const idx = index();
      for (const p of TRAFFIC) {
        const st = idx[p];
        const f = legacyFlows.createFlowStats();
        await readLog(await stream(p), path.posix.basename(p), (r: unknown) => f.add(r));
        const r = f.save(st.flows);
        assert.equal(st.flowCount, r.flows);
        const expected = zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'flows', st.flows))).toString();
        const actual = zlib.gunzipSync(fs.readFileSync(path.join(t.dataDir, 'palogs/flows', st.flows))).toString();
        assert.equal(actual, expected, p);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('其他類型 log(威脅)摘要', async () => {
    const { readLog } = await legacy('palog.js');
    const { createEventSummary, EVENT_TYPES } = await legacy('paevents.js');
    const p = '/threat/PA-560_threat_2026_11_02_last_calendar_day_0.csv';
    const st = evIndex()[p];
    assert.equal(st.status, 'done', st.error);
    assert.equal(st.type, 'threat');
    const sum = createEventSummary('threat');
    const { bad } = await readLog(await stream(p), path.posix.basename(p), (r: unknown) => sum.add(r), { columns: EVENT_TYPES.threat.columns, numeric: EVENT_TYPES.threat.numeric });
    const expected = { file: p, name: path.posix.basename(p), size: data(p).length, modified: MODIFIED, bad, ...sum.result() };
    const actual = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(t.dataDir, 'palogs/events', st.summary))).toString());
    assert.deepEqual(strip(actual), strip(expected as Record<string, unknown>));
  });

  it('合併摘要 = 舊版 mergeSummaries(總覽改查 ClickHouse 後,每小時摘要仍用同一份核心合併)', async () => {
    const { mergeSummaries: legacyMerge } = await legacy('palog.js');
    const { mergeSummaries } = await import('../../src/modules/pa/core/palog.js');
    const sums = Object.values(index() as Record<string, { summary: string; timeMin: string }>)
      .sort((a, b) => a.timeMin.localeCompare(b.timeMin))
      .map((st) => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'palogs/summaries', st.summary), 'utf8')));
    const m = legacyMerge(sums, 15);
    assert.deepEqual(mergeSummaries(sums, 15), m);
    assert.ok(m.scan.some((s: { src: string }) => s.src === '203.0.113.66'), '假 log 的掃描來源要被找出來');
  });
});

describe('PA API(C3:只查 ClickHouse)', () => {
  it('沒有設定 ClickHouse 時總覽、日期、篩選選項回 503(不再改讀 FTP 摘要);日期格式錯誤仍回 400', async () => {
    for (const url of ['/v1/pa/days', '/v1/pa/overview?from=2026-11-01', '/v1/pa/options?from=2026-11-01']) {
      const res = await t.call({ url });
      assert.equal(res.statusCode, 503, url);
      assert.equal(res.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
    }
    const bad = await t.call({ url: '/v1/pa/overview?from=2026/11/01' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, 'VALIDATION_FAILED');
    // ftp / auto 已移除
    assert.equal((await t.call({ url: '/v1/pa/overview?from=2026-11-01&source=ftp' })).statusCode, 400);
  });

  it('沒有內部 Token 回 401', async () => {
    const res = await t.app.inject({ url: '/v1/pa/days' });
    assert.equal(res.statusCode, 401);
  });

  it('回應不含本機資料目錄的路徑或摘要檔名', async () => {
    const st = index()[TRAFFIC[0]!];
    for (const url of ['/v1/ftp/pa/files', '/v1/ftp/pa/status']) {
      const body = (await t.call({ url })).body;
      assert.ok(!body.includes(t.dataDir) && !body.includes(st.summary) && !body.includes('.tsv.gz'), url);
    }
  });
});

describe('FTP Log 檔案 API(PA)', () => {
  it('瀏覽 TRAFFIC 目錄:分析狀態與 ISO 時間', async () => {
    const res = (await t.call({ url: '/v1/ftp/pa/files' })).json();
    assert.equal(res.path, '/');
    assert.equal(res.type, '');
    assert.ok(res.eventDirs.some((d: { type: string }) => d.type === 'threat'));
    const f = res.items.find((x: { path: string }) => x.path === TRAFFIC[0]);
    assert.equal(f.state, 'done');
    assert.equal(f.isLog, true);
    assert.equal(f.day, '2026-11-01');
    assert.match(f.timeMin, /^2026-11-01T00:00:00\+08:00$/);
    assert.equal(res.items[0].dir, true, '資料夾在前');
  });

  it('瀏覽其他類型目錄', async () => {
    const res = (await t.call({ url: '/v1/ftp/pa/files?path=/threat' })).json();
    assert.equal(res.type, 'threat');
    assert.equal(res.items[0].state, 'done');
  });

  it('同步只加入新的檔案,回 202', async () => {
    ftp.put('/PA-560_traffic_2026_11_04_last_calendar_day_0.csv', trafficCsv('2026/11/03', 300, 9));
    const res = await t.call({ method: 'POST', url: '/v1/ftp/pa/syncs' });
    assert.equal(res.statusCode, 202);
    await waitFor(async () => {
      const s = (await t.call({ url: '/v1/ftp/pa/status' })).json();
      return !s.traffic.syncing && !s.traffic.busy && !s.events.syncing && !s.events.busy && s.traffic.lastSyncAt;
    });
    const s = (await t.call({ url: '/v1/ftp/pa/status' })).json();
    assert.equal(s.traffic.total, 1, '已分析的檔案不重複分析');
    assert.equal(s.traffic.lastSyncError, '');
    assert.equal(index()['/PA-560_traffic_2026_11_04_last_calendar_day_0.csv'].status, 'done');
  });

  it('傳輸不完整時標成 error,不當成已分析', async () => {
    const p = '/PA-560_traffic_2026_11_05_last_calendar_day_0.csv';
    ftp.put(p, trafficCsv('2026/11/04', 2000, 10));
    ftp.failNext = true;
    await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items: [{ path: p, size: ftp.files.get(p)!.data.length, modified: MODIFIED }] } });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
    assert.equal(index()[p].status, 'error');
    assert.match(index()[p].error, /FTP 傳輸不完整/);
    const f = (await t.call({ url: '/v1/ftp/pa/files' })).json().items.find((x: { path: string }) => x.path === p);
    assert.equal(f.state, 'error');
  });

  it('刪除分析結果:摘要與統計檔刪除,狀態回到 new;FTP 上的檔案不動', async () => {
    const p = TRAFFIC[2]!;
    const st = index()[p];
    const res = await t.call({ method: 'POST', url: '/v1/ftp/pa/result-deletions', payload: { paths: [p] } });
    assert.deepEqual(res.json(), { deleted: 1 });
    assert.equal(fs.existsSync(path.join(t.dataDir, 'palogs/summaries', st.summary)), false);
    assert.equal(fs.existsSync(path.join(t.dataDir, 'palogs/flows', st.flows)), false);
    assert.ok(ftp.files.has(p));
    const f = (await t.call({ url: '/v1/ftp/pa/files' })).json().items.find((x: { path: string }) => x.path === p);
    assert.equal(f.state, 'new');
  });

  it('標頭不對的檔案:標成 error 並中斷 FTP 傳輸,不影響後面的檔案', async () => {
    const bad = '/PA-560_traffic_bad_header.csv';
    const good = '/PA-560_traffic_2026_11_06_last_calendar_day_0.csv';
    ftp.put(bad, 'hello,world\n' + 'x,y\n'.repeat(200000));
    ftp.put(good, trafficCsv('2026/11/05', 200, 11));
    const before = ftp.aborted;
    const res = await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items: [{ path: bad }, { path: good }] } });
    assert.deepEqual(res.json(), { added: 2, skipped: 0 });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
    assert.equal(index()[bad].status, 'error');
    assert.match(index()[bad].error, /不是 PA 防火牆匯出的 CSV/);
    assert.ok(ftp.aborted > before, '讀取失敗要中斷傳輸');
    assert.equal(index()[good].status, 'done', '連線名額已釋放,下一個檔案照常分析');
  });

  it('只接受 TRAFFIC 與各類型目錄下的 log 檔;大小與時間以 FTP 為準,忽略呼叫端的值', async () => {
    ftp.put('/other/PA-560_traffic_x.csv', trafficCsv('2026/11/05', 10, 12));
    ftp.put('/notes.docx', 'x');
    const res = await t.call({
      method: 'POST',
      url: '/v1/ftp/pa/analyses',
      payload: { items: [{ path: '/other/PA-560_traffic_x.csv' }, { path: '/notes.docx' }, { path: '/not-on-ftp.csv' }, { path: TRAFFIC[0]!, size: 0, modified: 'garbage' }] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { added: 1, skipped: 3 });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
    assert.equal(index()[TRAFFIC[0]!].modified, MODIFIED);
    assert.equal(index()[TRAFFIC[0]!].size, ftp.files.get(TRAFFIC[0]!)!.data.length);
    assert.equal(index()['/other/PA-560_traffic_x.csv'], undefined);
  });

  it('取消:重複呼叫回 0', async () => {
    assert.deepEqual((await t.call({ method: 'DELETE', url: '/v1/ftp/pa/analyses' })).json(), { cancelled: 0 });
  });

  it('參數驗證:items 不可為空', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items: [] } });
    assert.equal(res.statusCode, 400);
  });
});

describe('FTP 根目錄限制', () => {
  it('超出 FTP_ROOT 回 403 NETOPS_FTP_PATH_FORBIDDEN', async () => {
    const f = createFakeFtp('/my-data');
    const a = await createTestApp({ ftp: f, env: { FTP_ROOT: '/my-data', FTP_THREAT_DIR: '-', FTP_URL_DIR: '-', FTP_DATA_FILTER_DIR: '-', FTP_WILDFIRE_DIR: '-', FTP_DECRYPTION_DIR: '-', FTP_GLOBALPROTECT_DIR: '-', FTP_USERID_DIR: '-', FTP_AD_DIR: '/my-data/AD' } });
    try {
      for (const req of [
        { url: '/v1/ftp/pa/files?path=/etc' },
        { method: 'POST' as const, url: '/v1/ftp/pa/analyses', payload: { items: [{ path: '/my-data/../etc/passwd' }] } },
        { method: 'POST' as const, url: '/v1/ftp/pa/result-deletions', payload: { paths: ['/x'] } },
      ]) {
        const res = await a.call(req);
        assert.equal(res.statusCode, 403, req.url);
        assert.equal(res.json().code, 'NETOPS_FTP_PATH_FORBIDDEN');
      }
    } finally {
      await a.close();
    }
  });

  it('dev 沒有設定 FTP 時回 503 NETOPS_FTP_NOT_CONFIGURED', async () => {
    const a = await createTestApp({ env: { FTP_HOST: '' } });
    try {
      const res = await a.call({ url: '/v1/ftp/pa/files' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'NETOPS_FTP_NOT_CONFIGURED');
    } finally {
      await a.close();
    }
  });
});
