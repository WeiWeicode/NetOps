/**
 * PA 安全規則前端邏輯(PR-3):usePaPolicy(分頁讀取、篩選檢查、詳細、重新整理、IP 對照、名稱找規則、版本差異)與 usePaPolicyViz(§3.5 資料規則)
 */
import { describe, expect, it, vi } from 'vitest';
import type { DefaultRuleHits, PolicyList, PolicyRule } from '@/api/paPolicy';
import { checkIpFilter, classifyValue, usePaPolicy, type PaPolicyBackend } from '@/composables/usePaPolicy';
import { buildMatrix, buildOrder, buildSankey, DEFAULT_NODE, filterForViz, highlightOf, usePaPolicyViz } from '@/composables/usePaPolicyViz';

export const rule = (position: number, name: string, extra: Partial<PolicyRule> = {}): PolicyRule => ({
  position,
  name,
  uuid: null,
  type: 'universal',
  tags: [],
  groupTag: null,
  fromZones: ['trust'],
  toZones: ['untrust'],
  sources: ['any'],
  sourceUsers: [],
  sourceDevices: [],
  negateSource: false,
  destinations: ['any'],
  destinationDevices: [],
  negateDestination: false,
  applications: ['any'],
  services: ['application-default'],
  categories: [],
  action: 'allow',
  profileGroup: 'default',
  profiles: {},
  logStart: false,
  logEnd: true,
  logSetting: null,
  schedule: null,
  disabled: false,
  description: null,
  hits: { hitCount: 10, lastHit: '2026-11-19T00:00:00Z', firstHit: null, lastReset: null, created: null, modified: null },
  expanded: { sources: [{ name: 'any', kind: 'any', values: [], unresolved: false }], destinations: [{ name: 'any', kind: 'any', values: [], unresolved: false }], services: [], applications: [] },
  ...extra,
});
const hits = (hitCount: number | null, lastHit: string | null = null) => ({ hitCount, lastHit, firstHit: null, lastReset: null, created: null, modified: null });
const DEF: DefaultRuleHits[] = [
  { name: 'interzone-default', ...hits(3) },
  { name: 'intrazone-default', ...hits(7) },
];

function fakeBackend(rules: PolicyRule[]) {
  const list = vi.fn(async (_f: unknown, page: number, pageSize: number): Promise<PolicyList> => ({
    available: true,
    fetchedAt: 'x',
    hash: 'h',
    versionId: 'v',
    stale: false,
    hitsFetchedAt: null,
    ruleCount: rules.length,
    status: { collectorEnabled: true, state: 'ok', message: null, lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: 5, durationMs: 1, refreshCooldownSec: 0 },
    items: rules.slice((page - 1) * pageSize, page * pageSize),
    total: rules.length,
    page,
    pageSize,
    defaults: DEF,
  }));
  const b = {
    list,
    get: vi.fn(),
    refresh: vi.fn(),
    versions: vi.fn(async () => ({ items: [], total: 0 })),
    diff: vi.fn(),
    lookupIps: vi.fn(async (ips: string[]) => ({ names: Object.fromEntries(ips.filter((i) => i === '10.1.1.5').map((i) => [i, { name: '王小明', department: 'IT', device: 'NB', deviceType: '筆電' }])) })),
    lookupRanges: vi.fn(async (ranges: string[]) => ({ results: Object.fromEntries(ranges.map((r) => [r, { items: [{ ip: '10.2.0.9', name: 'A', department: 'B', device: '', deviceType: '' }], total: 1, truncated: false }])) })),
    searchNames: vi.fn(async () => ({ items: [{ ip: '10.1.1.5' }, { ip: '10.9.0.0/24' }], total: 2 })),
  };
  return b as unknown as PaPolicyBackend & typeof b;
}

describe('usePaPolicy', () => {
  it('讀完所有頁、ip 格式錯誤不送出', async () => {
    const rules = Array.from({ length: 166 }, (_, i) => rule(i + 1, `R${i + 1}`));
    const b = fakeBackend(rules);
    const p = usePaPolicy({ backend: b, can: () => true });
    expect(await p.load()).toBe(true);
    expect(p.rules).toHaveLength(166);
    expect(b.list).toHaveBeenCalledTimes(2);
    expect(p.defaults).toHaveLength(2);
    expect(p.info?.available).toBe(true);
    p.filters.ip = '10.0.0.0/40';
    expect(p.ipError).toBeTruthy();
    expect(await p.load()).toBe(false);
    expect(checkIpFilter('10.1.1.1, 10.2.0.0/16,10.3.0.1-10.3.0.9')).toBeNull();
  });

  it('IP 對照:沒有權限不呼叫;單一 IP 與網段分開查;FQDN 無法對照', async () => {
    const r = rule(1, 'A', {
      expanded: { sources: [{ name: 'g', kind: 'group', values: ['10.1.1.5', '10.2.0.0/16', 'fqdn:x.com', '10.1.1.6/32'], unresolved: true }], destinations: [], services: [], applications: [] },
    });
    const none = fakeBackend([r]);
    const p0 = usePaPolicy({ backend: none, can: () => false });
    await p0.resolveNames(r);
    expect(none.lookupIps).not.toHaveBeenCalled();
    expect(p0.canNames).toBe(false);

    const b = fakeBackend([r]);
    const p = usePaPolicy({ backend: b, can: () => true });
    expect(p.nameOf('10.1.1.5')).toEqual({ status: 'pending' });
    await p.resolveNames(r);
    expect(b.lookupIps).toHaveBeenCalledWith(['10.1.1.5', '10.1.1.6']);
    expect(b.lookupRanges).toHaveBeenCalledWith(['10.2.0.0/16']);
    expect(p.nameOf('10.1.1.5')).toMatchObject({ status: 'ip', label: { name: '王小明' } });
    expect(p.nameOf('10.1.1.6/32')).toEqual({ status: 'none' });
    expect(p.nameOf('10.2.0.0/16')).toMatchObject({ status: 'range', total: 1 });
    expect(p.nameOf('fqdn:x.com')).toEqual({ status: 'unresolvable' });
    // 再查一次不重複呼叫
    await p.resolveNames(r);
    expect(b.lookupIps).toHaveBeenCalledTimes(1);
  });

  it('用名稱找規則:對照表 IP → ip 篩選', async () => {
    const b = fakeBackend([rule(1, 'A')]);
    const p = usePaPolicy({ backend: b, can: () => true });
    expect(await p.findByName('王')).toEqual({ matched: 2, truncated: false });
    expect(p.filters.ip).toBe('10.1.1.5,10.9.0.0/24');
    expect(b.list.mock.calls[0]![0]).toMatchObject({ ip: '10.1.1.5,10.9.0.0/24' });
    expect(await usePaPolicy({ backend: b, can: () => false }).findByName('王')).toBeNull();
  });

  it('重新整理冷卻:顯示訊息不丟錯', async () => {
    const b = fakeBackend([]);
    b.refresh.mockRejectedValueOnce(Object.assign(new Error('請 120 秒後再試'), { code: 'NETOPS_PA_POLICY_REFRESH_COOLDOWN' }));
    const p = usePaPolicy({ backend: b, can: (c) => c === 'netops.pa-policy-page.refresh' });
    expect(p.canRefresh).toBe(true);
    expect(await p.refresh()).toBe(false);
    expect(p.refreshNotice).toBe('請 120 秒後再試');
  });

  it('classifyValue', () => {
    expect(classifyValue('10.0.0.1')).toEqual({ kind: 'ip', ip: '10.0.0.1' });
    expect(classifyValue('10.0.0.1/32')).toEqual({ kind: 'ip', ip: '10.0.0.1' });
    expect(classifyValue('10.0.0.0/8')).toEqual({ kind: 'range', range: '10.0.0.0/8' });
    expect(classifyValue('dynamic:tag')).toEqual({ kind: 'unresolvable' });
    expect(classifyValue('fe80::/10')).toEqual({ kind: 'unresolvable' });
  });
});

describe('usePaPolicyViz(§3.5 資料規則)', () => {
  const rules = [
    rule(1, 'A', { fromZones: ['trust', 'dmz'], toZones: ['untrust'], hits: hits(100) }),
    rule(2, 'B', { fromZones: ['trust'], toZones: ['untrust'], action: 'deny', hits: hits(0) }),
    rule(3, 'C', { fromZones: [], toZones: ['any'], hits: hits(5, '2025-01-01T00:00:00Z') }),
    rule(4, 'D', { disabled: true, hits: hits(9) }),
  ];
  it('矩陣:any 獨立、多 zone 各算一次、停用不算、混合色', () => {
    const m = buildMatrix(rules);
    expect(m.rows).toEqual(['dmz', 'trust', 'any']);
    expect(m.cols).toEqual(['untrust', 'any']);
    const tu = m.cells.find((c) => c.from === 'trust' && c.to === 'untrust')!;
    expect(tu).toMatchObject({ count: 2, allow: 1, deny: 1, tone: 'mixed', positions: [1, 2] });
    expect(m.cells.reduce((s, c) => s + c.count, 0)).toBe(4); // 出現次數,不等於規則數 3
  });
  it('順序條:依順序、停用淡色保留、預設規則在最後、log 刻度、PR-5 未完成 checks 為 null', () => {
    const o = buildOrder(rules, DEF);
    expect(o.map((r) => r.name)).toEqual(['A', 'B', 'C', 'D', 'interzone-default', 'intrazone-default']);
    expect(o[3]!.disabled).toBe(true);
    expect(o[1]).toMatchObject({ zeroHits: true, logHits: 0 });
    expect(o[0]!.logHits).toBeCloseTo(Math.log10(101));
    expect(o[4]).toMatchObject({ isDefault: true, position: null, tone: 'deny' });
    expect(o.every((r) => r.checks === null)).toBe(true);
    expect(buildOrder(rules, [], new Map([[2, [{ code: 'shadowed', severity: 'high', related: [1] }]]]))[1]!.checks).toHaveLength(1);
    expect(buildOrder(rules, [], new Map())[0]!.checks).toEqual([]);
  });
  it('Sankey:多 zone 平均分攤並標估算、預設規則節點、0 命中不畫', () => {
    const s = buildSankey(rules, DEF);
    const l = s.links.find((x) => x.source === 'z:trust' && x.target === 'a:allow')!;
    expect(l).toMatchObject({ value: 50, estimated: true, positions: [1] });
    expect(s.links.some((x) => x.source === 'z:trust' && x.target === 'a:deny')).toBe(false); // B 命中 0
    expect(s.links.find((x) => x.source === DEFAULT_NODE && x.target === 'a:allow')!.value).toBe(7);
    expect(s.nodes.find((n) => n.id === 'a:allow')!.layer).toBe(1);
  });
  it('共用篩選與連動', () => {
    const now = Date.parse('2026-11-19T00:00:00Z');
    expect(filterForViz(rules, { unusedDays: 90 }, now).map((r) => r.name)).toEqual(['B', 'C']);
    expect(filterForViz(rules, { action: 'deny' }, now).map((r) => r.name)).toEqual(['B']);
    expect(filterForViz(rules, { zone: 'any' }, now).map((r) => r.name)).toEqual(['C']);
    const v = usePaPolicyViz(() => rules, () => DEF, undefined, () => now);
    expect(v.highlighted).toBeNull();
    v.select({ kind: 'cell', from: 'trust', to: 'untrust' });
    expect([...v.highlighted!]).toEqual([1, 2]);
    v.select({ kind: 'link', source: 'z:dmz', target: 'a:allow' });
    expect([...v.highlighted!]).toEqual([1]);
    v.filters.zone = 'dmz';
    expect(v.order.filter((r) => r.isDefault)).toHaveLength(0);
    expect(highlightOf(null, v.matrix, v.sankey)).toBeNull();
  });
});

describe('審查修正', () => {
  it('分頁期間快照更新:從第一頁重讀', async () => {
    const rules = Array.from({ length: 150 }, (_, i) => rule(i + 1, `R${i + 1}`));
    const b = fakeBackend(rules);
    const orig = b.list.getMockImplementation()!;
    let n = 0;
    b.list.mockImplementation(async (f, page, size) => {
      const r = await orig(f, page, size);
      n++;
      return n === 2 && r.available ? { ...r, hash: 'changed' } : r;
    });
    const p = usePaPolicy({ backend: b, can: () => true });
    expect(await p.load()).toBe(true);
    expect(p.rules).toHaveLength(150);
    expect(b.list).toHaveBeenCalledTimes(4);
  });
  it('名稱對照失敗:不停在 pending;findByName 查無時清 ip 篩選', async () => {
    const b = fakeBackend([rule(1, 'A')]);
    b.lookupIps.mockRejectedValueOnce(new Error('403'));
    const p = usePaPolicy({ backend: b, can: () => true });
    await p.resolveNames(rule(1, 'A', { expanded: { sources: [{ name: 'x', kind: 'literal', values: ['10.9.9.9'], unresolved: false }], destinations: [], services: [], applications: [] } }));
    expect(p.namesError).toBeTruthy();
    expect(p.nameOf('10.9.9.9')).toEqual({ status: 'none' });
    b.searchNames.mockResolvedValueOnce({ items: [], total: 0 });
    p.filters.ip = '10.1.1.1';
    expect(await p.findByName('沒有這個人')).toEqual({ matched: 0, truncated: false });
    expect(p.filters.ip).toBeUndefined();
  });
  it('規則圖:any zone 符合任何 zone(同清單 API);選取被篩掉時 highlighted 為 null', () => {
    const rs = [rule(1, 'A', { fromZones: ['any'] }), rule(2, 'B', { fromZones: ['dmz'] })];
    expect(filterForViz(rs, { zone: 'trust' }).map((r) => r.name)).toEqual(['A']);
    const v = usePaPolicyViz(() => rs, () => []);
    v.select({ kind: 'cell', from: 'dmz', to: 'untrust' });
    expect([...v.highlighted!]).toEqual([2]);
    v.filters.zone = 'trust';
    expect(v.highlighted).toBeNull();
  });
});
