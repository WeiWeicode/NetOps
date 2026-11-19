/**
 * 戰情室 WR-1、WR-2(docs/WARROOM-PLAN.md §3):假 Redis + 假 GeoIP。
 *   - 純函式:私有位址、CIDR 對照、設定檔驗證、方向判斷、聚合(國家 / Top 攻擊 IP / 其他 / 網段 / 速率)
 *   - API:warroom、risk 的回應、範例網段、Redis 不可用 partial、快取、SSE 衍生欄位
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { loadGeoIp, NO_GEOIP, type GeoIp } from '../../src/infra/geoip/index.js';
import { createPaLiveRedis, minuteBucket } from '../../src/infra/redis/index.js';
import {
  aggregateWarroom,
  createClassifier,
  createSegmentMatcher,
  EXAMPLE_CONFIG,
  isDenyAction,
  isPrivateIp,
  parseCidr,
  parseWarroomConfig,
  type WarroomConfig,
} from '../../src/modules/pa-live/warroom.js';
import { FakeRedis } from '../fixtures/fake-redis.js';
import { createTestApp, type TestApp } from '../helpers.js';

const COUNTRIES: Record<string, [string, string]> = {
  '8.8.8.8': ['US', 'United States'],
  '1.1.1.1': ['AU', 'Australia'],
  '5.5.5.5': ['RU', 'Russia'],
  '6.6.6.6': ['CN', 'China'],
};
const fakeGeo: GeoIp = {
  available: true,
  version: '2026-11-01',
  lookup: (ip) => (COUNTRIES[ip] ? { code: COUNTRIES[ip]![0], name: COUNTRIES[ip]![1] } : null),
};

const CFG: WarroomConfig = {
  gauge: { throughputMaxBps: 1e9, sessionMax: 64000 },
  segments: [
    { id: 'server', label: '伺服器區', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] },
    { id: 'office', label: '辦公', kind: 'vlan', icon: 'office', cidrs: ['10.10.0.0/16'] },
  ],
};

describe('戰情室純函式', () => {
  it('私有位址判斷', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '127.0.0.1', 'fd00::1', 'fe80::1', '::1']) assert.ok(isPrivateIp(ip), ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::8888', '', 'garbage']) assert.ok(!isPrivateIp(ip), ip);
  });
  it('CIDR 解析與最長前綴對照', () => {
    assert.equal(parseCidr('10.10.130.0/33'), null);
    assert.equal(parseCidr('300.1.1.1/8'), null);
    const m = createSegmentMatcher(CFG.segments);
    assert.equal(m('10.10.130.5'), 'server');
    assert.equal(m('10.10.1.5'), 'office');
    assert.equal(m('10.11.0.1'), null);
    assert.equal(m('fd00::1'), null);
  });
  it('阻擋動作', () => {
    for (const a of ['deny', 'drop', 'reset-both', 'reset-client', 'block-url', 'sinkhole']) assert.ok(isDenyAction(a), a);
    for (const a of ['allow', 'alert', '', undefined]) assert.ok(!isDenyAction(a));
  });
  it('設定檔驗證:預設滿格值、錯誤指出欄位', () => {
    const c = parseWarroomConfig({ segments: [{ id: 'a', label: 'A', kind: 'vlan', cidrs: ['10.0.0.0/8'] }] });
    assert.deepEqual(c.gauge, { throughputMaxBps: 1e9, sessionMax: 64000 });
    assert.equal(c.segments[0]!.icon, 'network');
    assert.throws(() => parseWarroomConfig({ segments: [{ id: 'unmatched', label: 'x', kind: 'vlan', cidrs: ['10.0.0.0/8'] }] }), /id/);
    assert.throws(() => parseWarroomConfig({ segments: [{ id: 'a', label: 'x', kind: 'zone', cidrs: ['10.0.0.0/8'] }] }), /kind/);
    assert.throws(() => parseWarroomConfig({ segments: [{ id: 'a', label: 'x', kind: 'vlan', cidrs: ['10.0.0.0/40'] }] }), /cidrs/);
    assert.throws(() => parseWarroomConfig({ gauge: { sessionMax: -1 }, segments: [] }), /sessionMax/);
    assert.throws(() => parseWarroomConfig([]), /物件/);
    // 內建範例本身要通過驗證
    assert.doesNotThrow(() => parseWarroomConfig(EXAMPLE_CONFIG));
  });
  it('方向:外部端查國家、內部端對網段', () => {
    const c = createClassifier(fakeGeo, createSegmentMatcher(CFG.segments));
    assert.deepEqual(c({ src: '8.8.8.8', dst: '10.10.130.5' }), { externalIp: '8.8.8.8', internalIp: '10.10.130.5', country: 'US', countryName: 'United States', inbound: true, segment: 'server' });
    // 連出:外部端是目的
    assert.equal(c({ src: '10.10.1.1', dst: '1.1.1.1' }).country, 'AU');
    assert.equal(c({ src: '10.10.1.1', dst: '1.1.1.1' }).segment, 'office');
    // 內部互連 / 沒對到網段
    assert.deepEqual(c({ src: '10.10.1.1', dst: '10.99.0.1' }), { externalIp: null, internalIp: '10.99.0.1', country: null, countryName: null, inbound: false, segment: 'unmatched' });
    assert.equal(c({ src: '9.9.9.9', dst: '8.8.8.8' }).segment, 'unmatched');
  });
  it('聚合:國家、Top 攻擊 IP 拆出、其他、網段、速率', () => {
    const c = createClassifier(fakeGeo, createSegmentMatcher(CFG.segments));
    const traffic = [
      ...Array.from({ length: 30 }, () => ({ src: '8.8.8.8', dst: '10.10.130.5', action: 'allow', app: 'ssl', bytes: 100 })),
      ...Array.from({ length: 12 }, () => ({ src: '5.5.5.5', dst: '10.10.130.5', action: 'deny', app: 'ssh' })),
      ...Array.from({ length: 6 }, () => ({ src: '6.6.6.6', dst: '10.10.1.1', action: 'allow', app: 'web' })),
      { src: '10.10.1.1', dst: '10.10.1.2', action: 'allow' },
    ];
    const threats = [{ src: '5.5.5.5', dst: '10.10.130.5', name: 'brute', severity: 'high' }];
    const r = aggregateWarroom(traffic, threats, c, CFG, 60, { topCountries: 1, topIps: 3, ipDenyRatio: 0.5, ipMinDeny: 10 });
    assert.deepEqual(
      r.sources.map((s) => s.id),
      ['cc:US', 'ip:5.5.5.5', 'other', 'lan'],
    );
    const us = r.sources[0]!;
    assert.equal(us.label, 'United States');
    assert.equal(us.conn, 30);
    assert.deepEqual(us.topDst, [{ key: '10.10.130.5', count: 30 }]);
    const ip = r.sources[1]!;
    assert.equal(ip.kind, 'ip');
    assert.equal(ip.country, 'RU');
    assert.equal(ip.deny, 12);
    assert.equal(ip.threat, 1);
    // RU 的次數拆給 Top IP 後為 0,CN 併入其他
    assert.equal(r.sources[2]!.conn, 6);
    assert.deepEqual(
      r.segments.map((s) => [s.id, s.conn, s.threat]),
      [
        ['server', 42, 1],
        ['office', 7, 0],
      ],
    );
    assert.deepEqual(
      r.links.find((l) => l.source === 'cc:US'),
      { source: 'cc:US', segment: 'server', conn: 0.5, allow: 0.5, deny: 0, threat: 0, outConn: 0, outDeny: 0, outThreat: 0 },
    );
    const atk = r.links.find((l) => l.source === 'ip:5.5.5.5')!;
    assert.equal(atk.deny, 0.2);
    assert.equal(atk.threat, 0.017);
  });
  it('聚合:連出被阻擋的外部目的不算攻擊 IP', () => {
    const c = createClassifier(fakeGeo, createSegmentMatcher(CFG.segments));
    const traffic = Array.from({ length: 20 }, () => ({ src: '10.10.1.1', dst: '5.5.5.5', action: 'deny' }));
    const r = aggregateWarroom(traffic, [], c, CFG, 60);
    assert.deepEqual(
      r.sources.map((s) => s.id),
      ['cc:RU'],
    );
    assert.equal(r.sources[0]!.deny, 20);
  });
  it('聚合:抽樣時次數與速率按比例放大', () => {
    const c = createClassifier(fakeGeo, createSegmentMatcher(CFG.segments));
    const traffic = Array.from({ length: 10 }, () => ({ src: '8.8.8.8', dst: '10.10.130.5', action: 'allow' }));
    // 10 筆只涵蓋 100 秒(期間 300 秒 → 放大 3 倍)
    const r = aggregateWarroom(traffic, [], c, CFG, 300, undefined, 3);
    assert.equal(r.sources[0]!.conn, 30);
    assert.equal(r.links[0]!.conn, 0.1);
  });
  it('方向(WD-1):連入 / 連出 / 內部互連 / 轉送', () => {
    const c = createClassifier(fakeGeo, createSegmentMatcher(CFG.segments));
    const traffic = [
      // 連入:US → 伺服器區 4 筆(1 筆阻擋)
      ...Array.from({ length: 3 }, () => ({ src: '8.8.8.8', dst: '10.10.130.5', action: 'allow' })),
      { src: '8.8.8.8', dst: '10.10.130.5', action: 'deny' },
      // 連出:伺服器區 → US 6 筆(2 筆阻擋)
      ...Array.from({ length: 4 }, () => ({ src: '10.10.130.9', dst: '8.8.8.8', action: 'allow' })),
      ...Array.from({ length: 2 }, () => ({ src: '10.10.130.9', dst: '8.8.8.8', action: 'drop' })),
      // 內部互連、外部對外部的轉送:都不算連出
      { src: '10.10.1.1', dst: '10.10.130.5', action: 'allow' },
      { src: '1.1.1.1', dst: '8.8.8.8', action: 'allow' },
    ];
    const threats = [
      { src: '8.8.8.8', dst: '10.10.130.5' },
      { src: '10.10.130.9', dst: '8.8.8.8' },
      { src: '10.10.130.9', dst: '8.8.8.8' },
    ];
    const r = aggregateWarroom(traffic, threats, c, CFG, 10);
    const us = r.links.find((l) => l.source === 'cc:US' && l.segment === 'server')!;
    assert.deepEqual(us, { source: 'cc:US', segment: 'server', conn: 1, allow: 0.7, deny: 0.3, threat: 0.3, outConn: 0.6, outDeny: 0.2, outThreat: 0.2 });
    assert.equal(r.sources.find((s) => s.id === 'cc:US')!.outConn, 6);
    assert.equal(r.sources.find((s) => s.id === 'cc:US')!.conn, 10);
    const lan = r.links.find((l) => l.source === 'lan')!;
    assert.equal(lan.outConn, 0);
    assert.equal(r.sources.find((s) => s.id === 'lan')!.outConn, 0);
    // 轉送(兩端外部)來源是 AU、網段 unmatched,不算連出
    const fwd = r.links.find((l) => l.segment === 'unmatched')!;
    assert.equal(fwd.outConn, 0);
    assert.equal(r.segments.find((s) => s.id === 'server')!.outConn, 6);
    assert.equal(r.segments.find((s) => s.id === 'server')!.conn, 11);
  });
  it('方向(WD-1):抽樣放大套用到連出;Top 攻擊 IP 只算連入', () => {
    const c = createClassifier(fakeGeo, createSegmentMatcher(CFG.segments));
    const traffic = [
      ...Array.from({ length: 12 }, () => ({ src: '5.5.5.5', dst: '10.10.130.5', action: 'deny' })),
      // 連出到同一個外部 IP:不併進攻擊 IP 節點,留在國家來源
      ...Array.from({ length: 5 }, () => ({ src: '10.10.1.1', dst: '5.5.5.5', action: 'allow' })),
    ];
    const r = aggregateWarroom(traffic, [], c, CFG, 100, undefined, 2);
    const ip = r.sources.find((s) => s.id === 'ip:5.5.5.5')!;
    assert.equal(ip.conn, 24);
    assert.equal(ip.outConn, 0);
    const ru = r.sources.find((s) => s.id === 'cc:RU')!;
    assert.equal(ru.conn, 10);
    assert.equal(ru.outConn, 10);
    const ipLink = r.links.find((l) => l.source === 'ip:5.5.5.5')!;
    assert.equal(ipLink.outConn, 0);
    const ruLink = r.links.find((l) => l.source === 'cc:RU')!;
    assert.equal(ruLink.conn, 0.1);
    assert.equal(ruLink.outConn, 0.1);
  });
  it('GeoIP 檔案不存在 → 不可用', () => {
    assert.equal(loadGeoIp(null), NO_GEOIP);
    const g = loadGeoIp(path.join(process.cwd(), 'no-such.mmdb'));
    assert.equal(g.available, false);
    assert.equal(g.lookup('8.8.8.8'), null);
  });
});

describe('戰情室 API', () => {
  let t: TestApp;
  let redis: FakeRedis;
  let clock = Date.now();
  before(async () => {
    redis = new FakeRedis();
    t = await createTestApp({ paLiveRedis: createPaLiveRedis(redis), geoIp: fakeGeo, warroomNow: () => clock });
  });
  after(async () => t.close());
  beforeEach(() => {
    redis.fail = false;
    redis.hashes.clear();
    redis.streams.clear();
    redis.zsets.clear();
    // 跳過上一個測試的快取
    clock += 120_000;
  });

  it('沒有設定檔:範例網段;聚合與 KPI', async () => {
    const now = clock;
    for (let i = 0; i < 20; i++) redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5', action: i < 5 ? 'deny' : 'allow', app: 'ssl' }, now - 10_000 - i);
    redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5', action: 'deny' }, now - 10 * 60_000); // 期間外
    redis.addLog('threat', { src: '8.8.8.8', dst: '10.10.130.5', name: 'x', severity: 'high' }, now - 5000);
    redis.setAgg('threat', minuteBucket(now), { count: 4 });
    const res = await t.call({ url: '/v1/pa-live/warroom?minutes=5' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.partial, false);
    assert.equal(b.segmentsSource, 'example');
    assert.deepEqual(b.gauge, { throughputMaxBps: 1e9, sessionMax: 64000 });
    assert.equal(b.geo.available, true);
    assert.equal(b.geo.attribution.text, 'IP Geolocation by DB-IP');
    assert.equal(b.sources[0].id, 'cc:US');
    assert.equal(b.sources[0].conn, 20);
    assert.equal(b.sources[0].deny, 5);
    assert.equal(b.sources[0].threat, 1);
    assert.equal(b.segments.find((s: { id: string }) => s.id === 'server').conn, 20);
    assert.deepEqual(b.kpis, { denyPerMin: 5, threat5m: 4 });
    assert.equal(b.sample.complete, true);
    assert.equal(b.links[0].conn, 0.067); // 20 / 300 秒
  });

  it('資料目錄的設定檔優先;格式錯誤時用範例並標示 invalid', async () => {
    const dir = path.join(t.dataDir, 'warroom');
    const file = path.join(dir, 'warroom.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ gauge: { sessionMax: 128000 }, segments: CFG.segments }));
    let b = (await t.call({ url: '/v1/pa-live/warroom' })).json();
    assert.equal(b.segmentsSource, 'file');
    assert.equal(b.gauge.sessionMax, 128000);
    assert.deepEqual(
      b.segments.map((s: { id: string }) => s.id),
      ['server', 'office'],
    );
    clock += 10_000;
    fs.writeFileSync(file, '{"segments": "x"}');
    // 修改時間解析度:確保與上一次不同
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    b = (await t.call({ url: '/v1/pa-live/warroom' })).json();
    assert.equal(b.segmentsSource, 'invalid');
    fs.rmSync(dir, { recursive: true });
  });

  it('結果快取 3 秒', async () => {
    redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5', action: 'allow' }, clock - 1000);
    const a = (await t.call({ url: '/v1/pa-live/warroom' })).json();
    redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5', action: 'allow' }, clock - 500);
    const b = (await t.call({ url: '/v1/pa-live/warroom' })).json();
    assert.equal(b.sources[0].conn, a.sources[0].conn);
    clock += 3001;
    const c = (await t.call({ url: '/v1/pa-live/warroom' })).json();
    assert.equal(c.sources[0].conn, a.sources[0].conn + 1);
  });

  it('Redis 不可用:200 + partial,不回假資料', async () => {
    redis.fail = true;
    const res = await t.call({ url: '/v1/pa-live/warroom' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.partial, true);
    assert.deepEqual([b.sources, b.segments, b.links], [[], [], []]);
    assert.deepEqual(b.kpis, { denyPerMin: null, threat5m: null });
    assert.match(b.message, /Redis/);
    const r = (await t.call({ url: '/v1/pa-live/risk' })).json();
    assert.equal(r.partial, true);
    assert.equal(r.threats, null);
    // partial 不快取:Redis 恢復後立即重算
    redis.fail = false;
    assert.equal((await t.call({ url: '/v1/pa-live/warroom' })).json().partial, false);
    assert.equal((await t.call({ url: '/v1/pa-live/risk' })).json().partial, false);
  });

  it('不支援的期間 400', async () => {
    assert.equal((await t.call({ url: '/v1/pa-live/warroom?minutes=30' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa-live/risk?minutes=5' })).statusCode, 400);
  });

  it('risk:每分鐘統計 + 樣本補嚴重度與阻擋比例', async () => {
    const now = clock;
    const b0 = minuteBucket(now);
    const b1 = minuteBucket(now - 60_000);
    redis.setAgg('threat', b0, { count: 7, 'severity:critical': 2, 'severity:high': 5 });
    redis.setAgg('threat', b1, { count: 3, 'severity:critical': 1 });
    redis.setAgg('traffic', b0, { count: 100, 'action:allow': 90, 'action:deny': 6, 'action:reset-both': 4 });
    redis.setTop('threat', 'name', b0, { brute: 5, scan: 2 });
    redis.setTop('threat', 'name', b1, { scan: 3 });
    redis.setTop('threat', 'src', b0, { '5.5.5.5': 6, '10.10.1.1': 1 });
    redis.setTop('threat', 'src', b1, { '5.5.5.5': 3 });
    redis.addLog('threat', { src: '5.5.5.5', name: 'brute', severity: 'high', action: 'reset-both' }, now - 1000);
    redis.addLog('threat', { src: '5.5.5.5', name: 'brute', severity: 'critical', action: 'alert' }, now - 2000);
    const res = await t.call({ url: '/v1/pa-live/risk?minutes=60' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.partial, false);
    assert.equal(b.threats, 10);
    assert.equal(b.critical, 3);
    assert.equal(b.denies, 10);
    assert.equal(b.attackSources, 2);
    assert.equal(b.attackSourcesLowerBound, false);
    assert.deepEqual(b.topThreats, [
      { name: 'brute', severity: 'critical', count: 5 },
      { name: 'scan', severity: null, count: 5 },
    ]);
    assert.deepEqual(b.topSources[0], { key: '5.5.5.5', label: 'Russia', country: 'RU', count: 9, denyRatio: 0.5 });
    assert.equal(b.topSources[1].label, '內部');
  });

  it('OpenAPI 必填欄位', async () => {
    const doc = (await t.app.inject({ url: '/openapi.json' })).json();
    for (const p of ['/v1/pa-live/warroom', '/v1/pa-live/risk']) {
      const op = doc.paths[p].get;
      assert.equal(op['x-permission'], 'netops.pa-realtime.read');
      assert.ok(op['x-gherkin'].includes('場景'));
      assert.ok(op.operationId.startsWith('netops.pa-live.'));
    }
  });
});

describe('戰情室:SSE 衍生欄位', () => {
  it('logs 每筆補 country、segment,不改原欄位', async () => {
    const redis = new FakeRedis();
    const t = await createTestApp({ paLiveRedis: createPaLiveRedis(redis), geoIp: fakeGeo, liveStream: { pollMs: 20, heartbeatMs: 1000, snapshotMs: 1000 } });
    try {
      await t.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (t.app.server.address() as import('node:net').AddressInfo).port;
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/pa-live/stream?types=traffic`, { headers: { 'x-internal-token': await t.token() }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      let buf = '';
      const deadline = Date.now() + 5000;
      let added = false;
      while (!/event: logs/.test(buf) && Date.now() < deadline) {
        const { value } = await reader.read();
        buf += new TextDecoder().decode(value);
        if (!added && /event: snapshot/.test(buf)) {
          added = true;
          redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5', action: 'allow' });
        }
      }
      ctrl.abort();
      const line = buf.split('\n').find((l, i, a) => a[i - 1] === 'event: logs' && l.startsWith('data: '))!;
      const item = JSON.parse(line.slice(6)).items[0];
      assert.equal(item.src, '8.8.8.8');
      assert.equal(item.country, 'US');
      assert.equal(item.segment, 'server');
    } finally {
      await t.close();
    }
  });
});

describe('戰情室:GeoIP 不可用', () => {
  it('國家併入其他,geo.available false', async () => {
    const redis = new FakeRedis();
    const t = await createTestApp({ paLiveRedis: createPaLiveRedis(redis), geoIp: NO_GEOIP });
    try {
      redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5', action: 'allow' }, Date.now() - 1000);
      const b = (await t.call({ url: '/v1/pa-live/warroom' })).json();
      assert.equal(b.geo.available, false);
      assert.deepEqual(
        b.sources.map((s: { id: string }) => s.id),
        ['other'],
      );
    } finally {
      await t.close();
    }
  });
});
