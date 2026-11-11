/**
 * netops-api 唯讀查詢整合測試(IMPL-PLAN C3):真 ClickHouse 26.3(deploy/clickhouse 的設定、schema、migrations),
 * 帳號 netops_reader(readonly=2 + constraints)。CI check:ingest-int 的同一組一次性容器。
 *   INT_CLICKHOUSE_URL                   http://127.0.0.1:<port>
 *   INT_CLICKHOUSE_PASSWORD_FILE         netops_writer(寫入測試資料)
 *   INT_CLICKHOUSE_READER_PASSWORD_FILE  netops_reader
 * 驗證:SQL 能在真 ClickHouse 執行、IPv4 轉回原格式、時間格式、每小時彙總、原始 log 逐列讀、唯讀帳號不能寫、每小時摘要端到端。
 * 測試資料放在「現在 − 50 小時」那一小時;其他測試可能也寫到同一小時,所以一律和寫入前的基準比較差值。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createClickHouseWriter } from '../../src/infra/clickhouse/index.js';
import { createClickHouseReader } from '../../src/infra/clickhouse/reader.js';
import { createStore } from '../../src/infra/store/index.js';
import { toThreatRow, toTrafficRow } from '../../src/ingest/rows.js';
import { createChSummaryBuilder } from '../../src/modules/pa/ch-summary.js';
import { taipeiText } from '../../src/shared/time.js';

const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
const W_FILE = process.env.INT_CLICKHOUSE_PASSWORD_FILE ?? '';
const R_FILE = process.env.INT_CLICKHOUSE_READER_PASSWORD_FILE ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(CH_URL) || !W_FILE || !R_FILE)
  throw new Error('整合測試只連本機一次性容器:請設定 INT_CLICKHOUSE_URL(127.0.0.1)、INT_CLICKHOUSE_PASSWORD_FILE、INT_CLICKHOUSE_READER_PASSWORD_FILE');

const readerPw = fs.readFileSync(R_FILE, 'utf8').trim();
const writer = createClickHouseWriter({ url: CH_URL, user: 'netops_writer', password: fs.readFileSync(W_FILE, 'utf8').trim() });
const reader = createClickHouseReader({ url: CH_URL, user: 'netops_reader', password: readerPw });
const HOUR = 3600_000;
const H = Math.floor((Date.now() - 50 * HOUR) / HOUR) * HOUR;
const N = 30;
/** 寫入前同一小時已有的資料 */
const base = { n: 0, deny: 0, bytes: 0, raw: 0, threat: 0, threatWeighted: 0 };

before(async () => {
  for (const r of await reader.trafficHours(H, H + HOUR)) {
    base.n += r.n;
    base.bytes += r.bytes;
    if (r.action === 'deny') base.deny += r.n;
  }
  base.raw = await reader.trafficRecords(H, H + HOUR, () => {});
  base.threat = await reader.threatRecords('threat', H, H + HOUR, (x) => (base.threatWeighted += Math.max(Number(x.repeat) || 1, 1)));
  const issues = { badTime: false };
  const traffic = Array.from({ length: N }, (_, i) =>
    toTrafficRow(
      { time: taipeiText(H + i * 60_000), src: `10.77.0.${i % 3}`, dst: '8.8.4.4', app: 'c3-int-app', action: i % 5 ? 'allow' : 'deny', proto: 'tcp', dport: 443, bytes: 1000, sent: 400, recv: 600, rule: 'c3-rule', fromZone: 'LAN', toZone: 'WAN', seqno: String(9_000_000 + i) },
      H + i * 60_000,
      issues,
    ),
  );
  await writer.insert('traffic', traffic, `c3-int-${randomUUID()}`);
  const threats = Array.from({ length: 5 }, (_, i) =>
    toThreatRow('threat', { time: taipeiText(H + i * 60_000), src: '203.0.113.9', dst: '10.77.0.1', name: 'C3 Test(1)', severity: 'high', action: 'alert', repeat: 3, dport: 22, proto: 'tcp' }, H + i * 60_000, issues),
  );
  await writer.insert('threat', threats, `c3-int-${randomUUID()}`);
});

describe('netops_reader 唯讀查詢', () => {
  it('每小時彙總:筆數與位元組', async () => {
    const r = await reader.trafficHours(H, H + HOUR);
    assert.equal(r.reduce((s, x) => s + x.n, 0) - base.n, N);
    assert.equal((r.find((x) => x.action === 'deny')?.n ?? 0) - base.deny, 6);
    assert.equal(r.reduce((s, x) => s + x.bytes, 0) - base.bytes, N * 1000);
    assert.ok(r.every((x) => x.hour === H));
  });

  it('原始 log 逐列讀出:IPv4 去掉 ::ffff:、空位址為空字串、時間為核心格式、數字欄位為數字', async () => {
    const rows: Record<string, unknown>[] = [];
    const n = await reader.trafficRecords(H, H + HOUR, (r) => rows.push(r));
    assert.equal(n - base.raw, N);
    const r = rows.find((x) => x.time === taipeiText(H) && x.app === 'c3-int-app')!;
    assert.equal(r.src, '10.77.0.0');
    assert.equal(r.natSrc, '');
    assert.equal(r.bytes, 1000);
    assert.equal(r.sent, 400);
    assert.equal(r.dport, 443);
    const t: Record<string, unknown>[] = [];
    assert.equal((await reader.threatRecords('threat', H, H + HOUR, (x) => t.push(x))) - base.threat, 5);
    const mine = t.find((x) => x.name === 'C3 Test(1)')!;
    assert.equal(mine.repeat, 3);
    assert.equal(mine.src, '203.0.113.9');
  });

  it('威脅類每小時筆數、下拉選項、最早一小時', async () => {
    const c = await reader.threatHourCounts(H, H + HOUR);
    assert.deepEqual(c.find((x) => x.type === 'threat'), { type: 'threat', hour: H, n: base.threat + 5 });
    const o = await reader.trafficOptions(H, H + HOUR, 200);
    assert.ok(o.apps.includes('c3-int-app'));
    assert.ok(o.zones.includes('LAN') && o.zones.includes('WAN'));
    assert.ok((await reader.earliestTrafficHour())! <= H);
  });

  it('明細查詢(C3):完全相同、CIDR、萬用字元、Port、動作;依時間排序、超過上限標 more', async () => {
    const q = (f: object, limit = 100) => reader.searchTraffic({ fromMs: H, toMs: H + HOUR, app: 'c3-int-app', ...f }, limit, 10);
    assert.equal((await q({ src: '10.77.0.1' })).rows.length, 10);
    assert.equal((await q({ src: '10.77.0.0/30' })).rows.length, N);
    assert.equal((await q({ ip: '10.77.0.*' })).rows.length, N);
    assert.equal((await q({ port: '443', action: 'block' })).rows.length, 6);
    assert.equal((await q({ q: 'C3-RULE' })).rows.length, N);
    assert.equal((await q({ dst: '10.77' })).rows.length, 0);
    const lim = await q({}, 5);
    assert.equal(lim.rows.length, 5);
    assert.equal(lim.more, true);
    assert.equal(lim.rows[0]!.time, taipeiText(H));
    assert.ok(lim.rows.every((r, i) => i === 0 || String(r.time) >= String(lim.rows[i - 1]!.time)));
    assert.ok((await reader.trafficCount(H, H + HOUR)) >= N);
  });

  it('唯讀帳號不能寫入、不能放寬執行秒數上限', async () => {
    const post = (q: string, extra = '') =>
      fetch(`${CH_URL}/?${extra}`, { method: 'POST', headers: { 'X-ClickHouse-User': 'netops_reader', 'X-ClickHouse-Key': readerPw }, body: q });
    const ins = await post(`INSERT INTO netops.pa_traffic_logs (event_time, received_at, src) VALUES (now(), now64(3), '::ffff:1.1.1.1')`);
    assert.notEqual(ins.status, 200);
    const slow = await post('SELECT 1', 'max_execution_time=600');
    assert.notEqual(slow.status, 200);
  });
});

describe('FTP 補漏用的寫入(netops_writer,C3)', () => {
  it('trafficSeqnos 列出這一小時已有的 seqno;insertJson 寫入 JSON 字串列', async () => {
    const have = await writer.trafficSeqnos(H, H + HOUR);
    for (let i = 0; i < N; i++) assert.ok(have.has(String(9_000_000 + i)));
    const row = toTrafficRow({ time: taipeiText(H + 45 * 60_000), src: '10.77.9.9', app: 'c3-int-ftp', action: 'allow', seqno: '9100000' }, H + 45 * 60_000, { badTime: false });
    await writer.insertJson('traffic', [JSON.stringify({ ...row, source: 'ftp' })], `c3-int-${randomUUID()}`);
    assert.ok((await writer.trafficSeqnos(H, H + HOUR)).has('9100000'));
    const rows: Record<string, unknown>[] = [];
    await reader.trafficRecords(H, H + HOUR, (r) => r.app === 'c3-int-ftp' && rows.push(r));
    assert.equal(rows.length, 1);
  });
});

describe('每小時摘要(真 ClickHouse)', () => {
  let dir: string;
  before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ch-int-'))));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('建出測試小時的 TRAFFIC 與威脅摘要,筆數一致', async () => {
    const b = createChSummaryBuilder({ reader, store: createStore(dir).pa, log: { info() {}, warn() {} }, days: 3, minutes: 0, now: () => H + 2 * HOUR });
    await b.runOnce();
    assert.equal(b.status().lastError, null);
    const tr = await b.summaries('traffic', H, H + HOUR);
    assert.equal(tr.missing, 0);
    // + 1:上面 FTP 補漏用的寫入測試多寫一列
    assert.equal((tr.list[0] as { rows: number }).rows, base.raw + N + 1);
    const th = await b.summaries('threat', H, H + HOUR);
    assert.equal((th.list[0] as { rows: number }).rows, base.threatWeighted + 15); // 5 筆 × Repeat Count 3
  });
});
