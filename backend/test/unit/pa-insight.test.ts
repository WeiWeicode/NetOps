/**
 * V-b1 分析儀表板(docs/VIZ-RULES-DESIGN.md §4.4):粒度、國家對照、桑基圖、null vs 0、前一期、期間上限。ClickHouse 以假 HeatReader 注入。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { HeatReader, HeatRow } from '../../src/infra/clickhouse/heat.js';
import { parseDay } from '../../src/modules/pa-heat/heat.js';
import { countryIso2 } from '../../src/modules/pa-insight/countries.js';
import { allowDenyGrain, toCountries, toSankey, trendGrain } from '../../src/modules/pa-insight/service.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createTestApp, type TestApp } from '../helpers.js';

const NOW = Date.parse('2026-11-11T10:07:30+08:00');
const row = (t: number, x: Partial<HeatRow> = {}): HeatRow => ({ t, sessions: 0, bytes: 0, sent: 0, recv: 0, deny: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, topBytes: [], topDeny: [], topThreat: [], ...x });

describe('儀表板純函式', () => {
  it('粒度:≤ 2 天每 5 分鐘、≤ 31 天每小時、其他每天;Allow vs Deny ≤ 2 天每小時', () => {
    assert.equal(trendGrain(1), '5m');
    assert.equal(trendGrain(2), '5m');
    assert.equal(trendGrain(31), '1h');
    assert.equal(trendGrain(32), '1d');
    assert.equal(allowDenyGrain(2), '1h');
    assert.equal(allowDenyGrain(3), '1d');
  });

  it('PA 國家名稱 → ISO2(含 PAN-OS 寫法);內網範圍排除、對不到的併「未知」', () => {
    assert.equal(countryIso2('United States'), 'US');
    assert.equal(countryIso2('Taiwan'), 'TW');
    assert.equal(countryIso2('Russian Federation'), 'RU');
    assert.equal(countryIso2('Iran Islamic Republic Of'), 'IR');
    assert.equal(countryIso2('Korea Republic Of'), 'KR');
    assert.equal(countryIso2('Hong Kong'), 'HK');
    assert.equal(countryIso2('10.0.0.0-10.255.255.255'), null);
    const c = toCountries([
      { country: 'United States', count: 5, critical: 1, high: 0 },
      { country: '10.0.0.0-10.255.255.255', count: 99, critical: 0, high: 0 },
      { country: 'Asia Pacific Region', count: 2, critical: 0, high: 1 },
      { country: 'Atlantis', count: 1, critical: 0, high: 0 },
    ]);
    assert.deepEqual(
      c.map((x) => [x.country, x.iso2, x.count, x.high]),
      [
        ['United States', 'US', 5, 0],
        ['未知', null, 3, 1],
      ],
    );
  });

  it('桑基圖:三層節點、連線合併、App 空字串為「其他」', () => {
    const s = toSankey([
      { fromZone: 'LAN', app: 'ssl', toZone: 'WAN', bytes: 10 },
      { fromZone: 'LAN', app: '', toZone: 'WAN', bytes: 3 },
      { fromZone: 'DMZ', app: 'ssl', toZone: 'WAN', bytes: 5 },
    ]);
    assert.deepEqual(s.nodes.map((n) => [n.id, n.layer]).sort(), [['a:ssl', 1], ['a:其他', 1], ['d:WAN', 2], ['z:DMZ', 0], ['z:LAN', 0]].sort());
    assert.equal(s.links.find((l) => l.source === 'a:ssl' && l.target === 'd:WAN')!.bytes, 15);
    assert.equal(s.links[0]!.bytes, 15);
  });
});

function fakeReader(): HeatReader {
  const day = parseDay('2026-11-10');
  return {
    heatRows: async (grain: string, from: number, to: number) => {
      if (grain === '1d' && to <= parseDay('2026-11-05')) return [row(parseDay('2026-11-01'), { high: 4 })];
      if (grain === '1h') return [row(day + 3600_000, { sessions: 100, deny: 10, sent: 1000, recv: 2000, critical: 1, high: 2 })].filter((r) => r.t >= from && r.t < to);
      if (grain === '5m') return [row(day + 3600_000, { sessions: 100, deny: 10, sent: 1000, recv: 2000, critical: 1, high: 2 })].filter((r) => r.t >= from && r.t < to);
      return [];
    },
    heatEarliest: async () => parseDay('2026-11-10') + 1800_000,
    insightFlows: async () => [{ fromZone: 'LAN', app: 'ssl', toZone: 'WAN', bytes: 3000 }],
    insightTopApps: async () => [{ app: 'ssl', bytes: 3000, sessions: 100 }],
    insightTopSrc: async () => [{ ip: '10.0.0.1', bytes: 3000, sent: 1000, recv: 2000, sessions: 100 }],
    threatCountries: async () => [{ country: 'China', count: 3, critical: 1, high: 2 }],
    threatTopInternalSrc: async () => [{ ip: '10.0.0.9', count: 3, high: 3 }],
    threatTopNames: async () => [{ name: 'X(1)', severity: 'high', count: 3 }],
    slice: async () => {
      throw new Error('not used');
    },
  } as unknown as HeatReader;
}

describe('GET /v1/pa/insight/*', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ ftp: createFakeFtp(), heat: { reader: fakeReader(), now: () => NOW } });
  });
  after(() => t.close());

  it('流量:2 天每 5 分鐘、資料起點之前 null、之後 0;Allow = sessions − deny', async () => {
    const res = await t.call({ url: '/v1/pa/insight/traffic?from=2026-11-10&to=2026-11-11' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.bucketSeconds, 300);
    assert.equal(b.allowDenyBucketSeconds, 3600);
    assert.equal(b.trend[0].sessions, null);
    assert.equal(b.trend[6].sessions, 0);
    const p = b.trend.find((x: { t: string }) => x.t === '2026-11-10T01:00:00+08:00');
    assert.deepEqual([p.sent, p.recv, p.sessions], [1000, 2000, 100]);
    const ad = b.allowDeny.find((x: { t: string }) => x.t === '2026-11-10T01:00:00+08:00');
    assert.deepEqual([ad.allow, ad.deny], [90, 10]);
    assert.equal(b.sankey.links.length, 2);
    assert.equal(b.topIp[0].ip, '10.0.0.1');
    assert.equal(b.coverage.since, '2026-11-10T00:30:00+08:00');
  });

  it('威脅:計分卡、國家 ISO2、伺服器排行為 null 並附說明;前一期資料不足時 prev 為 null', async () => {
    const b = (await t.call({ url: '/v1/pa/insight/threat?from=2026-11-10&to=2026-11-11' })).json();
    assert.equal(b.score.critical, 1);
    assert.equal(b.score.high, 2);
    assert.equal(b.score.prev, null);
    assert.equal(b.score.prevFrom, '2026-11-08');
    assert.equal(b.countries[0].iso2, 'CN');
    assert.equal(b.topServerDst, null);
    assert.ok(b.notes.length > 0);
  });

  it('期間超過 90 天、結束早於開始、晚於今天回 400', async () => {
    assert.equal((await t.call({ url: '/v1/pa/insight/traffic?from=2026-08-12&to=2026-11-10' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa/insight/traffic?from=2026-08-13&to=2026-11-10' })).statusCode, 200);
    assert.equal((await t.call({ url: '/v1/pa/insight/threat?from=2026-11-10&to=2026-11-09' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa/insight/threat?from=2026-11-10&to=2026-11-12' })).statusCode, 400);
  });
});
