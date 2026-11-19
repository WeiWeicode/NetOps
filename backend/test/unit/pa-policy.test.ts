/**
 * PA 安全規則 PR-2(docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3、§3.6):物件展開、篩選、版本差異、版本歷史、API、範圍反查。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPaPolicyRedis, PA_POLICY_KEYS, type PaPolicyRedis } from '../../src/infra/redis/pa-policy.js';
import { createPaPolicyStore, PA_POLICY_KEEP } from '../../src/infra/store/pa-policy.js';
import { buildViews, diffRules, filterRules, ipMatch, parseIpFilter, parseSnapshot, toRule, type PolicyRule } from '../../src/modules/pa-policy/core.js';
import { FakePolicyClient, HITS, OBJECTS, rule, SNAP } from '../fixtures/pa-policy.js';
import { createTestApp, type TestApp } from '../helpers.js';

describe('核心:展開與篩選', () => {
  const snap = parseSnapshot(SNAP)!;
  const views = buildViews(snap, {});
  it('群組遞迴展開、FQDN 與動態群組標 unresolved、迴圈不當機', () => {
    const src = views[0]!.rule.expanded.sources[0]!;
    assert.equal(src.kind, 'group');
    assert.deepEqual(src.values, ['10.10.48.0/24', '10.10.49.5', '10.20.0.1-10.20.0.9']);
    assert.equal(src.unresolved, false);
    assert.equal(views[1]!.rule.expanded.destinations[0]!.unresolved, true);
    assert.deepEqual(views[0]!.rule.expanded.services[0]!.values, ['tcp/8443', 'tcp/443']);
    assert.deepEqual(views[0]!.rule.expanded.applications[0]!.values, ['ms-office365', 'outlook-web']);
    const loop = buildViews(parseSnapshot({ ...SNAP, rules: [rule(1, 'L', { sources: ['Loop', 'DAG'] })] })!, {});
    assert.equal(loop[0]!.src.unresolved, true);
    assert.equal(loop[0]!.rule.expanded.sources[1]!.kind, 'dynamic-group');
  });
  it('IP 篩選比對展開後的位址;any 預設不算', () => {
    const hit = (ip: string, includeAny = false) => filterRules(views, { ips: parseIpFilter(ip)!, includeAny }).map((v) => v.rule.position);
    // 第 2 條目的是 FQDN(無法展開):列為 maybe,不當成沒有
    assert.deepEqual(hit('10.10.48.5'), [1, 2]);
    assert.deepEqual(hit('10.20.0.5'), [1, 2]);
    assert.deepEqual(hit('10.30.1.1'), [2, 3]);
    assert.deepEqual(hit('10.10.48.5', true), [1, 2, 3]);
    assert.equal(ipMatch(views[1]!, parseIpFilter('10.10.48.5')!, false), 'maybe');
    assert.equal(ipMatch(views[0]!, parseIpFilter('10.10.48.5')!, false), 'yes');
    // negate:反向條件不能用重疊判斷
    const neg = buildViews(parseSnapshot({ ...SNAP, rules: [rule(1, 'N', { sources: ['10.0.0.0/8'], negateSource: true })] })!, {});
    assert.equal(ipMatch(neg[0]!, parseIpFilter('10.1.1.1')!, false), 'maybe');
    assert.equal(parseIpFilter('10.0.0.0/40'), null);
    assert.equal(parseIpFilter('fe80::1'), null);
  });
  it('其他篩選:名稱、zone、應用群組成員、動作、未命中、停用', () => {
    const v2 = buildViews(snap, Object.fromEntries(Object.entries(HITS.items).map(([k, h]) => [k, { firstHit: null, lastReset: null, created: null, modified: null, ...h }])));
    const pos = (f: Parameters<typeof filterRules>[1]) => filterRules(v2, f, Date.parse('2026-11-19T02:00:00Z')).map((v) => v.rule.position);
    assert.deepEqual(pos({ q: 'fqdn' }), [2]);
    assert.deepEqual(pos({ zone: 'TRUST' }), [1, 2, 3]);
    assert.deepEqual(pos({ application: 'outlook' }), [1, 2, 3]); // 2、3 是 any
    assert.deepEqual(pos({ action: 'deny' }), [2]);
    assert.deepEqual(pos({ unusedDays: 90 }), [2, 3]);
    assert.deepEqual(pos({ disabled: true }), [3]);
  });
});

describe('核心:版本差異', () => {
  const r = (p: number, n: string, x: Partial<PolicyRule> = {}) => toRule(rule(p, n, x), p - 1);
  it('插入造成的位移不算移動;真的往前移才算', () => {
    const base = [r(1, 'A'), r(2, 'B'), r(3, 'C')];
    const cur = [r(1, 'C'), r(2, 'A'), r(3, 'N'), r(4, 'B', { action: 'deny' })];
    const d = diffRules(base, cur);
    assert.deepEqual(
      d.map((c) => [c.kind, c.name]),
      [['moved', 'C'], ['added', 'N'], ['changed', 'B']],
    );
    assert.deepEqual(d[2]!.fields, [{ field: 'action', before: 'allow', after: 'deny' }]);
    // 刪除、改名(uuid 相同)
    const d2 = diffRules(base, [r(1, 'A2', { uuid: 'uuid-A' }), r(2, 'B')]);
    assert.deepEqual(d2.map((c) => [c.kind, c.name]), [['changed', 'A2'], ['removed', 'C']]);
  });
});

describe('版本歷史 store', () => {
  it('保留 50 份,清單新到舊,壞 id 回 null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-pp-'));
    try {
      const s = createPaPolicyStore(root);
      for (let i = 0; i < PA_POLICY_KEEP + 3; i++) s.saveVersion({ hash: i.toString(16).padStart(64, '0'), fetchedAt: 'x', rules: [], objects: {} }, new Date(Date.UTC(2026, 10, 19, 0, 0, i)));
      const list = s.listVersions();
      assert.equal(list.length, PA_POLICY_KEEP);
      assert.equal(fs.readdirSync(path.join(root, 'papolicy', 'versions')).length, PA_POLICY_KEEP);
      assert.ok(list[0]!.savedAt > list[1]!.savedAt);
      assert.ok(s.readVersion(list[0]!.id));
      assert.equal(s.readVersion('../../etc/passwd'), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PA 安全規則 API', () => {
  let t: TestApp;
  let client: FakePolicyClient;
  let redis: PaPolicyRedis;
  let now = Date.parse('2026-11-19T02:00:00Z');
  before(async () => {
    client = new FakePolicyClient();
    client.clock = () => now;
    redis = createPaPolicyRedis(client);
    t = await createTestApp({ paPolicy: { redis, now: () => now, syncMs: 0 } });
  });
  after(() => t.close());
  beforeEach(() => {
    client.strings.clear();
    client.hashes.clear();
    client.fail = false;
  });

  it('沒有快照 / Redis 停止:200 available false', async () => {
    let res = await t.call({ url: '/v1/pa-policies' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().available, false);
    assert.equal(res.json().reason, 'no-snapshot');
    client.fail = true;
    res = await t.call({ url: '/v1/pa-policies' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reason, 'redis-down');
  });

  it('清單依 position、篩選保留原編號、預設規則另列、存第一個版本', async () => {
    client.put(SNAP);
    const res = await t.call({ url: '/v1/pa-policies?ip=10.10.48.0/25,10.30.0.1' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.deepEqual(b.items.map((r: PolicyRule) => r.position), [1, 2, 3]);
    assert.deepEqual(b.items.map((r: { ipMatch: string }) => r.ipMatch), ['yes', 'maybe', 'yes']);
    assert.equal(b.items[0].hits.hitCount, 100);
    assert.deepEqual(b.defaults.map((d: { name: string }) => d.name), ['interzone-default', 'intrazone-default']);
    assert.equal(b.stale, false);
    assert.equal(b.status.mgmtCpu, 12);
    assert.ok(b.versionId);
    assert.equal((await t.call({ url: '/v1/pa-policies?ip=abc' })).statusCode, 400);
    assert.equal((await t.call({ url: '/v1/pa-policies?pageSize=101' })).statusCode, 400);
  });

  it('單條、找不到 404', async () => {
    client.put(SNAP);
    const ok = await t.call({ url: `/v1/pa-policies/${encodeURIComponent('Allow-GSC')}` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().rule.expanded.sources[0].name, 'GSC Group');
    const nf = await t.call({ url: '/v1/pa-policies/nope' });
    assert.equal(nf.statusCode, 404);
    assert.equal(nf.json().code, 'NETOPS_PA_POLICY_NOT_FOUND');
  });

  it('雜湊變了才存新版本;差異', async () => {
    client.put(SNAP);
    await t.call({ url: '/v1/pa-policies' });
    const before = (await t.call({ url: '/v1/pa-policy-versions' })).json().total as number;
    await t.call({ url: '/v1/pa-policies' }); // 同雜湊不存
    assert.equal((await t.call({ url: '/v1/pa-policy-versions' })).json().total, before);
    now += 60_000;
    client.put({ ...SNAP, hash: 'b'.repeat(64), rules: [SNAP.rules[1], { ...SNAP.rules[0], position: 2 }, SNAP.rules[2]] });
    const v = (await t.call({ url: '/v1/pa-policy-versions' })).json();
    assert.equal(v.total, before + 1);
    const d = await t.call({ url: `/v1/pa-policy-versions/${v.items[0].id}/diffs` });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().baseId, v.items[1].id);
    assert.deepEqual(d.json().rules.map((c: { kind: string; name: string }) => [c.kind, c.name]), [['moved', 'Deny-FQDN']]);
    assert.equal((await t.call({ url: '/v1/pa-policy-versions/20200101T000000000Z-000000000000/diffs' })).json().code, 'NETOPS_PA_POLICY_VERSION_NOT_FOUND');
    assert.equal((await t.call({ url: '/v1/pa-policy-versions/bad/diffs' })).statusCode, 400);
  });

  it('手動重新整理:202、冷卻 429、收集器未啟用 409、Redis 停止 424', async () => {
    assert.equal((await t.call({ method: 'POST', url: '/v1/pa-policy-refreshes' })).json().code, 'NETOPS_PA_POLICY_DISABLED');
    client.put(SNAP);
    const ok = await t.call({ method: 'POST', url: '/v1/pa-policy-refreshes' });
    assert.equal(ok.statusCode, 202);
    assert.equal(JSON.parse((await client.get(PA_POLICY_KEYS.refresh))!).emp, 'emp:S112009');
    const cool = await t.call({ method: 'POST', url: '/v1/pa-policy-refreshes' });
    assert.equal(cool.statusCode, 429);
    assert.equal(cool.headers['retry-after'], '300');
    client.fail = true;
    assert.equal((await t.call({ method: 'POST', url: '/v1/pa-policy-refreshes' })).statusCode, 424);
  });

  it('範圍反查(§3.6):落在範圍內的項目、格式不符標 invalid', async () => {
    for (const ip of ['10.10.48.5', '10.10.49.1', '10.10.48.128/25'])
      assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip, name: `N${ip}` } })).statusCode, 201);
    const res = await t.call({ method: 'POST', url: '/v1/ip-name-range-lookups', payload: { ranges: ['10.10.48.0/24', '10.10.48.1-10.10.48.9', '10.10.48.0/40'] } });
    assert.equal(res.statusCode, 200);
    const r = res.json().results;
    assert.deepEqual(r['10.10.48.0/24'].items.map((x: { ip: string }) => x.ip), ['10.10.48.5', '10.10.48.128/25']);
    assert.equal(r['10.10.48.0/24'].total, 2);
    assert.deepEqual(r['10.10.48.1-10.10.48.9'].items.map((x: { ip: string }) => x.ip), ['10.10.48.5']);
    assert.deepEqual(r['10.10.48.0/40'], { invalid: true });
  });
});
