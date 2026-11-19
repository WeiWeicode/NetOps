// @vitest-environment happy-dom
/**
 * 安全規則驗收修正(2026-11-19):規則圖點選篩選、匯出給外部 AI(不含姓名部門)、AI 判讀驗證標註
 */
import { describe, expect, it, vi } from 'vitest';
import type { CheckItem, DefaultRuleHits, PolicyRule } from '@/api/paPolicy';

type On = (e: { event: string; data: unknown }) => void;
let script: (on: On) => Promise<void> = async () => {};
vi.mock('@/api/ai', () => ({
  AiStreamError: class extends Error {},
  ai: { explain: async (_b: unknown, on: On) => script(on) },
}));

const { usePaPolicyViz, DEFAULT_NODE } = await import('@/composables/usePaPolicyViz');
const { buildExport, exportFileName, toJson, toMarkdown, usePaPolicyExport } = await import('@/composables/usePaPolicyExport');
const { useAiExplain } = await import('@/composables/useAiExplain');

const rule = (position: number, name: string, extra: Partial<PolicyRule> = {}): PolicyRule => ({
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
const rules = [
  rule(1, 'A', { fromZones: ['trust', 'dmz'], toZones: ['untrust'], hits: hits(100) }),
  rule(2, 'B', { fromZones: ['trust'], toZones: ['untrust'], action: 'deny', hits: hits(4) }),
  rule(3, 'C', { fromZones: ['guest'], toZones: ['untrust'], hits: hits(5) }),
  rule(4, 'D', { fromZones: ['trust'], toZones: ['untrust'], disabled: true, hits: hits(9) }),
];

describe('規則圖點選篩選', () => {
  it('沒選取時 shownOrder / shownSankey 同全部', () => {
    const v = usePaPolicyViz(() => rules, () => DEF);
    expect(v.focused).toBe(false);
    expect(v.shownOrder).toEqual(v.order);
    expect(v.shownSankey).toEqual(v.sankey);
    expect(v.shownRules.map((r) => r.position)).toEqual([1, 2, 3, 4]);
  });
  it('點矩陣格子:順序條與 Sankey 只剩選取的規則,矩陣不變', () => {
    const v = usePaPolicyViz(() => rules, () => DEF);
    const cells = v.matrix.cells.length;
    v.select({ kind: 'cell', from: 'trust', to: 'untrust' });
    expect(v.focused).toBe(true);
    expect(v.shownOrder.map((r) => r.name)).toEqual(['A', 'B']); // 停用的 D 不在矩陣,不顯示;預設規則不顯示
    expect(v.shownSankey.links.flatMap((l) => l.positions).every((p) => p === 1 || p === 2)).toBe(true);
    expect(v.shownSankey.nodes.some((n) => n.id === DEFAULT_NODE)).toBe(false);
    expect(v.shownSankey.nodes.some((n) => n.id === 'z:guest')).toBe(false);
    expect(v.matrix.cells.length).toBe(cells);
  });
  it('點 Sankey 連線;預設規則連線只顯示該預設規則', () => {
    const v = usePaPolicyViz(() => rules, () => DEF);
    v.select({ kind: 'link', source: 'z:guest', target: 'a:allow' });
    expect(v.shownOrder.map((r) => r.name)).toEqual(['C']);
    v.select({ kind: 'link', source: DEFAULT_NODE, target: 'a:allow' });
    expect(v.shownOrder.map((r) => r.name)).toEqual(['intrazone-default']);
    expect(v.shownSankey.links).toEqual([expect.objectContaining({ source: DEFAULT_NODE, target: 'a:allow', value: 7 })]);
  });
  it('清除選取;選取被篩選掉時當成沒有選取', () => {
    const v = usePaPolicyViz(() => rules, () => DEF);
    v.select({ kind: 'cell', from: 'guest', to: 'untrust' });
    expect(v.shownOrder).toHaveLength(1);
    v.filters.action = 'deny';
    expect(v.focused).toBe(false);
    expect(v.shownOrder.map((r) => r.name)).toEqual(['B', 'interzone-default']);
    v.filters.action = null;
    v.clearSelection();
    expect(v.selection).toBeNull();
    expect(v.shownOrder).toHaveLength(6);
  });
});

describe('規則圖匯出(不含姓名部門)', () => {
  const r = rule(7, 'Web|Out', {
    fromZones: [],
    sourceUsers: ['gsmc\\s112009', 'gsmc\\s112010'],
    description: '王小明 申請',
    uuid: 'u-1',
    tags: ['人資'],
    logSetting: 'fwd-1',
    profiles: { virus: ['default'], spyware: [] },
    profileGroup: null,
    expanded: {
      sources: [{ name: 'Net_10', kind: 'address', values: ['10.10.0.0/16'], unresolved: false }],
      destinations: [{ name: 'PA_Web', kind: 'group', values: ['fqdn:paloaltonetworks.com', '1.2.3.4'], unresolved: true }],
      services: [{ name: 'svc-web', kind: 'group', values: ['tcp/80', 'tcp/443'] }],
      applications: [{ name: 'web-browsing', kind: 'application', values: [] }],
    },
  });
  const checks: CheckItem[] = [
    { code: 'no-profile', severity: 'medium', position: 7, name: 'Web|Out', related: [], message: '沒有 Profile' },
    { code: 'undeterminable', severity: 'info', position: 7, name: 'Web|Out', related: [{ position: 2, name: 'B' }], message: '可能被涵蓋', reasons: ['FQDN'] },
  ];
  const e = buildExport([r], DEF, checks, { fetchedAt: '2026-11-19T02:33:32.000Z', unusedDays: 90, scope: '選取 trust → untrust' }, new Date('2026-11-19T03:00:00Z'));

  it('欄位:編號、名稱、zone、位址與展開網段、應用、服務、動作、命中數、檢查結果', () => {
    expect(e.rules[0]).toMatchObject({
      position: 7,
      fromZones: ['any'],
      sourceUserCount: 2,
      action: 'allow',
      hitCount: 10,
      profileTypes: ['virus'],
      destinations: [{ name: 'PA_Web', values: ['fqdn:paloaltonetworks.com', '1.2.3.4'], unresolved: true }],
      services: [{ name: 'svc-web', values: ['tcp/80', 'tcp/443'] }],
    });
    expect(e.rules[0]!.checks.map((c) => c.code)).toEqual(['no-profile', 'undeterminable']);
    expect(e.rules[0]!.checks[1]).toMatchObject({ related: [2], reasons: ['FQDN'] });
    expect(e.defaults).toHaveLength(2);
  });
  it('動態群組 Tag 運算式不匯出;Markdown 特殊字元跳脫', () => {
    const d = rule(8, 'Dyn<b>`x`', { expanded: { sources: [{ name: 'DAG', kind: 'dynamic-group', values: ["dynamic:'user-王小明'", "dynamic:'dept-HR'"], unresolved: true }], destinations: [], services: [], applications: [] } });
    const x = buildExport([d], [], []);
    expect(x.rules[0]!.sources[0]!.values).toEqual(['dynamic:(省略)']);
    const md = toMarkdown(x);
    expect(md).not.toMatch(/王小明|dept-HR/);
    expect(md).toContain('Dyn\\<b\\>\\`x\\`');
  });
  it('不含使用者名稱、說明欄、uuid、Tag、Log Forwarding', () => {
    for (const s of [toJson(e), toMarkdown(e)]) {
      expect(s).not.toMatch(/s112009|王小明|u-1|人資|fwd-1/);
      expect(s).not.toMatch(/description|sourceUsers"/);
    }
  });
  it('Markdown:表格跳脫 |、FQDN 標無法對應 IP、檢查結果段落', () => {
    const md = toMarkdown(e);
    expect(md).toContain('| 7 | Web\\|Out | any | untrust |');
    expect(md).toContain('PA_Web [fqdn:paloaltonetworks.com, 1.2.3.4](含無法對應 IP 的成員)');
    expect(md).toContain('有使用者條件(2 個)');
    expect(md).toMatch(/\[中\] 沒有 Security Profile #7 Web\\\|Out:沒有 Profile/);
    expect(md).toContain('(相關 #2)(原因:FQDN)');
    expect(md).toContain('- 範圍:選取 trust → untrust');
    expect(JSON.parse(toJson(e)).rules[0].position).toBe(7);
    expect(md).toContain('名稱可能含人名或設備使用者,外送前請自行確認');
    expect(JSON.parse(toJson(e)).note).toContain('名稱可能含人名或設備使用者,外送前請自行確認');
  });
  it('檔名與下載;沒有規則不下載', () => {
    expect(exportFileName(e, 'md')).toBe('pa-policy-20261119-1033.md');
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const ex = usePaPolicyExport(() => [r], () => [], () => checks, () => ({ fetchedAt: '2026-11-19T02:33:32.000Z' }));
    expect(ex.download('json')).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(usePaPolicyExport(() => [], () => [], () => null).download('md')).toBe(false);
    expect(ex.markdown()).toContain('# PA 安全規則匯出');
  });
  it('配合規則圖:匯出目前顯示的規則', () => {
    const v = usePaPolicyViz(() => rules, () => DEF);
    v.select({ kind: 'cell', from: 'guest', to: 'untrust' });
    const ex = usePaPolicyExport(() => v.shownRules, () => v.shownDefaults, () => []);
    expect(ex.build().rules.map((x) => x.name)).toEqual(['C']);
    expect(ex.build().defaults).toEqual([]);
  });
});

describe('AI 判讀驗證標註(verify 事件)', () => {
  it('收到 verify 存到 flags;reset 清掉;沒有 verify 時為 null', async () => {
    const flag = { kind: 'mismatch', position: 114, code: 'no-profile', actual: [], reason: '#114:AI 歸為沒有 Security Profile,程式檢查沒有列出這條規則' };
    script = async (on) => {
      on({ event: 'meta', data: { kind: 'pa-policy' } });
      on({ event: 'content', data: { text: '## 整體評估' } });
      on({ event: 'verify', data: { flags: [flag] } });
      on({ event: 'done', data: { finish: 'stop', truncated: false } });
    };
    const a = useAiExplain();
    await a.start({ kind: 'pa-policy', params: { unusedDays: 90 } } as never);
    expect(a.flags.value).toEqual([flag]);
    a.reset();
    expect(a.flags.value).toBeNull();
    script = async (on) => {
      on({ event: 'content', data: { text: 'x' } });
      on({ event: 'done', data: {} });
    };
    await a.start({ kind: 'pa-policy', params: { unusedDays: 90 } } as never);
    expect(a.flags.value).toBeNull();
  });
});
