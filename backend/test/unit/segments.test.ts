/**
 * 網段設定 SG-1(docs/SEGMENT-SETTINGS-PLAN.md §4、§7 Q7):驗證規則、重疊、版本衝突、歷史備份、預覽、權限宣告。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { GeoIp } from '../../src/infra/geoip/index.js';
import { createPaLiveRedis } from '../../src/infra/redis/index.js';
import { createWarroomStore, HISTORY_KEEP } from '../../src/infra/store/warroom.js';
import { checkWarroomConfig, findOverlaps, parseWarroomConfig, previewSegments, type WarroomConfig } from '../../src/modules/pa-live/warroom.js';
import { FakeRedis } from '../fixtures/fake-redis.js';
import { createTestApp, type TestApp } from '../helpers.js';

const geo: GeoIp = { available: false, version: null, lookup: () => null };
const SEGS = [
  { id: 'server', label: '伺服器區', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] },
  { id: 'office', label: '辦公', kind: 'vlan', icon: 'office', cidrs: ['10.10.0.0/16'] },
];

describe('網段設定純函式', () => {
  it('收集全部欄位錯誤,指出欄位路徑', () => {
    const r = checkWarroomConfig({
      gauge: { sessionMax: 0 },
      segments: [
        { id: 'a', label: 'A', kind: 'vlan', cidrs: ['10.0.0.0/40', '10.1.0.0/16'] },
        { id: 'a', label: '', kind: 'zone', cidrs: [] },
      ],
    });
    assert.equal(r.cfg, null);
    const fields = r.errors.map((e) => e.field);
    for (const f of ['gauge.sessionMax', 'segments[0].cidrs[0]', 'segments[1].id', 'segments[1].label', 'segments[1].kind', 'segments[1].cidrs']) assert.ok(fields.includes(f), f);
    assert.ok(!fields.includes('segments[0].cidrs[1]'));
    // 舊行為不變:parse 丟第一個錯誤;多出的欄位(version 等)略過
    assert.throws(() => parseWarroomConfig({ segments: [{ id: 'unmatched', label: 'x', kind: 'vlan', cidrs: ['10.0.0.0/8'] }] }), /id/);
    assert.equal(parseWarroomConfig({ version: 3, updatedBy: 'x', segments: SEGS }).segments.length, 2);
  });
  it('重疊:只列不同網段之間', () => {
    const o = findOverlaps([...SEGS, { id: 'lab', label: 'Lab', kind: 'vlan', icon: 'pc', cidrs: ['192.168.0.0/24', '192.168.1.0/24'] }] as WarroomConfig['segments']);
    assert.deepEqual(o, [{ a: { id: 'server', cidr: '10.10.130.0/24' }, b: { id: 'office', cidr: '10.10.0.0/16' } }]);
  });
  it('預覽:最精確網段優先、未分類內部 IP Top、兩端外部不算、抽樣放大', () => {
    const cfg = parseWarroomConfig({ segments: SEGS });
    const p = previewSegments(
      [
        { src: '8.8.8.8', dst: '10.10.130.5' },
        { src: '10.10.1.2', dst: '1.1.1.1' },
        { src: '8.8.8.8', dst: '10.99.0.1' },
        { src: '8.8.8.8', dst: '10.99.0.1' },
        { src: '10.10.1.2', dst: '10.98.0.1' },
        { src: '8.8.8.8', dst: '9.9.9.9' },
        { src: 'bad', dst: 'x' },
      ],
      cfg,
      2,
    );
    assert.deepEqual(p.segments, [
      { id: 'server', label: '伺服器區', conn: 2 },
      { id: 'office', label: '辦公', conn: 2 },
    ]);
    assert.deepEqual(p.unmatched, { conn: 6, top: [{ ip: '10.99.0.1', count: 4 }, { ip: '10.98.0.1', count: 2 }] });
  });
});

describe('warroom store 歷史備份(§7 Q7)', () => {
  it('寫入前存舊檔,檔名帶時間與舊版本號,保留 20 份', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-seg-'));
    try {
      const s = createWarroomStore(root);
      s.saveConfig({ version: 1 }, 0, new Date('2026-11-18T00:00:00.000Z'));
      assert.equal(s.historyCount(), 0); // 原本沒有檔案
      s.saveConfig({ version: 2 }, 1, new Date('2026-11-18T00:00:01.000Z'));
      const hist = path.join(root, 'warroom', 'history');
      assert.deepEqual(fs.readdirSync(hist), ['warroom-20261118T000001000Z-v1.json']);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hist, 'warroom-20261118T000001000Z-v1.json'), 'utf8')), { version: 1 });
      for (let i = 0; i < 25; i++) s.saveConfig({ version: 3 + i }, 2 + i, new Date(Date.UTC(2026, 10, 18, 1, 0, i)));
      assert.equal(s.historyCount(), HISTORY_KEEP);
      // 留下最新的 20 份
      assert.ok(fs.readdirSync(hist).includes('warroom-20261118T010024000Z-v26.json'));
      assert.ok(!fs.readdirSync(hist).includes('warroom-20261118T000001000Z-v1.json'));
      assert.deepEqual(s.readConfig(), { version: 27 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('網段設定 API', () => {
  let t: TestApp;
  let redis: FakeRedis;
  let clock = Date.now();
  before(async () => {
    redis = new FakeRedis();
    t = await createTestApp({ paLiveRedis: createPaLiveRedis(redis), geoIp: geo, warroomNow: () => clock });
  });
  after(async () => t.close());
  beforeEach(() => {
    redis.fail = false;
    redis.streams.clear();
    clock += 120_000;
  });

  it('尚未設定:example、version 0;儲存後 version + 1,戰情室立即套用', async () => {
    let g = (await t.call({ url: '/v1/warroom-segments' })).json();
    assert.equal(g.source, 'example');
    assert.equal(g.version, 0);
    const put = await t.call({ method: 'PUT', url: '/v1/warroom-segments', payload: { version: 0, gauge: { sessionMax: 128000 }, segments: SEGS, source: 'example' } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().version, 1);
    assert.equal(put.json().updatedBy, 'S112009 測試S112009');
    assert.equal(put.json().overlaps.length, 1);
    g = (await t.call({ url: '/v1/warroom-segments' })).json();
    assert.equal(g.source, 'file');
    assert.equal(g.version, 1);
    assert.equal(g.gauge.sessionMax, 128000);
    const w = (await t.call({ url: '/v1/pa-live/warroom' })).json();
    assert.equal(w.segmentsSource, 'file');
    assert.equal(w.gauge.sessionMax, 128000);
  });

  it('版本不符 409;驗證失敗 400 附欄位清單;設定不變', async () => {
    const cur = (await t.call({ url: '/v1/warroom-segments' })).json();
    const stale = await t.call({ method: 'PUT', url: '/v1/warroom-segments', payload: { version: cur.version + 5, segments: SEGS } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'NETOPS_SEGMENTS_VERSION_CONFLICT');
    assert.equal(stale.json().details.currentVersion, cur.version);
    const bad = await t.call({ method: 'PUT', url: '/v1/warroom-segments', payload: { version: cur.version, segments: [{ id: 'x', label: 'X', kind: 'vlan', cidrs: ['10.0.0.0/40'] }] } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, 'VALIDATION_FAILED');
    assert.ok(bad.json().details.some((d: { field: string }) => d.field === 'segments[0].cidrs[0]'));
    assert.equal((await t.call({ url: '/v1/warroom-segments' })).json().version, cur.version);
  });

  it('設定檔被人工改壞:invalid 附 errors,仍可覆寫', async () => {
    fs.writeFileSync(path.join(t.dataDir, 'warroom', 'warroom.json'), '{"version": 9, "segments": "x"}');
    const g = (await t.call({ url: '/v1/warroom-segments' })).json();
    assert.equal(g.source, 'invalid');
    assert.equal(g.version, 9);
    assert.ok(g.errors.length > 0);
    const put = await t.call({ method: 'PUT', url: '/v1/warroom-segments', payload: { version: 9, segments: SEGS } });
    assert.equal(put.json().version, 10);
  });

  it('預覽:不寫入;Redis 不可用 partial', async () => {
    const before = (await t.call({ url: '/v1/warroom-segments' })).json().version;
    for (let i = 0; i < 3; i++) redis.addLog('traffic', { src: '8.8.8.8', dst: '10.10.130.5' }, clock - 1000 - i);
    redis.addLog('traffic', { src: '8.8.8.8', dst: '10.77.0.1' }, clock - 2000);
    const p = await t.call({ method: 'POST', url: '/v1/warroom-segment-previews', payload: { segments: SEGS } });
    assert.equal(p.statusCode, 200, p.body);
    const b = p.json();
    assert.equal(b.partial, false);
    assert.equal(b.segments[0].conn, 3);
    assert.deepEqual(b.unmatched.top, [{ ip: '10.77.0.1', count: 1 }]);
    assert.equal((await t.call({ url: '/v1/warroom-segments' })).json().version, before);
    redis.fail = true;
    const d = (await t.call({ method: 'POST', url: '/v1/warroom-segment-previews', payload: { segments: SEGS } })).json();
    assert.equal(d.partial, true);
    assert.equal(d.segments[0].conn, null);
    assert.match(d.message, /Redis/);
    const bad = await t.call({ method: 'POST', url: '/v1/warroom-segment-previews', payload: { segments: [{ id: 'UP', label: 'x', kind: 'vlan', cidrs: ['10.0.0.0/8'] }] } });
    assert.equal(bad.statusCode, 400);
  });

  it('OpenAPI:讀取 / 預覽 netops.segment.read、寫入 netops.segment.write 且稽核 meta', async () => {
    const doc = (await t.app.inject({ url: '/openapi.json' })).json();
    assert.equal(doc.paths['/v1/warroom-segments'].get['x-permission'], 'netops.segment.read');
    assert.equal(doc.paths['/v1/warroom-segments'].put['x-permission'], 'netops.segment.write');
    assert.equal(doc.paths['/v1/warroom-segments'].put['x-audit-level'], 'meta');
    assert.equal(doc.paths['/v1/warroom-segment-previews'].post['x-permission'], 'netops.segment.read');
    const codes = doc['x-permissions'].map((p: { code: string }) => p.code);
    assert.ok(codes.includes('netops.segment.read') && codes.includes('netops.segment.write'));
  });
});
