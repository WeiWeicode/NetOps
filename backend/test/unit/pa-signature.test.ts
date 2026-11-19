/**
 * PA 威脅特徵碼 TS-2(docs/THREAT-SIGNATURE-PLAN.md §4.2、§5.1、§5.2、§5.4、§7、Claude 審查 D1 / D2):
 *   - 核心:ID 擷取、版本差異(added / changed 欄位明細 / removed)、規則覆蓋(TS-Q5)
 *   - Store(D1 / D2):先寫差異檔再換索引、基準日持久保存、保留 90 份清理、路徑白名單
 *   - API:清單 / 篩選 / days 7|30|90 & since、單筆 & 202 按需查詢 & 擁有者隔離、版本歷史與差異、
 *         命中比對(無 IP vs 含 IP 路由分權 TS-Q8、90 天轉 202 工作 D6、ClickHouse 失敗不回 5xx)、
 *         規則覆蓋、手動重新整理冷卻、收集狀態、Redis 降級
 *   - 戰情室:warroom 與 risk 附帶 newSignatureHits(有命中才帶)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPaLiveRedis } from '../../src/infra/redis/index.js';
import { createPaPolicyRedis } from '../../src/infra/redis/pa-policy.js';
import {
  createPaSignatureRedis,
  PA_SIGNATURE_KEYS,
  type PaSignatureClient,
  type PaSignatureRedis,
} from '../../src/infra/redis/pa-signature.js';
import { createPaSignatureStore } from '../../src/infra/store/pa-signature.js';
import { parseSnapshot } from '../../src/modules/pa-policy/core.js';
import {
  computeCoverage,
  diffSignatures,
  extractThreatId,
  parseProfiles,
  toCompactEntry,
  type SigItem,
} from '../../src/modules/pa-signature/core.js';
import { createFakeReader, type FakeReader } from '../fixtures/fake-ch.js';
import { FakeRedis } from '../fixtures/fake-redis.js';
import { FakePolicyClient, HITS as POLICY_HITS, OBJECTS, rule as policyRule } from '../fixtures/pa-policy.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

/** 假的 Redis(實作 PaSignatureClient 用到的指令;含 multi / ttl / del) */
class FakeSigRedisClient implements PaSignatureClient {
  strings = new Map<string, { v: string; exp: number | null }>();
  hashes = new Map<string, { v: Record<string, string>; exp: number | null }>();
  lists = new Map<string, string[]>();
  fail = false;
  clock = () => Date.now();

  private check() {
    if (this.fail) throw new Error('ECONNREFUSED');
  }
  async get(k: string) {
    this.check();
    const e = this.strings.get(k);
    return e && (e.exp === null || e.exp > this.clock()) ? e.v : null;
  }
  async hgetall(k: string) {
    this.check();
    const e = this.hashes.get(k);
    if (!e || (e.exp !== null && e.exp <= this.clock())) return {};
    return { ...e.v };
  }
  async set(k: string, v: string, _ex: 'EX', sec: number, nx?: 'NX') {
    this.check();
    if (nx && (await this.get(k)) !== null) return null;
    this.strings.set(k, { v, exp: this.clock() + sec * 1000 });
    return 'OK' as const;
  }
  async ttl(k: string) {
    this.check();
    const e = this.strings.get(k);
    if (!e || (e.exp !== null && e.exp <= this.clock())) return -2;
    return e.exp === null ? -1 : Math.ceil((e.exp - this.clock()) / 1000);
  }
  async del(...ks: string[]) {
    for (const k of ks) {
      this.strings.delete(k);
      this.hashes.delete(k);
      this.lists.delete(k);
    }
    return ks.length;
  }
  multi(commands: (string | number)[][]) {
    return {
      exec: async (): Promise<[Error | null, unknown][] | null> => {
        this.check();
        const results: [Error | null, unknown][] = [];
        for (const cmd of commands) {
          const op = String(cmd[0]).toLowerCase();
          const key = String(cmd[1]);
          if (op === 'hset') {
            const prev = this.hashes.get(key)?.v ?? {};
            const next = { ...prev };
            for (let i = 2; i < cmd.length; i += 2) next[String(cmd[i])] = String(cmd[i + 1]);
            this.hashes.set(key, { v: next, exp: this.hashes.get(key)?.exp ?? null });
            results.push([null, (cmd.length - 2) / 2]);
          } else if (op === 'expire') {
            const sec = Number(cmd[2]);
            const h = this.hashes.get(key);
            if (h) h.exp = this.clock() + sec * 1000;
            const s = this.strings.get(key);
            if (s) s.exp = this.clock() + sec * 1000;
            results.push([null, 1]);
          } else if (op === 'lpush') {
            const list = this.lists.get(key) ?? [];
            for (let i = 2; i < cmd.length; i++) list.unshift(String(cmd[i]));
            this.lists.set(key, list);
            results.push([null, list.length]);
          } else {
            results.push([new Error(`unsupported ${op}`), null]);
          }
        }
        return results;
      },
    };
  }
  async quit() {
    return 'OK';
  }

  setHash(k: string, fields: Record<string, string>) {
    const prev = this.hashes.get(k)?.v ?? {};
    this.hashes.set(k, { v: { ...prev, ...fields }, exp: this.hashes.get(k)?.exp ?? null });
  }

  putSnapshot(opts: {
    threatVersion: string;
    hash: string;
    fetchedAt?: string;
    checkedAt?: string;
    vuln: SigItem[];
    spyware: SigItem[];
    profiles?: Record<string, unknown>;
    enabled?: boolean;
  }) {
    const fetchedAt = opts.fetchedAt ?? '2026-11-19T01:00:00Z';
    const checkedAt = opts.checkedAt ?? fetchedAt;
    const meta = {
      fetchedAt,
      checkedAt,
      threatVersion: opts.threatVersion,
      threatReleaseDate: '2026/11/19 00:00:00',
      appVersion: '9173-10354',
      appReleaseDate: '2026/11/19 00:00:00',
      avVersion: '5001-5520',
      avReleaseDate: '2026/11/19 00:30:00',
      wildfireVersion: '955201-958201',
      wildfireReleaseDate: '2026/11/19 00:55:00',
      urlFilteringVersion: '20261119.20001',
      counts: { vulnerability: opts.vuln.length, spyware: opts.spyware.length, total: opts.vuln.length + opts.spyware.length },
      hash: opts.hash,
    };
    this.strings.set(PA_SIGNATURE_KEYS.meta, { v: JSON.stringify(meta), exp: null });
    this.strings.set(PA_SIGNATURE_KEYS.itemsVulnerability, { v: JSON.stringify(opts.vuln), exp: null });
    this.strings.set(PA_SIGNATURE_KEYS.itemsSpyware, { v: JSON.stringify(opts.spyware), exp: null });
    if (opts.profiles) this.strings.set(PA_SIGNATURE_KEYS.profiles, { v: JSON.stringify(opts.profiles), exp: null });
    this.hashes.set(PA_SIGNATURE_KEYS.status, {
      v: {
        state: 'ok',
        lastRunAt: checkedAt,
        lastOkAt: fetchedAt,
        trigger: 'scheduled',
        mgmtCpu: '18',
        durationMs: '4500',
        count: String(opts.vuln.length + opts.spyware.length),
        threatVersion: opts.threatVersion,
        fullFetch: '1',
      },
      exp: null,
    });
    this.hashes.set(PA_SIGNATURE_KEYS.heartbeat, {
      v: { signatureEnabled: opts.enabled === false ? '0' : '1' },
      exp: null,
    });
  }
}

const sig = (id: string, kind: 'vulnerability' | 'spyware', extra: Partial<SigItem> = {}): SigItem => ({
  id,
  kind,
  name: `Sig-${id}`,
  severity: 'high',
  category: kind === 'vulnerability' ? 'code-execution' : 'spyware',
  affectedHost: 'server',
  engineVersion: '9.0',
  defaultAction: 'reset-both',
  cves: [],
  vendorIds: [],
  disabled: false,
  timeAttribute: null,
  ...extra,
});

const PROFILES_SNAP = {
  fetchedAt: '2026-11-19T01:00:00Z',
  vsys: 'vsys1',
  profileGroups: {
    'Grp-Full': { vulnerability: ['strict-vp'], spyware: ['strict-as'], virus: ['default'] },
    'Grp-NoAS': { vulnerability: ['strict-vp'] },
    'Grp-Empty': { virus: ['default'] },
  },
  vulnerabilityProfiles: ['strict-vp', 'default'],
  spywareProfiles: ['strict-as', 'default'],
};

describe('核心:extractThreatId、diffSignatures、computeCoverage', () => {
  it('從「名稱(ID)」與純數字擷取 ID,其餘回 null', () => {
    assert.equal(extractThreatId('HTTP SQL Injection(34567)'), '34567');
    assert.equal(extractThreatId('HTTP SQL Injection (34567)'), '34567');
    assert.equal(extractThreatId(' 547000 '), '547000');
    assert.equal(extractThreatId('NoIdHere'), null);
    assert.equal(extractThreatId('abc(notnum)'), null);
    assert.equal(extractThreatId(''), null);
    assert.equal(extractThreatId(null), null);
  });

  it('diffSignatures 列出 added、changed(含異動欄位前後值)、removed', () => {
    const prevItems = [
      sig('10001', 'vulnerability', { name: 'Old Vuln', severity: 'medium', defaultAction: 'alert', cves: ['CVE-2024-0001'] }),
      sig('10002', 'spyware', { name: 'Removed Spy', severity: 'high' }),
      sig('10003', 'vulnerability', { name: 'Unchanged', severity: 'low' }),
    ];
    const prevMap = Object.fromEntries(prevItems.map((x) => [x.id, toCompactEntry(x)]));
    const nextItems = [
      sig('10001', 'vulnerability', { name: 'Old Vuln', severity: 'critical', defaultAction: 'reset-both', cves: ['CVE-2024-0001', 'CVE-2025-9999'] }),
      sig('10003', 'vulnerability', { name: 'Unchanged', severity: 'low' }),
      sig('10004', 'vulnerability', { name: 'Brand New RCE', severity: 'critical', cves: ['CVE-2026-1234'] }),
    ];
    const diff = diffSignatures(prevMap, nextItems);
    assert.deepEqual(diff.added.map((x) => x.id), ['10004']);
    assert.deepEqual(diff.removed.map((x) => x.id), ['10002']);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]!.id, '10001');
    assert.deepEqual(
      diff.changed[0]!.fields.map((f) => f.field),
      ['severity', 'defaultAction', 'cves'],
    );
    assert.equal(diff.changed[0]!.fields[0]!.before, 'medium');
    assert.equal(diff.changed[0]!.fields[0]!.after, 'critical');
  });

  it('computeCoverage 依 TS-Q5 判斷 allow 規則是否掛 VP / AS,缺群組標 unknown', () => {
    const polSnap = parseSnapshot({
      fetchedAt: '2026-11-19T01:00:00Z',
      hash: 'a'.repeat(64),
      vsys: 'vsys1',
      rules: [
        policyRule(1, 'R-Covered-Group', { profileGroup: 'Grp-Full' }),
        policyRule(2, 'R-Covered-Direct', { profileGroup: null, profiles: { vulnerability: ['strict-vp'], spyware: ['strict-as'] } }),
        policyRule(3, 'R-Missing-AS', { profileGroup: 'Grp-NoAS' }),
        policyRule(4, 'R-Missing-Both', { profileGroup: null, profiles: {} }),
        policyRule(5, 'R-Unknown-Group', { profileGroup: 'NoSuchGroup' }),
        policyRule(6, 'R-Deny-Ignored', { action: 'deny', profileGroup: null }),
        policyRule(7, 'R-Disabled-Ignored', { disabled: true, profileGroup: null }),
      ],
      objects: OBJECTS,
    })!;
    const cov = computeCoverage(polSnap, {}, parseProfiles(PROFILES_SNAP));
    assert.deepEqual(cov.summary, {
      totalAllowEnabled: 5,
      covered: 2,
      missingBoth: 1,
      missingVulnerability: 0,
      missingSpyware: 1,
      unknown: 1,
    });
    assert.deepEqual(
      cov.items.map((x) => [x.name, x.status, x.missing]),
      [
        ['R-Missing-AS', 'missing', ['spyware']],
        ['R-Missing-Both', 'missing', ['vulnerability', 'spyware']],
        ['R-Unknown-Group', 'unknown', []],
      ],
    );
    assert.equal(cov.unprotectedRules.has('R-Missing-AS'), true);
    assert.equal(cov.unprotectedRules.has('R-Missing-Both'), true);
    assert.equal(cov.unprotectedRules.has('R-Covered-Group'), false);

    // 讀不到 vsys1 profiles 時,所有用 profileGroup 的規則都標 unknown(不當成有防護)
    const noProf = computeCoverage(polSnap, {}, null);
    assert.equal(noProf.summary.covered, 1); // 只有 R-Covered-Direct 直接掛
    assert.equal(noProf.summary.unknown, 3); // R-Covered-Group、R-Missing-AS、R-Unknown-Group
  });
});

describe('Store(D1 / D2):寫入順序、持久基準日、保留份數清理、路徑白名單', () => {
  it('commitVersion 固定基準日、保留最新 N 份並清理舊差異檔、拒絕非法版本名', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-sig-store-'));
    try {
      const store = createPaSignatureStore(root, 3);
      for (let i = 1; i <= 5; i++) {
        const ver = `9170-1000${i}`;
        const savedAt = `2026-11-1${i}T00:00:00.000Z`;
        store.commitVersion({
          meta: {
            threatVersion: ver,
            releaseDate: null,
            fetchedAt: savedAt,
            savedAt,
            isBaseline: i === 1,
            counts: { vulnerability: 1, spyware: 0, total: 1 },
            added: i === 1 ? 0 : 1,
            changed: 0,
            removed: 0,
            hash: String(i).repeat(64),
          },
          diff: {
            threatVersion: ver,
            baseVersion: i === 1 ? null : `9170-1000${i - 1}`,
            releaseDate: null,
            fetchedAt: savedAt,
            savedAt,
            isBaseline: i === 1,
            counts: { vulnerability: 1, spyware: 0, total: 1 },
            hash: String(i).repeat(64),
            added: [],
            changed: [],
            removed: [],
          },
          nextIndex: { threatVersion: ver, savedAt, hash: String(i).repeat(64), items: {}, firstSeen: {} },
        });
      }
      const hist = store.readHistoryIndex();
      // D2:基準日固定為第一份,即使第一份差異檔已被滾動淘汰
      assert.equal(hist.baselineAt, '2026-11-11T00:00:00.000Z');
      assert.equal(hist.baselineVersion, '9170-10001');
      assert.deepEqual(hist.versions.map((v) => v.threatVersion), ['9170-10005', '9170-10004', '9170-10003']);
      assert.equal(fs.readdirSync(path.join(root, 'pa-signature', 'history')).length, 3);
      assert.equal(store.readVersionDiff('9170-10001'), null);
      assert.ok(store.readVersionDiff('9170-10005'));
      assert.equal(store.readLatestIndex()?.threatVersion, '9170-10005');
      // 路徑穿越防護
      assert.equal(store.readVersionDiff('../index'), null);
      assert.throws(() =>
        store.commitVersion({
          meta: { threatVersion: '../evil', releaseDate: null, fetchedAt: 'x', savedAt: 'x', isBaseline: false, counts: { vulnerability: 0, spyware: 0, total: 0 }, added: 0, changed: 0, removed: 0, hash: 'a'.repeat(64) },
          diff: { threatVersion: '../evil', baseVersion: null, releaseDate: null, fetchedAt: 'x', savedAt: 'x', isBaseline: false, counts: { vulnerability: 0, spyware: 0, total: 0 }, hash: 'a'.repeat(64), added: [], changed: [], removed: [] },
          nextIndex: { threatVersion: '../evil', savedAt: 'x', hash: 'a'.repeat(64), items: {}, firstSeen: {} },
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PA 威脅特徵碼 API、D1/D2 版本差異、TS-Q8 命中比對與戰情室整合', () => {
  let t: TestApp;
  let sigClient: FakeSigRedisClient;
  let sigRedis: PaSignatureRedis;
  let polClient: FakePolicyClient;
  let liveRedis: FakeRedis;
  let ch: FakeReader;
  let now = Date.parse('2026-11-19T02:00:00Z');

  before(async () => {
    sigClient = new FakeSigRedisClient();
    sigClient.clock = () => now;
    sigRedis = createPaSignatureRedis(sigClient);
    polClient = new FakePolicyClient();
    polClient.clock = () => now;
    liveRedis = new FakeRedis();
    ch = createFakeReader();
    t = await createTestApp({
      paSignature: { redis: sigRedis, now: () => now, syncMs: 0, syncWaitMs: 300 },
      paPolicy: { redis: createPaPolicyRedis(polClient), now: () => now, syncMs: 0 },
      paLiveRedis: createPaLiveRedis(liveRedis),
      chReader: ch,
      warroomNow: () => now,
    });
  });
  after(() => t.close());

  beforeEach(() => {
    sigClient.strings.clear();
    sigClient.hashes.clear();
    sigClient.lists.clear();
    sigClient.fail = false;
    polClient.strings.clear();
    polClient.hashes.clear();
    polClient.fail = false;
    liveRedis.strings.clear();
    liveRedis.hashes.clear();
    liveRedis.streams.clear();
    liveRedis.zsets.clear();
    liveRedis.fail = false;
    ch.threats = [];
    ch.failing = false;
  });

  it('Redis 尚無快照或斷線:清單與狀態皆回 200 available false(不回 5xx)', async () => {
    let r = await t.call({ url: '/v1/pa-signatures' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().available, false);
    assert.equal(r.json().reason, 'no-snapshot');

    sigClient.fail = true;
    r = await t.call({ url: '/v1/pa-signatures' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().reason, 'redis-down');

    const st = await t.call({ url: '/v1/pa-signature-status' });
    assert.equal(st.statusCode, 200);
    assert.equal(st.json().available, false);
    assert.equal(st.json().reason, 'redis-down');
  });

  it('OpenAPI 權限宣告符合 TS-Q8 與規則覆蓋安全邊界', async () => {
    const doc = (await t.app.inject('/openapi.json')).json();
    assert.equal(doc.paths['/v1/pa-signatures'].get['x-permission'], 'netops.pa-signature.read');
    assert.equal(doc.paths['/v1/pa-signature-refreshes'].post['x-permission'], 'netops.pa-signature.refresh');
    assert.equal(doc.paths['/v1/pa-signature-coverage'].get['x-permission'], 'netops.pa-policy.read');
    // TS-Q8:無 IP 路由用 pa-signature.read;含 IP 路由用 pa-log.read + meta 稽核
    assert.equal(doc.paths['/v1/pa-signature-hit-queries'].post['x-permission'], 'netops.pa-signature.read');
    assert.equal(doc.paths['/v1/pa-signature-hit-ip-queries'].post['x-permission'], 'netops.pa-log.read');
    assert.equal(doc.paths['/v1/pa-signature-hit-ip-queries'].post['x-audit-level'], 'meta');
  });

  it('D2 基準版 → D1 版本更新差異 → days 7/30/90 & since → Redis 清除後基準日仍保存', async () => {
    now = Date.parse('2026-11-10T02:00:00Z');
    sigClient.putSnapshot({
      threatVersion: '9173-10354',
      hash: '1'.repeat(64),
      fetchedAt: new Date(now).toISOString(),
      vuln: [
        sig('30001', 'vulnerability', { name: 'Base RCE', severity: 'high', defaultAction: 'alert', cves: ['CVE-2024-1111'] }),
        sig('30002', 'vulnerability', { name: 'To Remove', severity: 'low' }),
      ],
      spyware: [sig('40001', 'spyware', { name: 'Base C2', severity: 'critical' })],
      profiles: PROFILES_SNAP,
    });

    // 1. 第一次同步:存成基準版本(不算新增)
    const list1 = (await t.call({ url: '/v1/pa-signatures?days=30' })).json();
    assert.equal(list1.available, true);
    assert.equal(list1.threatVersion, '9173-10354');
    assert.equal(list1.baselineAt, '2026-11-10T02:00:00.000Z');
    assert.equal(list1.since, '2026-11-10'); // 基準日晚於「今天 − 30 天」
    assert.equal(list1.versions.avVersion, '5001-5520');
    assert.equal(list1.versions.wildfireVersion, '955201-958201');
    assert.equal(list1.items.every((x: { isNew: boolean }) => x.isNew === false), true);

    // 不合法 days 回 400
    assert.equal((await t.call({ url: '/v1/pa-signatures?days=14' })).statusCode, 400);

    // 2. 模擬 10 天後內容版本更新(9174-10355),即使中間 Redis 清空重寫也不影響基準日
    sigClient.strings.clear();
    now = Date.parse('2026-11-20T02:00:00Z');
    sigClient.putSnapshot({
      threatVersion: '9174-10355',
      hash: '2'.repeat(64),
      fetchedAt: new Date(now).toISOString(),
      vuln: [
        sig('30001', 'vulnerability', { name: 'Base RCE', severity: 'critical', defaultAction: 'reset-both', cves: ['CVE-2024-1111'] }),
        sig('90001', 'vulnerability', { name: 'Fresh ZeroDay', severity: 'critical', cves: ['CVE-2026-8888'], vendorIds: ['MS26-001'] }),
      ],
      spyware: [sig('40001', 'spyware', { name: 'Base C2', severity: 'critical' })],
      profiles: PROFILES_SNAP,
    });

    const vers = (await t.call({ url: '/v1/pa-signature-versions' })).json();
    assert.equal(vers.baselineAt, '2026-11-10T02:00:00.000Z');
    assert.equal(vers.baselineVersion, '9173-10354');
    assert.equal(vers.total, 2);
    assert.equal(vers.items[0].threatVersion, '9174-10355');
    assert.equal(vers.items[0].added, 1);
    assert.equal(vers.items[0].changed, 1);
    assert.equal(vers.items[0].removed, 1);

    // 版本差異篩選與分頁
    const diffRes = (await t.call({ url: '/v1/pa-signature-versions/9174-10355/diffs' })).json();
    assert.equal(diffRes.baseVersion, '9173-10354');
    assert.deepEqual(diffRes.summary, { added: 1, changed: 1, removed: 1 });
    assert.equal(diffRes.total, 3);
    const addedOnly = (await t.call({ url: '/v1/pa-signature-versions/9174-10355/diffs?kind=added&q=CVE-2026-8888' })).json();
    assert.equal(addedOnly.total, 1);
    assert.equal(addedOnly.items[0].id, '90001');
    const changedOnly = (await t.call({ url: '/v1/pa-signature-versions/9174-10355/diffs?kind=changed' })).json();
    assert.deepEqual(
      changedOnly.items[0].fields.map((f: { field: string }) => f.field),
      ['severity', 'defaultAction'],
    );
    const nfVer = await t.call({ url: '/v1/pa-signature-versions/0000-0000/diffs' });
    assert.equal(nfVer.statusCode, 404);
    assert.equal(nfVer.json().code, 'NETOPS_PA_SIGNATURE_VERSION_NOT_FOUND');

    // days=7 時基準日(11/10)早於「11/20 − 7 天 = 11/13」→ since 為 null;days=30 時基準日晚於 10/21 → since 為 2026-11-10
    const list7 = (await t.call({ url: '/v1/pa-signatures?days=7&isNew=true' })).json();
    assert.equal(list7.since, null);
    assert.deepEqual(list7.items.map((x: { id: string }) => x.id), ['90001']);
    const list30 = (await t.call({ url: '/v1/pa-signatures?days=30&q=MS26-001' })).json();
    assert.equal(list30.since, '2026-11-10');
    assert.deepEqual(list30.items.map((x: { id: string }) => x.id), ['90001']);
  });

  it('單筆查詢:快照命中(含異動紀錄)、1 天快取命中、202 按需查詢與擁有者隔離、限流 429', async () => {
    now = Date.parse('2026-11-20T02:00:00Z');
    sigClient.putSnapshot({
      threatVersion: '9174-10355',
      hash: '2'.repeat(64),
      fetchedAt: new Date(now).toISOString(),
      vuln: [sig('30001', 'vulnerability', { name: 'Base RCE', severity: 'critical', defaultAction: 'reset-both', cves: ['CVE-2024-1111'] })],
      spyware: [],
    });

    // 快照命中
    const snapHit = await t.call({ url: '/v1/pa-signatures/30001' });
    assert.equal(snapHit.statusCode, 200);
    assert.equal(snapHit.json().found, true);
    assert.equal(snapHit.json().source, 'snapshot');
    assert.ok(Array.isArray(snapHit.json().item.changes));

    // 不在快照 → 送 202 按需查詢(show threat id)
    const q1 = await t.call({ url: '/v1/pa-signatures/888888', emp: 'S112009' });
    assert.equal(q1.statusCode, 202);
    const { lookupId } = q1.json();
    assert.ok(lookupId);
    assert.equal(sigClient.lists.get(PA_SIGNATURE_KEYS.lookupJobs)?.[0], lookupId);

    // 模擬收集器設定全系統 10 秒限流 → 再查其他 ID 回 429 + Retry-After
    await sigClient.set(PA_SIGNATURE_KEYS.lookupCool, '1', 'EX', 10);
    const q2 = await t.call({ url: '/v1/pa-signatures/888889', emp: 'S112009' });
    assert.equal(q2.statusCode, 429);
    assert.equal(q2.json().code, 'NETOPS_PA_SIGNATURE_COOLDOWN');
    assert.ok(Number(q2.headers['retry-after']) > 0);

    // 模擬收集器寫回結果 → 本人查得到,別人回 404
    sigClient.setHash(PA_SIGNATURE_KEYS.lookupJob(lookupId), {
      status: 'done',
      finishedAt: new Date(now + 2000).toISOString(),
      result: JSON.stringify({ id: '888888', name: 'Virus-XYZ', subtype: 'virus', severity: 'high', description: 'Test virus' }),
    });
    const jobOwn = await t.call({ url: `/v1/pa-signature-lookups/${lookupId}`, emp: 'S112009' });
    assert.equal(jobOwn.statusCode, 200);
    assert.equal(jobOwn.json().status, 'done');
    assert.equal(jobOwn.json().result.name, 'Virus-XYZ');
    const jobOther = await t.call({ url: `/v1/pa-signature-lookups/${lookupId}`, emp: 'S999999' });
    assert.equal(jobOther.statusCode, 404);
    assert.equal(jobOther.json().code, 'NETOPS_PA_SIGNATURE_LOOKUP_NOT_FOUND');

    // 1 天按需快取命中 → 不需再進佇列,直接 200
    sigClient.strings.set(PA_SIGNATURE_KEYS.lookupCache('777777'), {
      v: JSON.stringify({
        found: true,
        checkedAt: new Date(now).toISOString(),
        item: { id: '777777', name: 'Cached Threat', subtype: 'vulnerability', severity: 'medium', description: 'Cached' },
      }),
      exp: null,
    });
    const cachedHit = await t.call({ url: '/v1/pa-signatures/777777' });
    assert.equal(cachedHit.statusCode, 200);
    assert.equal(cachedHit.json().source, 'lookup');
    assert.equal(cachedHit.json().item.name, 'Cached Threat');
  });

  it('命中比對(TS-Q8 無 IP vs 含 IP、規則缺口標註、90 天轉 202 工作、ClickHouse 失敗回 424)', async () => {
    now = Date.parse('2026-11-20T02:00:00Z');
    sigClient.putSnapshot({
      threatVersion: '9174-10355',
      hash: '2'.repeat(64),
      fetchedAt: new Date(now).toISOString(),
      vuln: [sig('90001', 'vulnerability', { name: 'Fresh ZeroDay', severity: 'critical' })],
      spyware: [],
      profiles: PROFILES_SNAP,
    });
    polClient.put(
      {
        fetchedAt: new Date(now).toISOString(),
        hash: 'a'.repeat(64),
        vsys: 'vsys1',
        rules: [
          policyRule(1, 'Allow-NoProfile', { profileGroup: null, profiles: {} }),
          policyRule(2, 'Allow-Full', { profileGroup: 'Grp-Full' }),
        ],
        objects: OBJECTS,
      },
      POLICY_HITS,
    );

    // 台灣時間 2026/11/20 09:00:00 (+08:00) = 2026-11-20T01:00:00Z(在 now 02:00Z 前 1 小時)
    ch.threats = [
      {
        type: 'threat',
        rec: { time: '2026/11/20 09:00:00', name: 'Fresh ZeroDay(90001)', action: 'alert', rule: 'Allow-NoProfile', src: '1.2.3.4', dst: '10.10.1.5', repeat: 3 },
      },
      {
        type: 'threat',
        rec: { time: '2026/11/20 09:30:00', name: 'Fresh ZeroDay(90001)', action: 'reset-both', rule: 'Allow-Full', src: '5.6.7.8', dst: '10.10.1.5', repeat: 1 },
      },
    ];

    // 無 IP 路由(netops.pa-signature.read):絕對不含 topSrc / topDst
    const noIp = await t.call({ method: 'POST', url: '/v1/pa-signature-hit-queries', payload: { days: 30, scope: 'new' } });
    assert.equal(noIp.statusCode, 200);
    const b1 = noIp.json();
    assert.equal(b1.includeIps, false);
    assert.equal(b1.items.length, 1);
    assert.equal(b1.items[0].id, '90001');
    assert.equal(b1.items[0].hits, 2);
    assert.equal(b1.items[0].repeats, 4);
    assert.equal(b1.items[0].blocked, 1);
    assert.equal(b1.items[0].alerted, 1);
    assert.equal(b1.items[0].topSrc, undefined);
    assert.equal(b1.items[0].topDst, undefined);
    assert.deepEqual(b1.items[0].ruleDetails, [
      { name: 'Allow-Full', unprotected: false },
      { name: 'Allow-NoProfile', unprotected: true },
    ]);

    // 含 IP 路由(netops.pa-log.read):包含 topSrc / topDst
    const withIp = await t.call({ method: 'POST', url: '/v1/pa-signature-hit-ip-queries', payload: { days: 30, scope: 'ids', ids: ['90001'] } });
    assert.equal(withIp.statusCode, 200);
    const b2 = withIp.json();
    assert.equal(b2.includeIps, true);
    assert.deepEqual(b2.items[0].topDst, [{ ip: '10.10.1.5', count: 2 }]);
    assert.equal(b2.items[0].topSrc.length, 2);

    // 90 天強制走工作模式(202 → 輪詢 → 204 刪除)
    const j90 = await t.call({ method: 'POST', url: '/v1/pa-signature-hit-queries', payload: { days: 90, scope: 'ids', ids: ['90001'] } });
    assert.equal(j90.statusCode, 202);
    const jobId = j90.json().jobId;
    assert.ok(jobId);
    let doneBody: { status: string; result: { items: { id: string }[] } | null } = { status: 'queued', result: null };
    await waitFor(async () => {
      const r = await t.call({ url: `/v1/pa-signature-hit-queries/${jobId}` });
      doneBody = r.json();
      return doneBody.status === 'done';
    });
    assert.equal(doneBody.result?.items[0]?.id, '90001');
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa-signature-hit-queries/${jobId}` })).statusCode, 204);
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/pa-signature-hit-queries/${jobId}` })).statusCode, 204);

    // ClickHouse 失敗不回 5xx,回 424 NETOPS_PA_SIGNATURE_CH_UNAVAILABLE
    ch.failing = true;
    const errRes = await t.call({ method: 'POST', url: '/v1/pa-signature-hit-queries', payload: { days: 30, scope: 'ids', ids: ['90001'] } });
    assert.equal(errRes.statusCode, 424);
    assert.equal(errRes.json().code, 'NETOPS_PA_SIGNATURE_CH_UNAVAILABLE');
    ch.failing = false;
  });

  it('規則覆蓋 API 與手動重新整理(202 / 429 冷卻 / 409 未啟用 / 424 Redis 斷線)', async () => {
    now = Date.parse('2026-11-20T02:00:00Z');
    sigClient.putSnapshot({
      threatVersion: '9174-10355',
      hash: '2'.repeat(64),
      vuln: [],
      spyware: [],
      profiles: PROFILES_SNAP,
    });
    polClient.put(
      {
        fetchedAt: new Date(now).toISOString(),
        hash: 'a'.repeat(64),
        vsys: 'vsys1',
        rules: [
          policyRule(1, 'Allow-NoAS', { profileGroup: 'Grp-NoAS' }),
          policyRule(2, 'Allow-Full', { profileGroup: 'Grp-Full' }),
        ],
        objects: OBJECTS,
      },
      POLICY_HITS,
    );

    const cov = (await t.call({ url: '/v1/pa-signature-coverage' })).json();
    assert.equal(cov.available, true);
    assert.equal(cov.summary.totalAllowEnabled, 2);
    assert.equal(cov.summary.covered, 1);
    assert.equal(cov.summary.missingSpyware, 1);
    assert.equal(cov.items[0].name, 'Allow-NoAS');

    // 手動重新整理 202 → 第二次 429 冷卻
    const r1 = await t.call({ method: 'POST', url: '/v1/pa-signature-refreshes' });
    assert.equal(r1.statusCode, 202);
    assert.equal(r1.json().cooldownSec, 300);
    const r2 = await t.call({ method: 'POST', url: '/v1/pa-signature-refreshes' });
    assert.equal(r2.statusCode, 429);
    assert.equal(r2.json().code, 'NETOPS_PA_SIGNATURE_COOLDOWN');
    assert.ok(Number(r2.headers['retry-after']) > 0);

    // 收集器未啟用 → 409
    sigClient.hashes.set(PA_SIGNATURE_KEYS.heartbeat, { v: { signatureEnabled: '0' }, exp: null });
    const r3 = await t.call({ method: 'POST', url: '/v1/pa-signature-refreshes' });
    assert.equal(r3.statusCode, 409);
    assert.equal(r3.json().code, 'NETOPS_PA_SIGNATURE_DISABLED');

    // Redis 斷線 → 424(非 5xx)
    sigClient.fail = true;
    const r4 = await t.call({ method: 'POST', url: '/v1/pa-signature-refreshes' });
    assert.equal(r4.statusCode, 424);
    assert.equal(r4.json().code, 'NETOPS_PA_SIGNATURE_UNAVAILABLE');
  });

  it('戰情室 warroom 與 risk 命中近 30 天新增特徵碼時附帶 newSignatureHits,無命中時省略', async () => {
    // 前一個測試已將 90001 存為 9174-10355 的新增特徵(30001 為基準特徵不算新增)
    now = Date.parse('2026-11-20T03:00:00Z');
    const bucket = '202611200259';
    liveRedis.addLog('threat', { src: '1.1.1.1', dst: '10.10.130.5', name: 'Fresh ZeroDay(90001)', severity: 'critical', action: 'reset-both' }, now - 30_000);
    liveRedis.addLog('threat', { src: '1.1.1.1', dst: '10.10.130.5', name: 'Fresh ZeroDay(90001)', severity: 'critical', action: 'alert' }, now - 20_000);
    liveRedis.addLog('threat', { src: '2.2.2.2', dst: '10.10.130.5', name: 'Base RCE(30001)', severity: 'high', action: 'alert' }, now - 10_000);
    liveRedis.setTop('threat', 'name', bucket, { 'Fresh ZeroDay(90001)': 5, 'Base RCE(30001)': 2 });
    liveRedis.setAgg('threat', bucket, { count: 7, 'severity:critical': 5 });

    const wr = (await t.call({ url: '/v1/pa-live/warroom?minutes=5' })).json();
    assert.equal(wr.partial, false);
    assert.deepEqual(wr.newSignatureHits, [
      { id: '90001', name: 'Fresh ZeroDay', severity: 'critical', firstVersion: '9174-10355', count: 2 },
    ]);

    const rk = (await t.call({ url: '/v1/pa-live/risk?minutes=15' })).json();
    assert.equal(rk.partial, false);
    assert.deepEqual(rk.newSignatureHits, [
      { id: '90001', name: 'Fresh ZeroDay', severity: 'critical', firstVersion: '9174-10355', count: 5 },
    ]);

    // 只有基準特徵(無新特徵命中)時省略 newSignatureHits(往前推超過快取 TTL 避開 memo)
    now += 120_000;
    liveRedis.streams.clear();
    liveRedis.zsets.clear();
    liveRedis.addLog('threat', { src: '2.2.2.2', dst: '10.10.130.5', name: 'Base RCE(30001)', severity: 'high', action: 'alert' }, now - 10_000);
    const wrNoNew = (await t.call({ url: '/v1/pa-live/warroom?minutes=5' })).json();
    assert.equal(wrNoNew.newSignatureHits, undefined);
  });
});

describe('D1 背景排程同步與中途失敗復原', () => {
  it('無須開啟頁面,背景排程自動建立基準版並於版本更新時寫入差異檔', async () => {
    let now = Date.parse('2026-11-18T00:00:00Z');
    const c = new FakeSigRedisClient();
    c.clock = () => now;
    c.putSnapshot({
      threatVersion: '9173-10354',
      hash: '1'.repeat(64),
      fetchedAt: new Date(now).toISOString(),
      vuln: [sig('1001', 'vulnerability', { name: 'V1' })],
      spyware: [],
    });
    const t = await createTestApp({ paSignature: { redis: createPaSignatureRedis(c), now: () => now, syncMs: 20 } });
    try {
      await t.app.ready();
      // 沒呼叫任何特徵碼 API,直接檢查 store 是否已被背景排程寫入基準版
      await waitFor(() => t.app.store.paSignature.readHistoryIndex().versions.length === 1);
      assert.equal(t.app.store.paSignature.readHistoryIndex().baselineVersion, '9173-10354');
      // 留存 9173-10354 的精簡索引,稍後用來模擬「寫完差異檔與 index.json 後、換新精簡索引前」崩潰(D1)
      const latestIndexPath = path.join(t.dataDir, 'pa-signature', 'latest-index.json.gz');
      const prevLatestBytes = fs.readFileSync(latestIndexPath);

      // 模擬收集器更新至新版
      now = Date.parse('2026-11-19T00:00:00Z');
      c.putSnapshot({
        threatVersion: '9174-10355',
        hash: '2'.repeat(64),
        fetchedAt: new Date(now).toISOString(),
        vuln: [sig('1001', 'vulnerability', { name: 'V1' }), sig('1002', 'vulnerability', { name: 'V2' })],
        spyware: [],
      });
      await waitFor(() => t.app.store.paSignature.readHistoryIndex().versions.length === 2);
      const d = t.app.store.paSignature.readVersionDiff('9174-10355');
      assert.equal(d?.added.length, 1);
      assert.equal(d?.added[0]?.id, '1002');
      // 模擬中途失敗:還原舊版精簡索引(如同第 1、2 步完成但在第 3 步換精簡索引前當機),下一輪排程重跑應冪等復原
      const origBase = t.app.store.paSignature.readHistoryIndex().baselineAt;
      fs.writeFileSync(latestIndexPath, prevLatestBytes);
      await waitFor(() => t.app.store.paSignature.readLatestIndex()?.threatVersion === '9174-10355');
      const afterHist = t.app.store.paSignature.readHistoryIndex();
      assert.equal(afterHist.baselineAt, origBase);
      assert.equal(afterHist.versions.length, 2);
      assert.equal(t.app.store.paSignature.readVersionDiff('9174-10355')?.added.length, 1);
    } finally {
      await t.close();
    }
  });
});
