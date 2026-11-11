/**
 * B2 PA Log 明細查詢(工作模式,ARCHITECTURE D6):同一批假 log,舊版 scanFiles + buildFilter 與新版工作的結果一致;API 行為
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createFakeFtp, type FakeFtp } from '../fixtures/fake-ftp.js';
import { trafficCsv } from '../fixtures/fake-logs.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = path.resolve(here, '../../../server/lib');
const text = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const iso = (t: string) => `${t.replace(/\//g, '-').replace(' ', 'T')}+08:00`;

const FILES = {
  '/PA-560_traffic_2026_11_02_last_calendar_day_0.csv': trafficCsv('2026/11/01', 4000, 61),
  '/PA-560_traffic_2026_11_03_last_calendar_day_0.csv': trafficCsv('2026/11/02', 3000, 62),
};

let t: TestApp;
let ftp: FakeFtp;

/** 舊版 scan.js 原封不動執行:FTP 換成同一個假 FTP,palog 用絕對路徑 */
async function legacyScan() {
  (globalThis as { __netopsFakeOpen?: unknown }).__netopsFakeOpen = (p: string) => ftp.openStream(p);
  const src = text(path.join(LEGACY, 'scan.js'))
    .replace("import { openStream } from './ftp.js'", 'const openStream = (p) => globalThis.__netopsFakeOpen(p)')
    .replace("from './palog.js'", `from ${JSON.stringify(pathToFileURL(path.join(LEGACY, 'palog.js')).href)}`);
  return import(`data:text/javascript,${encodeURIComponent(src)}`);
}

before(async () => {
  ftp = createFakeFtp();
  for (const [p, d] of Object.entries(FILES)) ftp.put(p, d);
  t = await createTestApp({ ftp });
  await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items: Object.keys(FILES).map((p) => ({ path: p })) } });
  await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
});

after(async () => t.close());

const submit = async (payload: Record<string, unknown>, emp = 'S112009') => t.call({ method: 'POST', url: '/v1/pa/log-searches', payload, emp });
const finish = async (id: string, emp = 'S112009') => {
  await waitFor(async () => !['queued', 'running'].includes((await t.call({ url: `/v1/pa/log-searches/${id}`, emp })).json().status));
  return (await t.call({ url: `/v1/pa/log-searches/${id}`, emp })).json();
};
const range = { from: '2026-11-01T06:00:00+08:00', to: '2026-11-02T18:30:00+08:00' };

describe('核心邏輯與舊版相同', () => {
  it('scan.js 只把 openStream 改成由呼叫端注入,其餘與舊版逐字相同', () => {
    const legacy = text(path.join(LEGACY, 'scan.js'));
    const mine = text(path.resolve(here, '../../src/modules/pa/core/scan.js'));
    const expected = legacy
      .replace("import { openStream } from './ftp.js'\n", '')
      .replace(' *   onProgress({ filesScanned, files, rows })：每掃完一個檔案呼叫一次\n', ' *   onProgress({ filesScanned, files, rows })：每掃完一個檔案呼叫一次\n *   openStream(path)：開啟 FTP 串流（新版由呼叫端注入 infra/ftp，舊版直接 import lib/ftp.js；其餘不變）\n')
      .replace('onProgress = null }) {', 'onProgress = null, openStream }) {');
    assert.equal(mine, expected);
  });
});

describe('同一批假 log:舊版與新版明細結果一致', () => {
  it('條件篩選、排序、筆數上限', async () => {
    const { scanFiles } = await legacyScan();
    const { buildFilter, buildPrefilter, ROW_FIELDS } = await import(pathToFileURL(path.join(LEGACY, 'palog.js')).href);
    const idx = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'palogs/index.json'), 'utf8')).files;
    const files = Object.entries(idx as Record<string, { name: string; rows: number; timeMin: string }>)
      .map(([p, v]) => ({ path: p, ...v }))
      .sort((a, b) => a.timeMin.localeCompare(b.timeMin));
    for (const cond of [{ src: '10.10.1.*' }, { ip: '10.10.0.0/16', action: 'block' }, { port: '443,53', app: 'ssl' }, { q: 'dropbox', limit: 50 }, { rule: 'Internal "Core"' }]) {
      const limit = (cond as { limit?: number }).limit ?? 2000;
      const b = { ...cond, from: '2026/11/01 06:00', to: '2026/11/02 18:30' };
      const filter = buildFilter(b);
      const rows: unknown[][] = [];
      await scanFiles(files, {
        prefilter: buildPrefilter(b),
        parallel: 1,
        seconds: 60,
        onRow: (rec: Record<string, unknown>, raw: string) => {
          if (filter(rec, raw)) rows.push(ROW_FIELDS.map((k: string) => rec[k] ?? ''));
          if (rows.length >= limit) return false;
        },
      });
      rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      const expected = rows.slice(0, limit);

      const res = await submit({ ...range, ...cond });
      assert.equal(res.statusCode, 202, res.body);
      const job = await finish(res.json().id);
      assert.equal(job.status, 'done', JSON.stringify(job.error));
      assert.equal(job.result.total, expected.length, JSON.stringify(cond));
      assert.equal(job.result.rows, undefined, '狀態查詢不回傳資料列');
      const all = [];
      for (let page = 1; (page - 1) * 100 < job.result.total; page++) all.push(...(await t.call({ url: `/v1/pa/log-searches/${job.id}/rows?page=${page}&pageSize=100` })).json().items);
      assert.deepEqual(
        all,
        expected.map((r) => Object.fromEntries(ROW_FIELDS.map((k: string, i: number) => [k, i === 0 ? iso(String(r[i])) : r[i]]))),
        JSON.stringify(cond),
      );
      if ((cond as { limit?: number }).limit) assert.equal(job.result.stopReason, 'limit');
    }
  });
});

describe('PA Log 明細 API(IP 萬用字元)', () => {
  it('連續的 * 合併後與單一 * 結果相同,且很快完成', async () => {
    const a = await finish((await submit({ ...range, src: '10.10.*.5', limit: 100 })).json().id);
    const b = await finish((await submit({ ...range, src: '10.10.***.5', limit: 100 })).json().id);
    assert.equal(a.status, 'done');
    assert.equal(b.result.total, a.result.total);
  });
});

describe('PA Log 明細 API', () => {
  it('狀態:進度與摘要;匯出 CSV', async () => {
    const res = await submit({ ...range, src: '10.10.1.5', limit: 30 });
    const job = await finish(res.json().id);
    assert.deepEqual(Object.keys(job.result).sort(), ['files', 'filesScanned', 'from', 'limit', 'scanned', 'seconds', 'source', 'stopReason', 'to', 'total'].sort());
    assert.equal(job.result.from, '2026-11-01T06:00:00+08:00');
    assert.equal(job.result.files, 2);
    const csv = await t.call({ url: `/v1/pa/log-searches/${job.id}/export` });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /^text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /PA_log_202611010600_202611021830\.csv/);
    const lines = csv.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.ok(lines[0]!.startsWith('時間,類型,動作,來源 IP'));
    assert.equal(lines.length, job.result.total + 1);
    assert.match(lines[1]!, /^2026-11-0\dT\d\d:\d\d:\d\d\+08:00,/);
  });

  it('只有建立者本人可查、可取得結果;取消冪等', async () => {
    const { id } = (await submit({ ...range, src: '10.10.2.20' })).json();
    await finish(id);
    for (const url of [`/v1/pa/log-searches/${id}`, `/v1/pa/log-searches/${id}/rows`, `/v1/pa/log-searches/${id}/export`]) {
      const res = await t.call({ url, emp: 'S999999' });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.json().code, 'NETOPS_JOB_NOT_FOUND');
    }
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa/log-searches/${id}`, emp: 'S999999' })).statusCode, 204);
    assert.equal((await t.call({ url: `/v1/pa/log-searches/${id}` })).json().status, 'done', '別人取消不影響');
    for (let i = 0; i < 2; i++) assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa/log-searches/${id}` })).statusCode, 204);
    assert.equal((await t.call({ url: `/v1/pa/log-searches/${id}` })).statusCode, 404, '已完成的工作取消後丟棄結果');
  });

  it('執行中取消:狀態 cancelled,沒有結果', async () => {
    ftp.put('/PA-560_traffic_2026_11_04_last_calendar_day_0.csv', trafficCsv('2026/11/03', 60000, 63));
    await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items: [{ path: '/PA-560_traffic_2026_11_04_last_calendar_day_0.csv' }] } });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy, 30000);
    ftp.chunkDelayMs = 200;
    try {
      const aborted = ftp.aborted;
      const { id } = (await submit({ from: '2026-11-03T00:00:00+08:00', to: '2026-11-03T23:59:00+08:00', q: 'no-such-text' })).json();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa/log-searches/${id}` })).statusCode, 204);
      const job = await finish(id);
      assert.equal(job.status, 'cancelled');
      assert.equal((await t.call({ url: `/v1/pa/log-searches/${id}/rows` })).json().code, 'NETOPS_JOB_NOT_DONE');
      // FTP 傳輸已中斷、連線名額已釋放:下一個查詢照常完成
      await waitFor(() => ftp.aborted > aborted || ftp.opened > 0);
      ftp.chunkDelayMs = 0;
      const next = await finish((await submit({ ...range, src: '10.10.1.6', limit: 5 })).json().id);
      assert.equal(next.status, 'done');
    } finally {
      ftp.chunkDelayMs = 0;
    }
  });

  it('期間沒有資料回 404;超過 31 天、時間沒有時區、Port 格式錯誤回 400', async () => {
    const nd = await submit({ from: '2020-01-01T00:00:00+08:00', to: '2020-01-01T01:00:00+08:00' });
    assert.equal(nd.statusCode, 404);
    assert.equal(nd.json().code, 'NETOPS_PA_NO_DATA');
    for (const p of [{ from: '2026-09-01T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00' }, { from: '2026-11-01T00:00', to: '2026-11-02T00:00' }, { ...range, port: '443;rm' }, { ...range, limit: 999999 }, { ...range, src: '*'.repeat(10) + 'x' }, { ...range, ip: '1*2*3*4*5*6' }, { ...range, dst: 'a;b' }]) {
      assert.equal((await submit(p)).statusCode, 400, JSON.stringify(p));
    }
  });

  it('每人同時最多 2 個進行中的工作', async () => {
    const big = { from: '2026-11-03T00:00:00+08:00', to: '2026-11-03T23:59:00+08:00', q: 'no-such-text' };
    ftp.chunkDelayMs = 200;
    const ids: string[] = [];
    try {
      for (let i = 0; i < 2; i++) ids.push((await submit(big, 'S777777')).json().id);
      const third = await submit(big, 'S777777');
      assert.equal(third.statusCode, 409);
      assert.equal(third.json().code, 'NETOPS_JOB_LIMIT_EXCEEDED');
    } finally {
      for (const id of ids) await t.call({ method: 'DELETE', url: `/v1/pa/log-searches/${id}`, emp: 'S777777' });
      ftp.chunkDelayMs = 0;
    }
  });
});
