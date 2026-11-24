/**
 * AD-3 整合測試:真 ClickHouse 26.3(CI check:ingest-int 的一次性容器,deploy/clickhouse 的 schema 與 migrations/005)。
 *   INT_CLICKHOUSE_URL(127.0.0.1)、INT_CLICKHOUSE_PASSWORD_FILE(netops_writer;讀取也用這個帳號,它有 SELECT)
 * 驗證(docs/AD-AGENT-PLAN.md §8 AD-3 完成標準;需求方 2026-11-24 D1、D2):
 *   - FTP 補寫不產生重複 (computer, channel, log_epoch, record_id);重做 0 筆;Agent 水位之上的列不補
 *   - 補漏後 ad_heat_5m / 1h / 1d 的增量 = 補寫筆數(不重複計數)
 *   - 對帳 count() 只比 CSV 涵蓋的 23 種 Security 事件(Agent 另收的 4672 不算)
 *   - 同一事件的 CSV 補寫列與 Agent 列:時間精度、時區、Message、欄位解析的差異
 *   - ClickHouse 總覽(SQL)與 summarizeAd(同一份事件)結果相同
 * 每次執行用唯一的 DC 名稱;彙總表不分 DC,比對前後差值;總覽用前天 22 點這一小時(其他整合測試不寫這段時間)。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { before, describe, it } from 'node:test';
import { createAdChReader } from '../../src/infra/clickhouse/ad-reader.js';
import { createAdBackfillCh } from '../../src/infra/clickhouse/ad-backfill.js';
import { createClickHouseWriter } from '../../src/infra/clickhouse/index.js';
import type { AdBackfillJob, AdBackfillQueue } from '../../src/infra/redis/ad-backfill.js';
import { ACCOUNT_CHANGES, SECURITY_EVENTS, summarizeAd } from '../../src/modules/ad/core/adlog.js';
import { runAdBackfill } from '../../src/ingest/ad-backfill.js';
import { toAdRow } from '../../src/ingest/ad-rows.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { msg4625 } from '../fixtures/fake-ad-receiver.js';

const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(CH_URL)) throw new Error('整合測試只連本機一次性容器:請設定 INT_CLICKHOUSE_URL(127.0.0.1)');
const cfg = { url: CH_URL, user: 'netops_writer', password: fs.readFileSync(process.env.INT_CLICKHOUSE_PASSWORD_FILE ?? '', 'utf8').trim() };
const ch = createClickHouseWriter(cfg);
const q = createAdBackfillCh(cfg);
const reader = createAdChReader(cfg, fetch, { securityEvents: SECURITY_EVENTS, accountChanges: ACCOUNT_CHANGES });

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const tp = (ms: number) => {
  const d = new Date(ms + 8 * 3600_000);
  return { day: `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`, iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` };
};
const NOW = Date.now();
const { day: DAY, iso: D } = tp(NOW - DAY_MS);
const YMD = DAY.replace(/\//g, '');
const DC = `IT3-${randomBytes(4).toString('hex').toUpperCase()}`;
const DC2 = `IT3B-${randomBytes(4).toString('hex').toUpperCase()}`;
const AD_DIR = '/AD_Log_Backup';

async function query<T = Record<string, unknown>>(sql: string, params: Record<string, string> = {}): Promise<T[]> {
  const u = new URL(CH_URL);
  u.searchParams.set('query', `${sql} FORMAT JSONEachRow`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, v);
  const res = await fetch(u, { method: 'POST', headers: { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password } });
  const text = await res.text();
  if (!res.ok) throw new Error(text.split('\n', 1)[0]);
  return text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l) as T) : [];
}
const dupCount = async (dc: string) =>
  Number((await query<{ d: string }>('SELECT count() - uniqExact(computer, channel, log_epoch, record_id) AS d FROM netops.ad_events WHERE computer = {c:String}', { c: dc }))[0]!.d);
const rowCount = async (dc: string) => Number((await query<{ c: string }>('SELECT count() AS c FROM netops.ad_events WHERE computer = {c:String}', { c: dc }))[0]!.c);
const heat = async (g: '5m' | '1h' | '1d') => Number((await query<{ t: string }>(`SELECT sum(total_events) AS t FROM netops.ad_heat_${g} WHERE toDate(bucket) = toDate({d:String})`, { d: D }))[0]?.t ?? 0);

/** Agent 列:走 ingest 的 toAdRow(接收端 Stream JSON 的格式) */
const agentRow = (dc: string, rid: number, hms: string, eventId = 4625, epoch = 0, message = msg4625(`it-user-${rid % 3}`, '10.88.3.7')) =>
  toAdRow(
    JSON.stringify({ computer: dc, domain: 'it.local', channel: 'Security', eventId, recordId: String(rid), logEpoch: epoch, time: `${D}T${hms}.123+08:00`, level: eventId === 4672 ? 'Audit Success' : 'Audit Failure', provider: 'Microsoft-Windows-Security-Auditing', message }),
    NOW,
    { badTime: false },
  )!;
const csvLine = (dc: string, hms: string, id: number, rid: number, message: string) =>
  [`"${D} ${hms}"`, id, '"稽核失敗"', '"Microsoft-Windows-Security-Auditing"', `"${dc}.it.local"`, rid, `"${message.replace(/"/g, '""')}"`].join(',');
const csv = (lines: string[]) => ['TimeCreated,EventID,Level,Provider,Computer,RecordID,Message', ...lines].join('\r\n') + '\r\n';

function queue() {
  const jobs = new Map<string, AdBackfillJob>();
  const qu: AdBackfillQueue = {
    enqueue: async () => null,
    get: async (id) => jobs.get(id) ?? null,
    take: async () => null,
    update: async (id, f) => void jobs.set(id, { ...jobs.get(id)!, ...(f as object) }),
    finish: async () => undefined,
    failInterrupted: async () => [],
    close: async () => undefined,
  };
  return { qu, jobs };
}
let n = 0;
async function backfill(dc: string, content: string, hwm: Record<string, string>) {
  const ftp = createFakeFtp();
  ftp.put(`${AD_DIR}/${YMD}/Security_${dc}.csv`, content);
  const { qu, jobs } = queue();
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const job: AdBackfillJob = { id, day: DAY, files: [`${AD_DIR}/${YMD}/Security_${dc}.csv`], scope: [{ computer: dc, channel: 'Security' }], state: 'running', createdBy: 'it', createdAt: '', startedAt: null, finishedAt: null, read: 0, skipped: 0, inserted: 0, waitingAgent: 0, ambiguous: 0, invalid: 0, error: null };
  jobs.set(id, job);
  await runAdBackfill(job, { ch, q, ftp, queue: qu, log: () => undefined, signal: new AbortController().signal, rules: { adDir: AD_DIR, ttlDays: 3 }, now: () => NOW });
  return jobs.get(id)!;
}

before(async () => {
  await ch.ping();
});

describe('AD FTP 補漏(真 ClickHouse)', () => {
  it('只補缺的列;重做 0 筆;沒有重複鍵;ad_heat_* 增量 = 補寫筆數;水位之上不補', async () => {
    // Agent 已寫 100、102、103(4672,Agent 另收、CSV 沒有);CSV 有 100、101、102、104;水位 103 → 101 補、104 等 Agent
    await ch.insert('ad', [agentRow(DC, 100, '01:00:00'), agentRow(DC, 102, '03:00:00'), agentRow(DC, 103, '03:30:00', 4672)], `it3:${DC}:seed`);
    const content = csv([
      csvLine(DC, '01:00:00', 4625, 100, msg4625('it-user-1', '10.88.3.7')),
      csvLine(DC, '02:00:00', 4625, 101, msg4625('it-user-2', '10.88.3.8')),
      csvLine(DC, '03:00:00', 4625, 102, msg4625('it-user-0', '10.88.3.7')),
      csvLine(DC, '04:00:00', 4625, 104, msg4625('it-user-2', '10.88.3.9')),
    ]);
    const before = await Promise.all([heat('5m'), heat('1h'), heat('1d')]);
    const j1 = await backfill(DC, content, { 'Security:0': '103' });
    assert.equal(j1.state, 'done', String(j1.error));
    assert.deepEqual([j1.read, j1.skipped, j1.inserted, j1.waitingAgent, j1.ambiguous], [4, 2, 1, 1, 0]);
    const j2 = await backfill(DC, content, { 'Security:0': '103' });
    assert.deepEqual([j2.inserted, j2.skipped], [0, 3]);
    assert.equal(await dupCount(DC), 0);
    assert.equal(await rowCount(DC), 4);
    const afterH = await Promise.all([heat('5m'), heat('1h'), heat('1d')]);
    assert.deepEqual(
      afterH.map((x, i) => x - before[i]!),
      [1, 1, 1],
      'ad_heat_* 的增量應等於補寫筆數',
    );
    // Agent 恢復後送 104:鍵不重複(補漏沒寫它)
    await ch.insert('ad', [agentRow(DC, 104, '04:00:00')], `it3:${DC}:late`);
    assert.equal(await dupCount(DC), 0);
  });

  it('對帳 count() 只算 23 種 Security 事件(4672 不算)', async () => {
    const day = DAY;
    const fromMs = Date.parse(`${D}T00:00:00+08:00`);
    const r = (await reader.reconCounts(fromMs, fromMs + DAY_MS)).find((x) => x.computer === DC && x.channel === 'Security')!;
    assert.ok(r, `沒有 ${DC} 的對帳筆數(${day})`);
    // ad_events:100、101(ftp)、102、103(4672)、104 → 對帳算 4 筆
    assert.deepEqual([r.n, r.agent, r.ftp], [4, 3, 1]);
  });

  it('同一事件的 CSV 補寫列與 Agent 列:欄位比對(差異記入測試報告)', async () => {
    const msg = msg4625('cmp-user', '10.88.4.4');
    await ch.insert('ad', [agentRow(DC2, 7, '05:06:07', 4625, 0, msg)], `it3:${DC2}:agent`);
    // 另一台 DC(沒有 Agent)用同一事件走 FTP 補寫
    const DC3 = `${DC2}X`;
    const j = await backfill(DC3, csv([csvLine(DC3, '05:06:07', 4625, 7, msg)]), {});
    assert.equal(j.inserted, 1, String(j.error));
    const rows = await query<Record<string, string | number>>(
      `SELECT computer, source, toString(event_time) AS t, toUnixTimestamp(event_time) AS u, level, level_text, account, src_ip_raw, toString(src_ip) AS ip6, workstation, reason, is_issue, message, ad_domain, log_epoch
       FROM netops.ad_events WHERE computer IN ({a:String}, {b:String}) ORDER BY source`,
      { a: DC2, b: DC3 },
    );
    const [a, f] = [rows.find((x) => x.source === 'agent')!, rows.find((x) => x.source === 'ftp')!];
    // 相同:時間(秒、Asia/Taipei)、等級、解析出的帳號 / IP / 工作站 / 原因、is_issue、訊息、世代
    for (const k of ['t', 'u', 'level', 'account', 'src_ip_raw', 'ip6', 'workstation', 'reason', 'is_issue', 'message', 'log_epoch']) assert.equal(f[k], a[k], `欄位 ${k} 不同:agent=${a[k]} ftp=${f[k]}`);
    assert.equal(a.t, `${D} 05:06:07`);
    // 已知差異:level_text(CSV 是 DC 語系的中文,Agent 是英文);Agent 的毫秒在 event_time(DateTime)已捨去
    assert.deepEqual([a.level_text, f.level_text], ['Audit Failure', '稽核失敗']);
    assert.equal(f.ad_domain, 'it.local');
  });
});

describe('AD ClickHouse 總覽 = summarizeAd(同一份事件)', () => {
  it('前天 22 點的事件:統計、排行、異動、特權登入相同', async () => {
    const { iso: D2 } = tp(NOW - 2 * DAY_MS);
    const DCO = `IT3O-${randomBytes(4).toString('hex').toUpperCase()}`;
    const t = (m: number, s: number) => `${D2}T22:${pad(m)}:${pad(s)}.000+08:00`;
    const mk = (rid: number, eventId: number, time: string, level: string, message: string) =>
      toAdRow(JSON.stringify({ computer: DCO, domain: 'it.local', channel: 'Security', eventId, recordId: String(rid), logEpoch: 0, time, level, provider: 'Microsoft-Windows-Security-Auditing', message }), NOW, { badTime: false })!;
    const rows = [
      mk(1, 4625, t(1, 0), 'Audit Failure', msg4625('ov-a', '10.77.0.1')),
      mk(2, 4625, t(2, 0), 'Audit Failure', msg4625('ov-a', '10.77.0.2')),
      mk(3, 4625, t(3, 0), 'Audit Failure', msg4625('ov-b', '10.77.0.1')),
      mk(4, 4740, t(4, 0), 'Audit Success', '已鎖定使用者帳戶。\r\n\r\n已鎖定的帳戶:\r\n\t帳戶名稱:\t\tov-a'),
      mk(5, 4720, t(5, 0), 'Audit Success', '已建立使用者帳戶。\r\n\r\n主體:\r\n\t帳戶名稱:\t\tadmin\r\n\r\n新帳戶:\r\n\t帳戶名稱:\t\tov-new'),
      mk(6, 4672, t(6, 0), 'Audit Success', '指派給新登入的特殊權限。\r\n\r\n主體:\r\n\t帳戶名稱:\t\tov-admin'),
      mk(7, 4672, t(7, 0), 'Audit Success', '指派給新登入的特殊權限。\r\n\r\n主體:\r\n\t帳戶名稱:\t\tPC-01$'),
      // 原因含單引號與反斜線:總覽「每個原因前 5 名」的查詢不能壞(資安審查 M2)
      mk(8, 4625, t(8, 0), 'Audit Failure', "帳戶登入失敗。\r\n\r\n登入失敗的帳戶:\r\n\t帳戶名稱:\t\tov-c\r\n\r\n失敗資訊:\r\n\t失敗原因:\t\tit's a \ test\r\n\r\n網路資訊:\r\n\t來源網路位址:\t10.77.0.3"),
    ];
    await ch.insert('ad', rows, `it3:${DCO}:ov`);
    const fromMs = Date.parse(`${D2}T22:00:00+08:00`);
    const toMs = fromMs + 3600_000;
    const ov = await reader.overview(fromMs, toMs, 30);
    assert.ok(ov.failReasons.some((x) => x.key === "it's a \ test" && x.ips.length === 1), JSON.stringify(ov.failReasons));
    const { rows: evs } = await reader.search({ fromMs, toMs }, 0, 1000);
    // 這一小時只能有本測試的事件(其他整合測試不寫前天 22 點);若有別的資料,比對仍用同一份 evs
    const js = summarizeAd(evs as never, 30) as typeof ov;
    for (const k of ['total', 'byChannel', 'byLevel', 'timeMin', 'timeMax', 'hours', 'failAccounts', 'failIps', 'privilegedChanges', 'accountsCreated', 'privLogons'] as const) assert.deepEqual(ov[k], js[k], `${k} 不同`);
    assert.deepEqual(
      ov.failReasons.map((x) => [x.key, x.n, x.ips, x.accounts]),
      js.failReasons.map((x) => [x.key, x.n, x.ips, x.accounts]),
    );
    const g = (l: { channel: string; eventId: number; level: string; n: number }[]) => l.map((x) => `${x.channel}|${x.eventId}|${x.level}|${x.n}`).sort();
    assert.deepEqual(g(ov.events), g(js.events));
    assert.deepEqual(g(ov.issues), g(js.issues));
    assert.deepEqual(
      ov.accountChanges.map((c) => [c.time, c.eventId, c.action, c.target]),
      js.accountChanges.map((c) => [c.time, c.eventId, c.action, c.target]),
    );
  });
});
