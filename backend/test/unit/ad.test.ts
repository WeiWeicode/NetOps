/**
 * B2 AD 與安全事件搬移(IMPL-PLAN B2):以同一批假匯出檔比對舊版與新版結果
 *   - 核心 adlog.js 與舊版 server/lib 逐字相同
 *   - 匯入後的事件 = 舊版 parseAdCsv + 去重 + 排序;總覽 = 舊版 summarizeAd(時間改 ISO)
 *   - 明細查詢(分頁)、匯出 CSV、FTP 清單工作(本人才能查)、重新匯入、刪除、orphan
 *   - 安全事件總覽 = 舊版 mergeEventSummaries
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { securityCsv, systemCsv, utf16 } from '../fixtures/fake-ad.js';
import { createFakeFtp, type FakeFtp } from '../fixtures/fake-ftp.js';
import { threatCsv } from '../fixtures/fake-logs.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = path.resolve(here, '../../../server/lib');
const legacy = async (name: string) => import(pathToFileURL(path.join(LEGACY, name)).href);
const text = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const iso = (t: string) => (t ? `${t.replace(/\//g, '-').replace(' ', 'T')}${t.length === 13 ? ':00:00' : ''}+08:00` : '');

/** 舊版 adimport.js importDay 的解析、去重與排序(同一段程式) */
async function legacyDay(files: [string, Buffer][]) {
  const { parseAdCsv, enrichEvent } = await legacy('adlog.js');
  const decode = (buf: Buffer) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
  const events: { computer: string; channel: string; recordId: string; time: string }[] = [];
  for (const [name, buf] of files) events.push(...parseAdCsv(decode(buf), name));
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const k = `${e.computer}|${e.channel}|${e.recordId}`;
    if (!e.recordId || !seen.has(k)) return seen.add(k), true;
    return false;
  });
  unique.sort((a, b) => b.time.localeCompare(a.time));
  return unique.map(enrichEvent) as { time: string; recordId: string }[];
}

const AD = '/AD_Log_Backup';
const DAY1: [string, Buffer][] = [
  ['Security_GSMC-DC1.csv', utf16(securityCsv('20261101', 1500, 21))],
  // 同一天舊檔名與新檔名同時存在:依主機 + 記錄 + 記錄編號去除重複
  ['Security.csv', Buffer.from(securityCsv('20261101', 300, 21))],
  ['System.csv', Buffer.from('﻿' + systemCsv('20261101', 200, 22))],
];
const DAY2: [string, Buffer][] = [['Security_GSMC-DC1.csv', utf16(securityCsv('20261102', 800, 23))]];

let t: TestApp;
let ftp: FakeFtp;

before(async () => {
  ftp = createFakeFtp();
  for (const [n, b] of DAY1) ftp.put(`${AD}/20261101/${n}`, b);
  for (const [n, b] of DAY2) ftp.put(`${AD}/20261102/${n}`, b);
  ftp.put(`${AD}/README.txt`, 'not a day');
  t = await createTestApp({ ftp });
  const res = await t.call({ method: 'POST', url: '/v1/ftp/ad/syncs' });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().running, true);
  await waitFor(async () => !(await t.call({ url: '/v1/ftp/ad/status' })).json().running);
});

after(async () => t.close());

const stored = (day: string) => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'adlogs', `${day}.json`), 'utf8'));
const range = 'from=2026-11-01T00:00:00%2B08:00&to=2026-11-02T23:59:00%2B08:00';

describe('核心邏輯與舊版相同', () => {
  it('adlog.js 與舊版 server/lib 逐字相同', () => {
    assert.equal(text(path.resolve(here, '../../src/modules/ad/core/adlog.js')), text(path.join(LEGACY, 'adlog.js')));
  });
});

describe('同一批假匯出檔:舊版與新版結果完全一致', () => {
  it('匯入的事件(UTF-16 / UTF-8、跨行訊息、去除重複)', async () => {
    const s = (await t.call({ url: '/v1/ftp/ad/status' })).json();
    assert.equal(s.lastSyncError, '');
    assert.deepEqual(s.lastResult.imported.map((x: { day: string }) => x.day).sort(), ['2026-11-01', '2026-11-02']);
    const { enrichEvent } = await legacy('adlog.js');
    for (const [day, files] of [['20261101', DAY1], ['20261102', DAY2]] as const) {
      const actual = stored(day).events.map(enrichEvent);
      assert.deepEqual(actual, await legacyDay([...files]), day);
    }
    assert.equal(stored('20261101').events.length, 1502 + 200, '舊檔名的 300 筆是重複的');
  });

  it('總覽 = 舊版 summarizeAd', async () => {
    const { summarizeAd } = await legacy('adlog.js');
    const all = [...(await legacyDay([...DAY1])), ...(await legacyDay([...DAY2]))].sort((a, b) => b.time.localeCompare(a.time));
    const m = summarizeAd(all);
    const o = (await t.call({ url: '/v1/ad/overview?from=2026-11-01&to=2026-11-02' })).json();
    for (const k of ['total', 'byChannel', 'byLevel', 'failAccounts', 'failIps', 'failReasons', 'privilegedChanges', 'accountsCreated', 'privLogons']) assert.deepEqual(o[k], m[k], k);
    assert.equal(o.days, 2);
    assert.equal(o.timeMin, iso(m.timeMin));
    assert.deepEqual(o.hours, m.hours.map((h: { hour: string }) => ({ ...h, hour: iso(h.hour) })));
    const span = (g: { first: string; last: string }) => ({ ...g, first: iso(g.first), last: iso(g.last) });
    assert.deepEqual(o.events, m.events.map(span));
    assert.deepEqual(o.issues, m.issues.map(span));
    assert.deepEqual(o.accountChanges, m.accountChanges.map((c: { time: string }) => ({ ...c, time: iso(c.time) })));
    assert.ok(o.accountChanges.some((c: { target: string; privileged: boolean }) => c.target === 'backdoor01' && c.privileged), '建立帳號後加入特權群組要標出');
  });

  it('明細查詢 = 舊版 buildAdFilter,分頁回傳', async () => {
    const { buildAdFilter } = await legacy('adlog.js');
    const all = [...(await legacyDay([...DAY1])), ...(await legacyDay([...DAY2]))].sort((a, b) => b.time.localeCompare(a.time));
    const expected = all.filter(buildAdFilter({ eventId: '4625,4771', account: 's112009' }));
    const p1 = (await t.call({ url: `/v1/ad/events?${range}&eventId=4625,4771&account=s112009&pageSize=100` })).json();
    assert.equal(p1.total, expected.length);
    assert.equal(p1.scanned, all.length);
    assert.equal(p1.items.length, Math.min(100, expected.length));
    assert.equal(p1.items[0].time, iso((expected[0] as { time: string }).time));
    const p2 = (await t.call({ url: `/v1/ad/events?${range}&eventId=4625,4771&account=s112009&pageSize=100&page=2` })).json();
    assert.equal(p2.items[0]?.recordId, (expected[100] as { recordId: string } | undefined)?.recordId);
    const issues = (await t.call({ url: `/v1/ad/events?${range}&issueOnly=true&pageSize=1` })).json();
    assert.equal(issues.total, all.filter(buildAdFilter({ issueOnly: true })).length);
  });
});

describe('AD API', () => {
  it('已匯入的日期與同步狀態', async () => {
    const d = (await t.call({ url: '/v1/ad/days' })).json();
    assert.deepEqual(d.days.map((x: { day: string }) => x.day), ['2026-11-02', '2026-11-01']);
    assert.equal(d.channels.Security, '安全性');
    assert.equal(d.import.running, false);
  });

  it('明細查詢:期間超過 31 天、時間沒有時區、事件 ID 格式錯誤回 400', async () => {
    for (const q of ['from=2026-09-01T00:00:00%2B08:00&to=2026-11-02T00:00:00%2B08:00', 'from=2026-11-01T00:00&to=2026-11-02T00:00', `${range}&eventId=abc`, `${range}&pageSize=101`]) {
      const res = await t.call({ url: `/v1/ad/events?${q}` });
      assert.equal(res.statusCode, 400, q);
    }
  });

  it('匯出 CSV:BOM、中文欄名、檔名;欄位開頭是 = 時加上 \'', async () => {
    const res = await t.call({ url: `/v1/ad/events/export?${range}&eventId=4720` });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/csv/);
    assert.match(String(res.headers['content-disposition']), /attachment; filename\*=UTF-8''AD_log_202611010000_202611022359\.csv/);
    assert.ok(res.body.startsWith('﻿時間,記錄,事件 ID,等級'));
    assert.equal(res.body.trim().split('\r\n').length, 3, '標頭 + 2 天各 1 筆 4720');
  });

  it('沒有內部 Token 回 401', async () => {
    assert.equal((await t.app.inject({ url: '/v1/ad/days' })).statusCode, 401);
  });
});

describe('FTP Log 檔案 API(AD)', () => {
  const listing = async (emp = 'S112009') => {
    const res = await t.call({ method: 'POST', url: '/v1/ftp/ad/listings', emp });
    assert.equal(res.statusCode, 202, res.body);
    const { id } = res.json();
    await waitFor(async () => ['done', 'failed'].includes((await t.call({ url: `/v1/ftp/ad/listings/${id}`, emp })).json().status));
    return { id, job: (await t.call({ url: `/v1/ftp/ad/listings/${id}`, emp })).json() };
  };

  it('清單工作:完成後列出日期資料夾與狀態;別人查不到;取消冪等', async () => {
    const { id, job } = await listing();
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.dir, AD);
    assert.deepEqual(job.result.days.map((d: { day: string; state: string }) => [d.day, d.state]), [['2026-11-02', 'done'], ['2026-11-01', 'done']]);
    assert.equal(job.result.days[1].files.length, 3);
    assert.equal((await t.call({ url: `/v1/ftp/ad/listings/${id}`, emp: 'S999999' })).statusCode, 404);
    for (let i = 0; i < 2; i++) assert.equal((await t.call({ method: 'DELETE', url: `/v1/ftp/ad/listings/${id}` })).statusCode, 204);
    assert.equal((await t.call({ method: 'DELETE', url: '/v1/ftp/ad/listings/6f1c0000-0000-4000-8000-000000000000' })).statusCode, 204);
    assert.equal((await t.call({ url: '/v1/ftp/ad/listings/not-a-uuid' })).statusCode, 400);
  });

  it('檔案變更後狀態為 changed;同步只重新匯入那一天', async () => {
    ftp.put(`${AD}/20261102/System.csv`, systemCsv('20261102', 50, 30));
    assert.equal((await listing()).job.result.days[0].state, 'changed');
    await t.call({ method: 'POST', url: '/v1/ftp/ad/syncs' });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/ad/status' })).json().running);
    const s = (await t.call({ url: '/v1/ftp/ad/status' })).json();
    assert.deepEqual(s.lastResult.imported, [{ day: '2026-11-02', events: 802 + 50 }]);
  });

  it('重新匯入(不比對);刪除匯入結果;FTP 上沒有資料夾的日期列為 orphan', async () => {
    const imp = await t.call({ method: 'POST', url: '/v1/ftp/ad/imports', payload: { days: ['2026-11-01'] } });
    assert.equal(imp.statusCode, 202);
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/ad/status' })).json().running);
    assert.deepEqual((await t.call({ url: '/v1/ftp/ad/status' })).json().lastResult.imported.map((x: { day: string }) => x.day), ['2026-11-01']);

    for (const n of DAY1) ftp.files.delete(`${AD}/20261101/${n[0]}`);
    const orphan = (await listing()).job.result.days.find((d: { day: string }) => d.day === '2026-11-01');
    assert.equal(orphan.state, 'orphan');

    const del = await t.call({ method: 'POST', url: '/v1/ftp/ad/result-deletions', payload: { days: ['2026-11-01', '2026-10-01'] } });
    assert.deepEqual(del.json(), { deleted: 1 });
    assert.equal(fs.existsSync(path.join(t.dataDir, 'adlogs/20261101.json')), false);
    assert.equal((await t.call({ method: 'POST', url: '/v1/ftp/ad/result-deletions', payload: { days: ['2026/11/01'] } })).statusCode, 400);
  });
});

describe('PA 安全事件總覽', () => {
  it('類型清單與總覽 = 舊版 mergeEventSummaries', async () => {
    const p = '/threat/PA-560_threat_2026_11_02_last_calendar_day_0.csv';
    ftp.put(p, threatCsv('2026/11/01', 600, 40));
    await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items: [{ path: p }] } });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().events.busy);
    const types = (await t.call({ url: '/v1/pa-events/types' })).json().types;
    const threat = types.find((x: { type: string }) => x.type === 'threat');
    assert.deepEqual(threat.days, ['2026-11-01']);
    assert.equal(threat.files, 1);

    const { mergeEventSummaries } = await legacy('paevents.js');
    const idx = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'palogs/events/index.json'), 'utf8')).files[p];
    const zlib = await import('node:zlib');
    const sum = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(t.dataDir, 'palogs/events', idx.summary))).toString());
    const m = mergeEventSummaries('threat', [sum], 15);
    const o = (await t.call({ url: '/v1/pa-events/overview?type=threat&from=2026-11-01&top=15' })).json();
    for (const k of ['type', 'label', 'files', 'rows', 'kpis', 'tops']) assert.deepEqual(o[k], m[k], k);
    assert.deepEqual(o.hours, m.hours.map((h: { hour: string }) => ({ ...h, hour: iso(h.hour) })));
    assert.equal(o.missing, 0);
    assert.equal((await t.call({ url: '/v1/pa-events/overview?type=nope&from=2026-11-01' })).statusCode, 400);
  });
});
