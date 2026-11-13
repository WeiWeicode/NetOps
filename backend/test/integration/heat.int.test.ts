/**
 * V-a 熱力圖彙總與時段明細整合測試:真 ClickHouse 26.3(deploy/clickhouse 的 schema、migrations),CI check:ingest-int 的同一組一次性容器。
 *   INT_CLICKHOUSE_URL、INT_CLICKHOUSE_PASSWORD_FILE(netops_writer)、INT_CLICKHOUSE_READER_PASSWORD_FILE(netops_reader)
 * 驗證:6 個物化檢視寫進 pa_heat_5m / _1h / _1d,三張表的總數和原始表一致;重送(同一個 token)不重複;Top IP;
 *       _src 的上傳 / 下載(migration 003);時段明細的摘要、排行、明細列與條件。
 * 測試資料放在「現在 − 49 小時」那一小時(reader.int 用 − 50 小時);每天格可能有其他測試的資料,一律和寫入前的基準比較差值。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { before, describe, it } from 'node:test';
import { createClickHouseWriter } from '../../src/infra/clickhouse/index.js';
import { createHeatReader, type HeatGrain, type HeatRow } from '../../src/infra/clickhouse/heat.js';
import { toThreatRow, toTrafficRow } from '../../src/ingest/rows.js';
import { taipeiText } from '../../src/shared/time.js';

const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
const W_FILE = process.env.INT_CLICKHOUSE_PASSWORD_FILE ?? '';
const R_FILE = process.env.INT_CLICKHOUSE_READER_PASSWORD_FILE ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(CH_URL) || !W_FILE || !R_FILE)
  throw new Error('整合測試只連本機一次性容器:請設定 INT_CLICKHOUSE_URL(127.0.0.1)、INT_CLICKHOUSE_PASSWORD_FILE、INT_CLICKHOUSE_READER_PASSWORD_FILE');

const writer = createClickHouseWriter({ url: CH_URL, user: 'netops_writer', password: fs.readFileSync(W_FILE, 'utf8').trim() });
const heat = createHeatReader({ url: CH_URL, user: 'netops_reader', password: fs.readFileSync(R_FILE, 'utf8').trim() });
const HOUR = 3600_000;
const H = Math.floor((Date.now() - 49 * HOUR) / HOUR) * HOUR;
/** H 所在的台灣日 00:00 */
const D = Date.parse(`${taipeiText(H).slice(0, 10).replace(/\//g, '-')}T00:00:00+08:00`);
const N = 24;
const GRAINS: [HeatGrain, number, number][] = [
  ['5m', H, H + HOUR],
  ['1h', H, H + HOUR],
  ['1d', D, D + 24 * HOUR],
];
const total = (rows: HeatRow[]) =>
  rows.reduce(
    (s, r) => ({ sessions: s.sessions + r.sessions, bytes: s.bytes + r.bytes, sent: s.sent + r.sent, deny: s.deny + r.deny, critical: s.critical + r.critical, high: s.high + r.high, low: s.low + r.low, info: s.info + r.info }),
    { sessions: 0, bytes: 0, sent: 0, deny: 0, critical: 0, high: 0, low: 0, info: 0 },
  );
const base = new Map<HeatGrain, ReturnType<typeof total>>();
let token = '';

before(async () => {
  for (const [g, a, b] of GRAINS) base.set(g, total(await heat.heatRows(g, a, b)));
  const issues = { badTime: false };
  // 每 2.5 分鐘一筆;10.88.0.9 位元組最多(Top 1),每 4 筆一筆 deny
  const traffic = Array.from({ length: N }, (_, i) =>
    toTrafficRow(
      { time: taipeiText(H + i * 150_000), src: i % 3 ? `10.88.0.${i % 3}` : '10.88.0.9', dst: '8.8.8.8', app: 'va-int-app', action: i % 4 ? 'allow' : 'deny', proto: 'tcp', dport: 443, bytes: i % 3 ? 100 : 5000, sent: 40, recv: 60, fromZone: 'LAN', toZone: 'WAN', seqno: String(8_100_000 + i) },
      H + i * 150_000,
      issues,
    ),
  );
  token = `va-int-${randomUUID()}`;
  await writer.insert('traffic', traffic, token);
  const sev = ['critical', 'high', 'low', 'informational'];
  const threats = Array.from({ length: 8 }, (_, i) =>
    toThreatRow('threat', { time: taipeiText(H + i * 60_000), src: '198.51.100.7', dst: '10.88.0.1', name: 'VA Test(9)', severity: sev[i % 4]!, action: 'alert', repeat: 5, dport: 22, proto: 'tcp' }, H + i * 60_000, issues),
  );
  await writer.insert('threat', threats, `va-int-${randomUUID()}`);
  // url 類不算進威脅指標
  await writer.insert('threat', [toThreatRow('url', { time: taipeiText(H), src: '10.88.0.1', dst: '1.1.1.1', severity: 'critical', action: 'alert', url: 'x' }, H, issues)], `va-int-${randomUUID()}`);
});

describe('熱力圖彙總(物化檢視)', () => {
  it('三張表的總數和寫入的原始列一致;威脅不乘 repeat_count、只算 log_type = threat', async () => {
    for (const [g, a, b] of GRAINS) {
      const t = total(await heat.heatRows(g, a, b));
      const b0 = base.get(g)!;
      assert.equal(t.sessions - b0.sessions, N, `${g} sessions`);
      assert.equal(t.bytes - b0.bytes, 8 * 5000 + 16 * 100, `${g} bytes`);
      assert.equal(t.sent - b0.sent, N * 40, `${g} sent`);
      assert.equal(t.deny - b0.deny, 6, `${g} deny`);
      assert.equal(t.critical - b0.critical, 2, `${g} critical`);
      assert.equal(t.high - b0.high, 2, `${g} high`);
      assert.equal(t.info - b0.info, 2, `${g} info`);
    }
  });

  it('同一個 token 重送不重複計算', async () => {
    const issues = { badTime: false };
    const again = Array.from({ length: N }, (_, i) =>
      toTrafficRow(
        { time: taipeiText(H + i * 150_000), src: i % 3 ? `10.88.0.${i % 3}` : '10.88.0.9', dst: '8.8.8.8', app: 'va-int-app', action: i % 4 ? 'allow' : 'deny', proto: 'tcp', dport: 443, bytes: i % 3 ? 100 : 5000, sent: 40, recv: 60, fromZone: 'LAN', toZone: 'WAN', seqno: String(8_100_000 + i) },
        H + i * 150_000,
        issues,
      ),
    );
    await writer.insert('traffic', again, token);
    for (const [g, a, b] of GRAINS) assert.equal(total(await heat.heatRows(g, a, b)).sessions - base.get(g)!.sessions, N, g);
  });

  it('5 分鐘格:每格 2 筆;Top IP(IPv4 去掉 ::ffff:);最早的格子', async () => {
    const rows = await heat.heatRows('5m', H, H + HOUR);
    assert.ok(rows.every((r) => (r.t - H) % 300_000 === 0));
    const first = rows.find((r) => r.t === H)!;
    assert.ok(first.sessions >= 2);
    const hour = (await heat.heatRows('1h', H, H + HOUR))[0]!;
    assert.equal(hour.topBytes[0], '10.88.0.9');
    assert.ok(hour.topThreat.includes('198.51.100.7'));
    const since = await heat.heatEarliest('5m');
    assert.ok(since !== null && since <= H);
  });
});

describe('時段明細(原始表)', () => {
  it('TRAFFIC:摘要、Top 10、明細列(新到舊)與 IP 條件', async () => {
    const r = await heat.slice('traffic', { fromMs: H, toMs: H + HOUR, ip: '10.88.0.0/24', app: 'va-int-app' }, 5, 'time', 50);
    assert.equal(r.summary.sessions, N);
    assert.equal(r.summary.sent, N * 40);
    assert.equal(r.summary.deny, 6);
    assert.equal(r.summary.threats.critical, 2);
    assert.equal(r.top.src![0]!.key, '10.88.0.9');
    assert.equal(r.rows.length, 5);
    assert.equal(r.more, true);
    assert.equal(r.rows[0]!.time, taipeiText(H + (N - 1) * 150_000));
    assert.equal(r.rows[0]!.src, '10.88.0.2');
    const bytes = await heat.slice('traffic', { fromMs: H, toMs: H + HOUR, src: '10.88.0.9' }, 3, 'bytes', 50);
    assert.equal(bytes.summary.sessions, 8);
    assert.equal(bytes.rows[0]!.bytes, 5000);
  });

  it('威脅:嚴重度條件、威脅名稱排行', async () => {
    const r = await heat.slice('threat', { fromMs: H, toMs: H + HOUR, src: '198.51.100.7', severity: 'critical' }, 10, 'time', 50);
    assert.equal(r.summary.sessions, 2);
    assert.equal(r.top.name![0]!.key, 'VA Test(9)');
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0]!.severity, 'critical');
  });
});

describe('分析儀表板查詢(V-b1)', () => {
  it('來源 IP 的上傳 / 下載(migration 003 的 MV)、App 排行、桑基流向', async () => {
    const top = await heat.insightTopSrc(H, H + HOUR, 100);
    const ip9 = top.find((x) => x.ip === '10.88.0.9');
    assert.ok(ip9, '10.88.0.9 在排行內');
    assert.equal(ip9!.sent, 8 * 40);
    assert.equal(ip9!.recv, 8 * 60);
    const apps = await heat.insightTopApps(H, H + HOUR, 100);
    assert.ok(apps.some((a) => a.app === 'va-int-app' && a.sessions >= N));
    const flows = await heat.insightFlows(H, H + HOUR, 15);
    assert.ok(flows.some((f) => f.fromZone === 'LAN' && f.toZone === 'WAN' && f.bytes > 0));
  });

  it('威脅:國家、內網來源(RFC 1918)、名稱排行', async () => {
    const issues = { badTime: false };
    await writer.insert(
      'threat',
      [toThreatRow('threat', { time: taipeiText(H + 600_000), src: '10.88.0.77', dst: '203.0.113.5', name: 'VA Internal(7)', severity: 'high', action: 'alert', srcCountry: '10.0.0.0-10.255.255.255', dport: 443, proto: 'tcp' }, H + 600_000, issues)],
      `va-int-${randomUUID()}`,
    );
    const internal = await heat.threatTopInternalSrc(H, H + HOUR, 100);
    assert.ok(internal.some((x) => x.ip === '10.88.0.77' && x.high >= 1));
    assert.ok(!internal.some((x) => x.ip === '198.51.100.7'));
    const names = await heat.threatTopNames(H, H + HOUR, 100);
    assert.ok(names.some((x) => x.name === 'VA Test(9)' && x.count >= 8));
    const countries = await heat.threatCountries(H, H + HOUR);
    assert.ok(countries.length > 0);
  });
});
