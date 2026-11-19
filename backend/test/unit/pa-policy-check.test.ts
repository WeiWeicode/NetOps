/**
 * PA 安全規則 PR-5(docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3 PR-5):排序檢查(確定性)與 AI 判讀(只送檢查結果與相關規則、不送 IP 對照名稱)
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPaPolicyRedis } from '../../src/infra/redis/pa-policy.js';
import { checkContext, checkRules, type CheckCode } from '../../src/modules/pa-policy/check.js';
import { verifyAnswer } from '../../src/modules/pa-policy/verify.js';
import { buildViews, parseHits, parseSnapshot } from '../../src/modules/pa-policy/core.js';
import { fakeAiHost } from '../fixtures/fake-ai.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { FakePolicyClient, HITS, OBJECTS, rule } from '../fixtures/pa-policy.js';

const NOW = Date.parse('2026-11-19T02:00:00Z');
const RULES = [
  rule(1, 'Allow-Office-Any', { sources: ['10.10.0.0/16'], destinations: ['any'], services: ['any'] }),
  rule(2, 'Deny-48', { sources: ['Net_48'], action: 'deny' }), // 被 1 涵蓋、動作不同 → conflict
  rule(3, 'Allow-49-5', { sources: ['Host_5'] }), // 被 1 涵蓋、動作相同 → shadowed
  rule(4, 'Allow-DMZ-A', { fromZones: ['dmz'], sources: ['10.50.0.1'], destinations: ['10.60.0.0/24'] }),
  rule(5, 'Allow-DMZ-B', { fromZones: ['dmz'], sources: ['10.50.0.2'], destinations: ['10.60.0.0/24'] }), // 只差來源 → redundant
  rule(6, 'FQDN-Dst', { fromZones: ['trust'], sources: ['10.10.5.0/24'], destinations: ['Web_FQDN'], profileGroup: null, logEnd: false }), // 可能被 1 涵蓋但 FQDN → undeterminable
  rule(7, 'Old', { disabled: true, fromZones: ['guest'] }),
];
const HIT_ITEMS = {
  'Allow-Office-Any': { hitCount: 1000, lastHit: '2026-11-19T01:00:00Z' },
  'Deny-48': { hitCount: 0, lastHit: null },
  'Allow-49-5': { hitCount: 0, lastHit: null },
  'Allow-DMZ-A': { hitCount: 3, lastHit: '2026-01-01T00:00:00Z' },
  'Allow-DMZ-B': { hitCount: 3, lastHit: '2026-11-18T00:00:00Z' },
  'FQDN-Dst': { hitCount: 4, lastHit: '2026-11-18T00:00:00Z' },
};
const SNAP = { fetchedAt: '2026-11-19T01:00:00Z', hash: 'c'.repeat(64), rules: RULES, objects: OBJECTS };

const views = () => buildViews(parseSnapshot(SNAP)!, parseHits({ items: HIT_ITEMS }).items);
const codesOf = (pos: number, items: { position: number; code: CheckCode }[]) => items.filter((i) => i.position === pos).map((i) => i.code).sort();

describe('排序檢查(確定性)', () => {
  const r = checkRules(views(), { now: NOW });
  it('衝突遮蔽、遮蔽、相關規則編號', () => {
    assert.deepEqual(codesOf(2, r.items), ['conflict', 'unused']);
    assert.deepEqual(r.items.find((i) => i.position === 2)!.related, [{ position: 1, name: 'Allow-Office-Any' }]);
    assert.ok(codesOf(3, r.items).includes('shadowed'));
    assert.equal(r.items[0]!.code, 'conflict'); // high 排最前
  });
  it('可合併、過寬在前、未命中、停用、無 Profile、無 Log at Session End、無法判定', () => {
    assert.ok(codesOf(5, r.items).includes('redundant'));
    assert.ok(codesOf(1, r.items).includes('broad-early'));
    assert.ok(r.items.find((i) => i.position === 1 && i.code === 'broad-early')!.related.some((x) => x.position === 4) === false); // dmz 和 trust 不重疊
    assert.ok(codesOf(4, r.items).includes('unused'));
    assert.ok(!codesOf(2, r.items).includes('no-profile'), 'deny 不檢查 profile');
    assert.deepEqual(codesOf(7, r.items), ['disabled']);
    assert.deepEqual(codesOf(6, r.items), ['no-log-end', 'no-profile', 'undeterminable']);
    assert.match(r.items.find((i) => i.code === 'undeterminable')!.reasons!.join(), /FQDN/);
    assert.equal(r.summary.conflict, 1);
    assert.equal(r.imprecise, 1);
  });
  it('未命中門檻可調', () => {
    assert.ok(!codesOf(4, checkRules(views(), { now: NOW, unusedDays: 365 }).items).includes('unused'));
  });
  it('AI 資料:只有檢查項目與相關規則、不送說明欄、info 不送', () => {
    const v = views();
    v[0]!.rule.description = '王小明申請';
    const ctx = checkContext(v, checkRules(v, { now: NOW }), { fetchedAt: SNAP.fetchedAt, unusedDays: 90 });
    assert.match(ctx.text, /conflict #2 Deny-48/);
    assert.match(ctx.text, /#1 Allow-Office-Any\|trust → untrust\|來源 10\.10\.0\.0\/16/);
    assert.doesNotMatch(ctx.text, /王小明/);
    assert.doesNotMatch(ctx.text, /\] disabled #7/);
    assert.doesNotMatch(ctx.text, /#7 Old/); // 停用規則沒有相關項目,不送
  });
});

describe('審查修正(PR-5)', () => {
  const run = (rules: Record<string, unknown>[]) => checkRules(buildViews(parseSnapshot({ ...SNAP, rules })!, {}), { now: NOW });
  it('drop 在前、deny 在後:不是衝突(同樣是擋)', () => {
    const r = run([rule(1, 'A', { action: 'drop', sources: ['10.0.0.0/8'] }), rule(2, 'B', { action: 'deny', sources: ['10.1.0.0/16'] })]);
    assert.deepEqual(codesOf(2, r.items).filter((c) => c !== 'unused'), ['shadowed']);
    assert.match(r.items.find((i) => i.position === 2 && i.code === 'shadowed')!.message, /擋法不同/);
  });
  it('intrazone / interzone 規則不當成確定涵蓋', () => {
    const r = run([rule(1, 'A', { type: 'interzone', fromZones: ['any'], toZones: ['any'] }), rule(2, 'B', { fromZones: ['trust'], toZones: ['trust'], action: 'deny' })]);
    assert.ok(!codesOf(2, r.items).includes('conflict'));
    assert.ok(codesOf(2, r.items).includes('undeterminable'));
  });
  it('相鄰規則排程不同不建議合併', () => {
    const base = { fromZones: ['dmz'], destinations: ['10.60.0.0/24'] };
    const r = run([rule(1, 'A', { ...base, sources: ['10.50.0.1'], schedule: 'office-hours' }), rule(2, 'B', { ...base, sources: ['10.50.0.2'] })]);
    assert.ok(!codesOf(2, r.items).includes('redundant'));
  });
  it('過寬 allow 之後只有同 Profile 的 allow:不報 broad-early', () => {
    const r = run([rule(1, 'A', { services: ['any'] }), rule(2, 'B', { sources: ['10.1.0.0/16'], destinations: ['10.2.0.0/16'] })]);
    assert.ok(!codesOf(1, r.items).includes('broad-early'));
  });
  it('AI 資料不送使用者名稱', () => {
    const v = buildViews(parseSnapshot({ ...SNAP, rules: [rule(1, 'A', { sources: ['10.0.0.0/8'] }), rule(2, 'B', { sources: ['10.1.0.0/16'], sourceUsers: ['gsmc\s112009'], action: 'deny' })] })!, {});
    const ctx = checkContext(v, checkRules(v, { now: NOW }), { fetchedAt: 'x', unusedDays: 90 });
    assert.doesNotMatch(ctx.text, /s112009/i);
    assert.match(ctx.text, /有使用者條件\(1 個/);
  });
});

describe('API:排序檢查與 AI 判讀', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  let t: TestApp;
  const client = new FakePolicyClient();
  client.clock = () => NOW;
  before(async () => {
    const base = await host.start();
    t = await createTestApp({ env: { LLM_URL: `${base}/v1` }, ai: { heartbeatMs: 50 }, paPolicy: { redis: createPaPolicyRedis(client), now: () => NOW, syncMs: 0 } });
  });
  after(async () => {
    await t.close();
    host.close();
  });

  it('GET /v1/pa-policy-checks:沒有快照 available false;有快照回項目', async () => {
    let res = await t.call({ url: '/v1/pa-policy-checks' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().available, false);
    client.put(SNAP, { ...HITS, items: HIT_ITEMS });
    res = await t.call({ url: '/v1/pa-policy-checks?unusedDays=30' });
    assert.equal(res.json().unusedDays, 30);
    assert.equal(res.json().items[0].code, 'conflict');
    assert.equal((await t.call({ url: '/v1/pa-policy-checks?unusedDays=0' })).statusCode, 400);
  });

  it('AI 判讀:SSE、只送檢查結果、不附 IP 對照名稱與知識庫', async () => {
    client.put(SNAP, { ...HITS, items: HIT_ITEMS });
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.0.0/16', name: '王小明', department: '資訊處' } })).statusCode, 201);
    host.reqs.splice(0);
    const res = await t.call({ method: 'POST', url: '/v1/ai/explanations', payload: { kind: 'pa-policy', params: { unusedDays: 90 } } });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /event: meta\ndata: \{"kind":"pa-policy"/);
    const chat = host.reqs.find((r) => r.url === '/v1/chat/completions')!;
    const user = chat.body.messages.at(-1).content as string;
    assert.match(user, /conflict #2 Deny-48/);
    assert.doesNotMatch(user, /王小明|資訊處/);
    assert.doesNotMatch(user, /IP 對照表|知識庫/);
    assert.match(chat.body.messages[0].content, /不會自動修改防火牆/);
    assert.match(chat.body.messages[0].content, /只能引用「檢查項目」列出的問題/);
    // 回答驗證在 done 之前送出(假 AI 的回答沒有規則編號 → 沒有標註)
    assert.match(res.body, /event: verify\ndata: \{"flags":\[\]\}[\s\S]*event: done/);
  });
});

describe('AI 回答驗證(2026-11-19 驗收 §3 幻覺)', () => {
  const v = buildViews(parseSnapshot(SNAP)!, parseHits({ items: HIT_ITEMS }).items);
  const ctx = checkContext(v, checkRules(v, { now: NOW }), { fetchedAt: SNAP.fetchedAt, unusedDays: 90 });

  it('無法判定的項目會送給 AI(「需要人工確認」的依據),停用不送', () => {
    assert.match(ctx.text, /\[info\] undeterminable #6 FQDN-Dst/);
    assert.doesNotMatch(ctx.text, /disabled #7/);
    assert.deepEqual(ctx.ref.codes[6]!.sort(), ['broad-early', 'no-log-end', 'no-profile', 'undeterminable']); // broad-early:#1 的相關規則
    assert.ok(ctx.ref.positions.includes(1) && !ctx.ref.positions.includes(7));
  });
  it('資料沒有的規則編號 → unknown', () => {
    const f = verifyAnswer('## 需要人工確認\n- #87 、#88 的 0.pool.ntp.org 無法對應 IP\n- #6 FQDN-Dst 無法判定', ctx.ref);
    assert.deepEqual(f.map((x) => [x.kind, x.position]), [['unknown', 87], ['unknown', 88]]);
    assert.match(f[0]!.line, /0\.pool\.ntp\.org/);
  });
  it('不在該類檢查的規則 → mismatch(#114 缺 Profile 的情形)', () => {
    const f = verifyAnswer('- 缺少 Security Profile:#6 FQDN-Dst、#5 Allow-DMZ-B', ctx.ref);
    assert.deepEqual(f.map((x) => [x.kind, x.position, x.code]), [['mismatch', 5, 'no-profile']]);
  });
  it('相關規則也算在該類檢查內;一行講多類時不判歸類', () => {
    assert.deepEqual(verifyAnswer('- 衝突遮蔽:#2 Deny-48 被 #1 Allow-Office-Any 擋住', ctx.ref), []);
    assert.deepEqual(verifyAnswer('- #5 長期未命中,另有遮蔽問題', ctx.ref), []);
  });
  it('稱有使用者條件但資料沒有標 → user;說「沒有使用者條件」不算', () => {
    const f = verifyAnswer('#1 Allow-Office-Any 有使用者條件,範圍較窄', ctx.ref);
    assert.deepEqual(f.map((x) => [x.kind, x.position]), [['user', 1]]);
    assert.deepEqual(verifyAnswer('#1 沒有使用者條件', ctx.ref), []);
  });
  it('同一規則同一類只標一次;#編號後接數字不誤判', () => {
    const f = verifyAnswer('#99 a\n#99 b\n#1234567', ctx.ref);
    assert.equal(f.filter((x) => x.position === 99).length, 1);
    assert.ok(!f.some((x) => x.position === 1234));
  });
});
