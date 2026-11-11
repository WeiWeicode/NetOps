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
