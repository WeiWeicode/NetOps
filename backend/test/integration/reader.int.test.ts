/**
 * netops-api 唯讀查詢整合測試(IMPL-PLAN C3):真 ClickHouse 26.3(deploy/clickhouse 的設定、schema、migrations),
 * 帳號 netops_reader(readonly=2 + constraints)。CI check:ingest-int 的同一組一次性容器。
 *   INT_CLICKHOUSE_URL                   http://127.0.0.1:<port>
 *   INT_CLICKHOUSE_PASSWORD_FILE         netops_writer(寫入測試資料)
 *   INT_CLICKHOUSE_READER_PASSWORD_FILE  netops_reader
 * 驗證:SQL 能在真 ClickHouse 執行、IPv4 轉回原格式、時間格式、每小時彙總、原始 log 逐列讀、唯讀帳號不能寫、每小時摘要端到端。
 * 用一個其他測試不會用到的小時(現在 − 50 小時)放測試資料。
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

before(async () => {
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
    assert.equal(r.reduce((s, x) => s + x.n, 0), N);
    assert.equal(r.find((x) => x.action === 'deny')?.n, 6);
    assert.equal(r.reduce((s, x) => s + x.bytes, 0), N * 1000);
    assert.ok(r.every((x) => x.hour === H));
  });

  it('原始 log 逐列讀出:IPv4 去掉 ::ffff:、空位址為空字串、時間為核心格式、數字欄位為數字', async () => {
    const rows: Record<string, unknown>[] = [];
    const n = await reader.trafficRecords(H, H + HOUR, (r) => rows.push(r));
    assert.equal(n, N);
    const r = rows.find((x) => x.time === taipeiText(H))!;
    assert.equal(r.src, '10.77.0.0');
    assert.equal(r.natSrc, '');
    assert.equal(r.bytes, 1000);
    assert.equal(r.sent, 400);
    assert.equal(r.dport, 443);
    const t: Record<string, unknown>[] = [];
    assert.equal(await reader.threatRecords('threat', H, H + HOUR, (x) => t.push(x)), 5);
    assert.equal(t[0]!.repeat, 3);
    assert.equal(t[0]!.src, '203.0.113.9');
  });

  it('威脅類每小時筆數、下拉選項、最早一小時', async () => {
    const c = await reader.threatHourCounts(H, H + HOUR);
    assert.deepEqual(c.find((x) => x.type === 'threat'), { type: 'threat', hour: H, n: 5 });
    const o = await reader.trafficOptions(H, H + HOUR, 200);
    assert.ok(o.apps.includes('c3-int-app'));
    assert.ok(o.zones.includes('LAN') && o.zones.includes('WAN'));
    assert.ok((await reader.earliestTrafficHour())! <= H);
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

describe('每小時摘要(真 ClickHouse)', () => {
  let dir: string;
  before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ch-int-'))));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('建出測試小時的 TRAFFIC 與威脅摘要,筆數一致', async () => {
    const b = createChSummaryBuilder({ reader, store: createStore(dir).pa, log: { info() {}, warn() {} }, days: 3, minutes: 0, now: () => H + 2 * HOUR });
    await b.runOnce();
    assert.equal(b.status().lastError, null);
    const tr = b.summaries('traffic', H, H + HOUR);
    assert.equal(tr.missing, 0);
    assert.equal((tr.list[0] as { rows: number }).rows, N);
    const th = b.summaries('threat', H, H + HOUR);
    assert.equal((th.list[0] as { rows: number }).rows, 15); // 5 筆 × Repeat Count 3
  });
});
