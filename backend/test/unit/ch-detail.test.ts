/**
 * C3 Log 明細查詢改查 ClickHouse(工作模式,D6):
 *   - trafficWhere:條件一律放參數(值不出現在 SQL),IP 完全相同 / CIDR / 萬用字元、Port、動作、q
 *   - 來源:source 參數 > 設定 NETOPS_PA_DETAIL_SOURCE(預設 ftp);clickhouse 期間最長 30 天
 *   - 結果格式同 FTP 來源(分頁、匯出、取消),result.source 為 clickhouse
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { trafficWhere } from '../../src/infra/clickhouse/reader.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createFakeReader, trafficRecord, type FakeReader } from '../fixtures/fake-ch.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

const F = Date.parse('2026-11-11T00:00:00+08:00');
const T = F + 3600_000;

describe('trafficWhere(明細條件 → SQL)', () => {
  it('值都放參數,不出現在 SQL', () => {
    const evil = "1' OR 1=1 --";
    const { where, params } = trafficWhere({ fromMs: F, toMs: T, app: evil, rule: evil, user: evil, country: evil, q: evil, action: evil, proto: evil, fromZone: evil, src: evil });
    const sql = where.join(' AND ');
    assert.ok(!sql.includes('OR 1=1'));
    assert.ok(Object.values(params).some((v) => String(v).includes('OR 1=1')));
    assert.equal(params.from, F / 1000);
    assert.equal(params.to, T / 1000);
  });

  it('IP:完全相同用 toIPv6OrNull、IPv4 CIDR 換成 IPv6 前綴(+96)、萬用字元換 LIKE 並跳脫;NAT 欄位空白不比對', () => {
    const exact = trafficWhere({ fromMs: F, toMs: T, src: '10.1.2.3' });
    assert.match(exact.where[2]!, /src = toIPv6OrNull\(\{p0:String\}\) OR \(nat_src != toIPv6\('::'\) AND nat_src = toIPv6OrNull/);
    const cidr = trafficWhere({ fromMs: F, toMs: T, dst: '10.10.0.0/16' });
    assert.match(cidr.where[2]!, /dst BETWEEN tupleElement\(IPv6CIDRToRange/);
    assert.equal(cidr.params.p1, 112);
    const wild = trafficWhere({ fromMs: F, toMs: T, ip: '10.10.*' });
    assert.match(wild.where[2]!, /LIKE \{p0:String\}/);
    assert.equal(wild.params.p0, '10.10.%');
    // 不合法的 CIDR:同 FTP 版以字首比對
    const bad = trafficWhere({ fromMs: F, toMs: T, src: '10.10/99' });
    assert.match(bad.where[2]!, /startsWith/);
  });

  it('Port 清單、動作 allow / block、q 比對多個文字欄位', () => {
    const w = trafficWhere({ fromMs: F, toMs: T, port: '443, 8443,99999', action: 'block', q: 'fin' });
    assert.ok(w.where.includes(`action != 'allow'`));
    assert.equal(w.params.p0, '[443,8443]');
    assert.match(w.where.find((x) => x.includes('concat('))!, /positionCaseInsensitiveUTF8\(concat\(/);
    assert.ok(trafficWhere({ fromMs: F, toMs: T, port: '99999' }).where.includes('0'));
  });
});

describe('明細 API 來源切換', () => {
  let t: TestApp;
  let reader: FakeReader;
  before(async () => {
    reader = createFakeReader(Array.from({ length: 30 }, (_, i) => trafficRecord(`2026/11/11 00:${String(i).padStart(2, '0')}:00`, i)));
    t = await createTestApp({ ftp: createFakeFtp(), chReader: reader, chNow: () => Date.parse('2026-11-11T03:10:00+08:00'), env: { NETOPS_CH_SUMMARY_MINUTES: '0', PA_SEARCH_LIMIT: '20' } });
    await t.app.chSummary!.runOnce();
  });
  after(async () => t.close());

  const submit = (body: object, emp?: string) => t.call({ method: 'POST', url: '/v1/pa/log-searches', payload: body, emp });
  async function done(id: string) {
    await waitFor(async () => !['queued', 'running'].includes((await t.call({ url: `/v1/pa/log-searches/${id}` })).json().status));
    return (await t.call({ url: `/v1/pa/log-searches/${id}` })).json();
  }
  const range = { from: '2026-11-11T00:00:00+08:00', to: '2026-11-11T00:59:00+08:00' };

  it('source=clickhouse:結果格式同 FTP,依時間由舊到新;分頁、匯出、取消可用', async () => {
    const res = await submit({ ...range, src: '10.10.1.1', source: 'clickhouse' });
    assert.equal(res.statusCode, 202, res.body);
    const job = await done(res.json().id);
    assert.equal(job.status, 'done');
    assert.equal(job.result.source, 'clickhouse');
    assert.equal(job.result.total, 6);
    assert.equal(job.result.stopReason, '');
    const rows = (await t.call({ url: `/v1/pa/log-searches/${job.id}/rows?pageSize=2` })).json();
    assert.equal(rows.total, 6);
    assert.equal(rows.items[0].src, '10.10.1.1');
    assert.equal(rows.items[0].time, '2026-11-11T00:01:00+08:00');
    assert.deepEqual(Object.keys(rows.items[0]).slice(0, 4), ['time', 'subtype', 'action', 'src']);
    const csv = await t.call({ url: `/v1/pa/log-searches/${job.id}/export` });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers['content-type'] as string, /text\/csv/);
    // 別人查不到
    assert.equal((await t.call({ url: `/v1/pa/log-searches/${job.id}`, emp: 'S999999' })).statusCode, 404);
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa/log-searches/${job.id}` })).statusCode, 204);
    assert.equal((await t.call({ url: `/v1/pa/log-searches/${job.id}` })).statusCode, 404);
  });

  it('超過筆數上限:stopReason limit', async () => {
    const job = await done((await submit({ ...range, source: 'clickhouse', limit: 5 })).json().id);
    assert.equal(job.result.total, 5);
    assert.equal(job.result.stopReason, 'limit');
  });

  it('預設來源 ftp(並行 2 週);auto 在 ClickHouse 範圍內才查 ClickHouse', async () => {
    // 假 FTP 沒有檔案 → FTP 來源回 404
    const ftp = await submit(range);
    assert.equal(ftp.statusCode, 404);
    assert.equal(ftp.json().code, 'NETOPS_PA_NO_DATA');
    const auto = await submit({ ...range, source: 'auto' });
    assert.equal(auto.statusCode, 202);
    assert.equal((await done(auto.json().id)).result.source, 'clickhouse');
    // 期間開始早於 ClickHouse 最早一小時 → FTP
    assert.equal((await submit({ from: '2026-11-10T23:00:00+08:00', to: range.to, source: 'auto' })).statusCode, 404);
  });

  it('ClickHouse 超過 30 天回 400;期間沒有資料回 404;連不上:指定 503、auto 改走 FTP', async () => {
    assert.equal((await submit({ from: '2026-10-11T00:00:00+08:00', to: '2026-11-11T00:00:00+08:00', source: 'clickhouse' })).statusCode, 400);
    const none = await submit({ from: '2026-11-11T05:00:00+08:00', to: '2026-11-11T06:00:00+08:00', source: 'clickhouse' });
    assert.equal(none.statusCode, 404);
    reader.failing = true;
    try {
      const res = await submit({ ...range, source: 'clickhouse' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
      assert.ok(!res.body.includes('ECONNREFUSED'));
      // auto:改走 FTP(假 FTP 沒有檔案 → 404)
      assert.equal((await submit({ ...range, source: 'auto' })).statusCode, 404);
    } finally {
      reader.failing = false;
    }
  });

  it('工作執行中 ClickHouse 失敗:工作 failed,錯誤代碼 NETOPS_CLICKHOUSE_UNAVAILABLE', async () => {
    const orig = reader.searchTraffic;
    reader.searchTraffic = async () => {
      throw new (await import('../../src/infra/clickhouse/index.js')).ClickHouseError('x', 241, 500);
    };
    try {
      const job = await done((await submit({ ...range, source: 'clickhouse' })).json().id);
      assert.equal(job.status, 'failed');
      assert.equal(job.error.code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
    } finally {
      reader.searchTraffic = orig;
    }
  });
});
