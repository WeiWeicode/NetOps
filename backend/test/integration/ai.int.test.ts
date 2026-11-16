/**
 * AC2 AI 查詢的整合測試(IMPL-PLAN AC2):真 ClickHouse 26.3(deploy/clickhouse 的 schema、migrations,帳號 netops_reader),
 * CI check:ingest-int 的同一組一次性容器(INT_CLICKHOUSE_URL、INT_CLICKHOUSE_PASSWORD_FILE、INT_CLICKHOUSE_READER_PASSWORD_FILE)。
 * 驗證 AI 用的 SQL 能在真 ClickHouse 執行、條件語意(1 個 IP / 2 個 IP / Port)、連線組合累計與結束原因、範例每種組合一筆、
 * 威脅類依組合累計(乘 Repeat Count)、每天彙總(pa_heat_1d)與排行(每小時彙總)的筆數。
 * CI 的 schema 是測試區 TTL 3 天:長期間(30 天分界、92 天、威脅 90 天、IP 學習 30 天)由 test/unit/ai-ch.test.ts 的 fixture 驗證。
 * 測試資料放在「現在 − 51 小時」那一小時,IP 用 10.89.x(其他整合測試不用),條件只會選到本檔的資料;每天彙總和寫入前的基準比較差值。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { before, describe, it } from 'node:test';
import { createClickHouseWriter } from '../../src/infra/clickhouse/index.js';
import { createClickHouseReader, type AiDayRow } from '../../src/infra/clickhouse/reader.js';
import { toThreatRow, toTrafficRow } from '../../src/ingest/rows.js';
import { taipeiText } from '../../src/shared/time.js';

const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
const W_FILE = process.env.INT_CLICKHOUSE_PASSWORD_FILE ?? '';
const R_FILE = process.env.INT_CLICKHOUSE_READER_PASSWORD_FILE ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(CH_URL) || !W_FILE || !R_FILE)
  throw new Error('整合測試只連本機一次性容器:請設定 INT_CLICKHOUSE_URL(127.0.0.1)、INT_CLICKHOUSE_PASSWORD_FILE、INT_CLICKHOUSE_READER_PASSWORD_FILE');

const writer = createClickHouseWriter({ url: CH_URL, user: 'netops_writer', password: fs.readFileSync(W_FILE, 'utf8').trim() });
const reader = createClickHouseReader({ url: CH_URL, user: 'netops_reader', password: fs.readFileSync(R_FILE, 'utf8').trim() });
const HOUR = 3600_000;
const H = Math.floor((Date.now() - 51 * HOUR) / HOUR) * HOUR;
/** H 所在的台灣日 00:00 */
const D = Date.parse(`${taipeiText(H).slice(0, 10).replace(/\//g, '-')}T00:00:00+08:00`);
const N = 40;
const sumDays = (rows: AiDayRow[]) => rows.reduce((s, r) => ({ sessions: s.sessions + r.sessions, deny: s.deny + r.deny, high: s.high + r.high }), { sessions: 0, deny: 0, high: 0 });
let base = { sessions: 0, deny: 0, high: 0 };

before(async () => {
  base = sumDays(await reader.aiDays(D, D + 24 * HOUR));
  const issues = { badTime: false };
  // 每 90 秒一筆:10.89.0.1 → 10.89.9.<i % 4>,Port 443 / 22 交錯;每 5 筆一筆 deny(結束原因 policy-deny)
  const traffic = Array.from({ length: N }, (_, i) =>
    toTrafficRow(
      {
        time: taipeiText(H + i * 90_000),
        src: '10.89.0.1',
        dst: `10.89.9.${i % 4}`,
        app: 'ai-int-app',
        action: i % 5 ? 'allow' : 'deny',
        rule: i % 5 ? 'Allow-Int' : 'interzone-default',
        proto: 'tcp',
        dport: i % 2 ? 443 : 22,
        sport: 50000 + i,
        bytes: 1000,
        sent: 400,
        recv: 600,
        endReason: i % 5 ? 'tcp-fin' : 'policy-deny',
        fromZone: 'LAN',
        toZone: 'Server',
        seqno: String(9_100_000 + i),
      },
      H + i * 90_000,
      issues,
    ),
  );
  await writer.insert('traffic', traffic, `ai-int-${randomUUID()}`);
  const threats = Array.from({ length: 6 }, (_, i) =>
    toThreatRow('threat', { time: taipeiText(H + i * 60_000), src: '198.51.100.89', dst: '10.89.9.1', name: 'AI Int Test(7)', severity: 'high', action: 'alert', repeat: 3, dport: 445, proto: 'tcp' }, H + i * 60_000, issues),
  );
  await writer.insert('threat', threats, `ai-int-${randomUUID()}`);
});

describe('AI 問答的查詢(原始 TRAFFIC / 威脅類)', () => {
  it('1 個 IP:連線組合依小時累計,次數、位元組、結束原因正確', async () => {
    const r = await reader.aiTrafficFlows({ ips: ['10.89.0.1'], ports: [] }, H, H + HOUR, 1000);
    assert.equal(r.truncated, false);
    assert.equal(r.rows.reduce((s, x) => s + x.n, 0), N);
    assert.equal(r.rows.reduce((s, x) => s + x.bytes, 0), N * 1000);
    const deny = r.rows.filter((x) => x.action === 'deny');
    assert.equal(deny.reduce((s, x) => s + x.n, 0), 8);
    assert.deepEqual(deny[0]!.end, [['policy-deny', deny[0]!.n]]);
    assert.equal(r.rows[0]!.hour, taipeiText(H).slice(0, 13));
    assert.match(r.rows[0]!.first, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(r.rows[0]!.src, '10.89.0.1', 'IPv4 轉回原格式');
  });

  it('2 個 IP 是兩者之間、Port 是目的 Port、CIDR;limit 超過時 truncated', async () => {
    const two = await reader.aiTrafficFlows({ ips: ['10.89.0.1', '10.89.9.1'], ports: [] }, H, H + HOUR, 1000);
    assert.equal(two.rows.reduce((s, x) => s + x.n, 0), N / 4);
    const port = await reader.aiTrafficFlows({ ips: ['10.89.0.0/24'], ports: [22] }, H, H + HOUR, 1000);
    assert.equal(port.rows.reduce((s, x) => s + x.n, 0), N / 2);
    const cut = await reader.aiTrafficFlows({ ips: ['10.89.0.1'], ports: [] }, H, H + HOUR, 2);
    assert.equal(cut.rows.length, 2);
    assert.equal(cut.truncated, true);
  });

  it('範例:每種組合(來源、目的、Port、動作、規則)一筆,最多 limit 筆', async () => {
    const all = await reader.aiTrafficSamples({ ips: ['10.89.0.1'], ports: [] }, H, H + HOUR, 15);
    const keys = new Set(all.map((r) => [r.src, r.dst, r.dport, r.action, r.rule].join('|')));
    assert.equal(keys.size, all.length);
    assert.ok(all.length > 4 && all.length <= 15);
    assert.equal((await reader.aiTrafficSamples({ ips: ['10.89.0.1'], ports: [] }, H, H + HOUR, 3)).length, 3);
  });

  it('威脅類:依組合累計、次數乘 Repeat Count;只比對 IP', async () => {
    const r = await reader.aiThreatGroups(['threat', 'url'], { ips: ['10.89.9.1'], ports: [] }, H, H + HOUR, 100);
    const mine = r.rows.filter((x) => x.name === 'AI Int Test(7)');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.type, 'threat');
    assert.equal(mine[0]!.n, 6 * 3);
    assert.equal(mine[0]!.src, '198.51.100.89');
    assert.deepEqual(await reader.aiThreatGroups([], { ips: ['10.89.9.1'], ports: [] }, H, H + HOUR, 100), { rows: [], truncated: false });
  });
});

describe('AI 分析超過 30 天的彙總(pa_heat_1d、每小時彙總)', () => {
  it('每天彙總:連線數、阻擋、威脅 high 和寫入的筆數一致', async () => {
    const t = sumDays(await reader.aiDays(D, D + 24 * HOUR));
    assert.equal(t.sessions - base.sessions, N);
    assert.equal(t.deny - base.deny, 8);
    assert.equal(t.high - base.high, 6, '威脅不乘 repeat_count(同熱力圖 X9)');
  });

  it('排行:動作、App、區域、來源 IP、被擋的來源', async () => {
    const t = await reader.aiTops(H, H + HOUR, 100);
    assert.ok((t.actions.deny ?? 0) >= 8);
    assert.equal(t.app.find((x) => x[0] === 'ai-int-app')?.[1], N);
    assert.ok(t.zone.some((x) => x[0] === 'LAN → Server'));
    assert.deepEqual(t.src.find((x) => x[0] === '10.89.0.1'), ['10.89.0.1', N, N * 1000]);
    assert.equal(t.blockSrc.find((x) => x[0] === '10.89.0.1')?.[1], 8);
  });
});
