// @vitest-environment happy-dom
/**
 * 防火牆 › 安全規則頁(PR-4)元件掛載測試:
 *   - 頁首快照時間、過期警告(>2 小時)、收集狀態、冷卻倒數與手動重新整理
 *   - 分頁 1 清單:PA 分組表格、停用淡色、反向標記、物件展開與 IP 對照(單一 IP / 網段展開與截斷 / 無法對照)、名稱找規則、預設規則、詳細抽屜
 *   - 權限控管:canRefresh / canNames / canAi 為 false 時隱藏對應按鈕與對照呼叫
 *   - 無快照(available: false)時整頁顯示 GEmpty
 *   - 分頁 2 變更紀錄:版本清單、比較基準切換、規則與物件差異、第一版提示
 *   - 分頁 3 排序檢查:摘要、imprecise 警告、嚴重度/項目分組、無法判定 reasons、AI 判讀與免責聲明
 *   - 分頁 4 規則圖:Zone × Zone 矩陣點擊連動、清除選取、順序條與 Sankey 掛載
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { DefaultRuleHits, PolicyChecks, PolicyDetail, PolicyDiff, PolicyList, PolicyRule, PolicyVersion } from '@/api/paPolicy';
import type { PaPolicyBackend } from '@/composables/usePaPolicy';
import type { UsePaPolicyCheckOptions } from '@/composables/usePaPolicyCheck';
import Policies from '@/pages/firewall/Policies.vue';
import ui from '@/ui';

// GTabs 內部呼叫 useRoute(),測試時提供最小 route 物件避免 Vue injection 警告
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/netops/firewall/policies', query: {} }),
}));

// AI SSE 串流 mock(測試 PR-FIX 驗證標註 verify 事件)
type OnAiEvent = (e: { event: string; data: unknown }) => void;
const aiState = vi.hoisted(() => ({
  script: async (_on: (e: { event: string; data: unknown }) => void) => {},
}));
vi.mock('@/api/ai', () => ({
  AiStreamError: class extends Error {},
  ai: {
    explain: async (_body: unknown, on: OnAiEvent) => aiState.script(on),
  },
}));

// GEChart 在 happy-dom 中以輕量 stub 掛載,避免動態載入完整 ECharts,同時保留 option 供測試檢查
vi.mock('@/ui/charts/GEChart.vue', () => ({
  default: {
    name: 'GEChart',
    props: ['chart', 'option', 'height', 'ariaLabel'],
    emits: ['pick', 'ready'],
    template: '<div class="gechart-stub" :data-chart="chart" :aria-label="ariaLabel" />',
  },
}));

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
  expanded: {
    sources: [{ name: 'any', kind: 'any', values: [], unresolved: false }],
    destinations: [{ name: 'any', kind: 'any', values: [], unresolved: false }],
    services: [],
    applications: [],
  },
  ...extra,
});

const DEFAULTS: DefaultRuleHits[] = [
  { name: 'intrazone-default', hitCount: 120, lastHit: '2026-11-19T01:00:00Z', firstHit: null, lastReset: null, created: null, modified: null },
  { name: 'interzone-default', hitCount: 5, lastHit: '2026-11-19T00:30:00Z', firstHit: null, lastReset: null, created: null, modified: null },
];

const SAMPLE_RULES: PolicyRule[] = [
  rule(1, 'Allow-Web-Out', {
    tags: ['web', 'prod'],
    fromZones: ['trust'],
    toZones: ['untrust'],
    sources: ['Office-Net'],
    negateSource: true,
    destinations: ['any'],
    applications: ['web-browsing', 'ssl'],
    services: ['application-default'],
    action: 'allow',
    profileGroup: 'strict-pg',
    logStart: true,
    logEnd: true,
    hits: { hitCount: 12345, lastHit: '2026-11-19T01:10:00Z', firstHit: null, lastReset: null, created: null, modified: null },
    expanded: {
      sources: [
        {
          name: 'Office-Net',
          kind: 'group',
          values: ['10.1.1.5', '10.2.0.0/16', 'fqdn:example.com'],
          unresolved: true,
        },
        {
          name: 'Dyn-Servers',
          kind: 'dynamic-group',
          values: [],
          unresolved: true,
        },
      ],
      destinations: [{ name: 'any', kind: 'any', values: [], unresolved: false }],
      services: [{ name: 'application-default', kind: 'application-default', values: [] }],
      applications: [{ name: 'web-browsing', kind: 'application', values: [] }],
    },
  }),
  rule(2, 'Block-Legacy', {
    fromZones: ['dmz'],
    toZones: ['trust'],
    action: 'deny',
    disabled: true,
    hits: null,
    expanded: {
      sources: [{ name: 'any', kind: 'any', values: [], unresolved: false }],
      destinations: [{ name: 'any', kind: 'any', values: [], unresolved: false }],
      services: [],
      applications: [],
    },
  }),
];

const SAMPLE_VERSIONS: PolicyVersion[] = [
  { id: 'v2', hash: '2222aaaa3333', fetchedAt: '2026-11-19T01:00:00Z', savedAt: '2026-11-19T01:00:05Z', ruleCount: 2 },
  { id: 'v1', hash: '1111bbbb2222', fetchedAt: '2026-11-18T12:00:00Z', savedAt: '2026-11-18T12:00:05Z', ruleCount: 1 },
];

const SAMPLE_DIFF_V2: PolicyDiff = {
  id: 'v2',
  baseId: 'v1',
  version: SAMPLE_VERSIONS[0]!,
  base: SAMPLE_VERSIONS[1]!,
  rules: [
    { kind: 'added', name: 'Block-Legacy', position: 2, basePosition: null },
    {
      kind: 'changed',
      name: 'Allow-Web-Out',
      position: 1,
      basePosition: 1,
      fields: [{ field: 'action', before: 'deny', after: 'allow' }],
    },
  ],
  objects: [{ kind: 'addresses', added: ['Office-Net'], removed: [], changed: ['Old-Host'] }],
};

const SAMPLE_DIFF_V1: PolicyDiff = {
  id: 'v1',
  baseId: null,
  version: SAMPLE_VERSIONS[1]!,
  base: null,
  rules: [],
  objects: [],
};

const SAMPLE_CHECKS: PolicyChecks = {
  available: true,
  fetchedAt: '2026-11-19T01:00:00Z',
  hash: '2222aaaa3333',
  versionId: 'v2',
  stale: false,
  hitsFetchedAt: '2026-11-19T01:00:00Z',
  ruleCount: 2,
  status: { collectorEnabled: true, state: 'ok', message: null, lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: 14, durationMs: 250, refreshCooldownSec: 0 },
  unusedDays: 90,
  imprecise: 1,
  summary: {
    conflict: 1,
    shadowed: 0,
    redundant: 0,
    'broad-early': 0,
    unused: 0,
    disabled: 1,
    'no-profile': 0,
    'no-log-end': 0,
    undeterminable: 1,
  },
  items: [
    {
      code: 'conflict',
      severity: 'high',
      position: 2,
      name: 'Block-Legacy',
      related: [{ position: 1, name: 'Allow-Web-Out' }],
      message: '規則 #2 被前面較寬的規則 #1 遮蔽且動作相反',
    },
    {
      code: 'undeterminable',
      severity: 'info',
      position: 1,
      name: 'Allow-Web-Out',
      related: [],
      message: '含動態群組與反向條件,無法精準判定遮蔽關係',
      reasons: ['動態位址群組 Dyn-Servers 無法離線展開', '來源條件使用反向(negate)'],
    },
  ],
};

function makeBackend(overrides: { available?: boolean; stale?: boolean; cooldown?: number } = {}) {
  const available = overrides.available ?? true;
  const list = vi.fn(async (): Promise<PolicyList> => {
    if (!available) {
      return {
        available: false,
        reason: 'no-snapshot',
        message: '尚未收集到 PA 安全規則快照,請確認收集器狀態',
        status: { collectorEnabled: true, state: 'paused', message: '測試區暫停', lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: null, durationMs: null, refreshCooldownSec: 0 },
        items: [],
        total: 0,
        page: 1,
        pageSize: 100,
        defaults: [],
      };
    }
    return {
      available: true,
      fetchedAt: '2026-11-19T01:00:00Z',
      hash: '2222aaaa3333',
      versionId: 'v2',
      stale: overrides.stale ?? false,
      hitsFetchedAt: '2026-11-19T01:00:00Z',
      ruleCount: SAMPLE_RULES.length,
      status: {
        collectorEnabled: true,
        state: 'ok',
        message: null,
        lastRunAt: '2026-11-19T01:00:00Z',
        lastOkAt: '2026-11-19T01:00:00Z',
        trigger: 'poll',
        mgmtCpu: 14,
        durationMs: 250,
        refreshCooldownSec: overrides.cooldown ?? 0,
      },
      items: SAMPLE_RULES,
      total: SAMPLE_RULES.length,
      page: 1,
      pageSize: 100,
      defaults: DEFAULTS,
    };
  });

  const get = vi.fn(async (name: string): Promise<PolicyDetail> => ({
    available: true,
    fetchedAt: '2026-11-19T01:00:00Z',
    hash: '2222aaaa3333',
    versionId: 'v2',
    stale: false,
    hitsFetchedAt: '2026-11-19T01:00:00Z',
    ruleCount: SAMPLE_RULES.length,
    status: { collectorEnabled: true, state: 'ok', message: null, lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: 14, durationMs: 250, refreshCooldownSec: 0 },
    rule: SAMPLE_RULES.find((r) => r.name === name) ?? SAMPLE_RULES[0]!,
  }));

  const refresh = vi.fn(async () => ({ requestedAt: '2026-11-19T01:05:00Z', cooldownSec: 300 }));
  const versions = vi.fn(async () => ({ items: SAMPLE_VERSIONS, total: SAMPLE_VERSIONS.length }));
  const diff = vi.fn(async (id: string) => (id === 'v1' ? SAMPLE_DIFF_V1 : SAMPLE_DIFF_V2));
  const lookupIps = vi.fn(async () => ({
    names: {
      '10.1.1.5': { name: '王小明', department: 'IT', device: 'NB-01', deviceType: '筆電' },
    },
  }));
  const lookupRanges = vi.fn(async () => ({
    results: {
      '10.2.0.0/16': {
        items: [{ ip: '10.2.0.9', name: '李大華', department: '研發部', device: 'PC-09', deviceType: '桌機' }],
        total: 62,
        truncated: true,
      },
    },
  }));
  const searchNames = vi.fn(async () => ({
    items: Array.from({ length: 55 }, (_, i) => ({ ip: `10.1.0.${i + 1}` })),
    total: 55,
  }));

  const backend = { list, get, refresh, versions, diff, lookupIps, lookupRanges, searchNames } as unknown as PaPolicyBackend;
  const checkBackend: NonNullable<UsePaPolicyCheckOptions['backend']> = {
    checks: vi.fn(async () => SAMPLE_CHECKS),
  };
  return { backend, checkBackend, mocks: { list, get, refresh, versions, diff, lookupIps, lookupRanges, searchNames } };
}

function mountPage(opts: { canAll?: boolean; available?: boolean; stale?: boolean; cooldown?: number } = {}) {
  const { backend, checkBackend, mocks } = makeBackend(opts);
  const canFn = () => opts.canAll ?? true;
  const wrapper = mount(Policies, {
    props: {
      policyOptions: { backend, can: canFn },
      checkOptions: { backend: checkBackend, can: canFn },
    },
    global: {
      plugins: [ui],
      stubs: {
        RouterLink: true,
        Teleport: true,
      },
    },
  });
  return { wrapper, mocks, checkBackend };
}

describe('Policies.vue (PR-4 安全規則四分頁)', () => {
  it('清單分頁:無重複 GPageHeader、FQDN 標「無法對應 IP」、停用淡色、反向、預設規則、過期警告與物件展開/IP 對照', async () => {
    const { wrapper, mocks } = mountPage({ stale: true });
    await flushPromises();

    // PR-FIX #1: 外層 TabbedPage 已有標題,頁內不再重複 GPageHeader,只留狀態與重新整理列
    expect(wrapper.find('.g-page-header').exists()).toBe(false);
    expect(wrapper.text()).toContain('超過 2 小時沒更新');
    expect(wrapper.text()).toContain('管理平面 CPU 14%');
    expect(wrapper.text()).toContain('重新整理');

    // PR-FIX #2: unresolved 顯示「無法對應 IP」而非「無法展開」
    expect(wrapper.text()).toContain('無法對應 IP');
    expect(wrapper.text()).not.toContain('無法展開');

    // 表格內容
    expect(wrapper.text()).toContain('Allow-Web-Out');
    expect(wrapper.text()).toContain('Block-Legacy');
    expect(wrapper.text()).toContain('反向');
    expect(wrapper.find('tr.is-disabled').exists()).toBe(true);
    expect(wrapper.text()).toContain('intrazone-default');
    expect(wrapper.text()).toContain('interzone-default');

    // 展開位址物件仍列出 fqdn: 成員並觸發 IP 對照
    const objBtn = wrapper.findAll('button.obj-btn').find((b) => b.text().includes('Office-Net'));
    expect(objBtn).toBeTruthy();
    await objBtn!.trigger('click');
    await flushPromises();

    expect(mocks.lookupIps).toHaveBeenCalledWith(['10.1.1.5']);
    expect(mocks.lookupRanges).toHaveBeenCalledWith(['10.2.0.0/16']);
    expect(wrapper.text()).toContain('fqdn:example.com');
    expect(wrapper.text()).toContain('王小明 / IT / NB-01');
    expect(wrapper.text()).toContain('無法對照');
    expect(wrapper.text()).toContain('對照 62 筆');

    // 展開網段對照清單並顯示截斷提示
    const rangeBtn = wrapper.find('button.range-toggle');
    await rangeBtn.trigger('click');
    expect(wrapper.text()).toContain('只列前 50 筆,共 62 筆');
    expect(wrapper.text()).toContain('李大華 / 研發部 / PC-09');

    // 點擊規則名稱開詳細抽屜
    const nameBtn = wrapper.findAll('button.name-link').find((b) => b.text().includes('Allow-Web-Out'));
    await nameBtn!.trigger('click');
    await flushPromises();
    expect(mocks.get).toHaveBeenCalledWith('Allow-Web-Out');
    expect(wrapper.text()).toContain('基本資訊');
    expect(wrapper.text()).toContain('Rule Hit Count');
  });

  it('權限為 false 時隱藏重新整理、名稱找規則、AI 判讀且不呼叫 IP 對照 API', async () => {
    const { wrapper, mocks } = mountPage({ canAll: false });
    await flushPromises();

    expect(wrapper.text()).not.toContain('重新整理');
    expect(wrapper.text()).not.toContain('用姓名 / 部門 / 設備找規則');

    const objBtn = wrapper.findAll('button.obj-btn').find((b) => b.text().includes('Office-Net'));
    await objBtn!.trigger('click');
    await flushPromises();

    expect(mocks.lookupIps).not.toHaveBeenCalled();
    expect(mocks.lookupRanges).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('10.1.1.5');
    expect(wrapper.text()).not.toContain('王小明');

    // 切到排序檢查分頁:沒有 AI 按鈕
    const checkTabBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text().includes('排序檢查'));
    await checkTabBtn!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('AI 判讀排序建議');
  });

  it('無快照(available: false)時整頁顯示 GEmpty 不顯示空表格', async () => {
    const { wrapper } = mountPage({ available: false });
    await flushPromises();

    expect(wrapper.text()).toContain('尚未收集到 PA 安全規則快照,請確認收集器狀態');
    expect(wrapper.find('table.pa-table').exists()).toBe(false);
  });

  it('變更紀錄、排序檢查、規則圖三個分頁切換與互動', async () => {
    const { wrapper, mocks, checkBackend } = mountPage();
    await flushPromises();

    // 分頁 2:變更紀錄
    const verTabBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text().includes('變更紀錄'));
    await verTabBtn!.trigger('click');
    await flushPromises();

    expect(mocks.versions).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('收集器讀到的時間,不是 PA Commit 時間');
    expect(wrapper.text()).toContain('Block-Legacy');
    expect(wrapper.text()).toContain('Office-Net');

    // 點擊第一版 v1 應顯示「這是第一個版本,沒有可比較的前一版」
    const verBtns = wrapper.findAll('button.ver-item');
    await verBtns[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('這是第一個版本,沒有可比較的前一版');

    // 分頁 3:排序檢查
    const chkTabBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text().includes('排序檢查'));
    await chkTabBtn!.trigger('click');
    await flushPromises();

    expect(checkBackend.checks).toHaveBeenCalledWith(90);
    expect(wrapper.text()).toContain('無法精準比對的條件');
    expect(wrapper.text()).toContain('衝突遮蔽');
    expect(wrapper.text()).toContain('無法判定(需人工確認)');
    expect(wrapper.text()).toContain('動態位址群組 Dyn-Servers 無法離線展開');
    expect(wrapper.text()).toContain('AI 判讀排序建議');

    // 分頁 4:規則圖
    const vizTabBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text().includes('規則圖'));
    await vizTabBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('格子數字是規則出現次數,多 zone 規則會出現在多格');
    const matrixCell = wrapper.find('button.m-cell');
    expect(matrixCell.exists()).toBe(true);
    await matrixCell.trigger('click');
    expect(wrapper.text()).toContain('清除選取');

    // 清除選取
    const clearBtn = wrapper.findAll('button').find((b) => b.text().includes('清除選取'));
    await clearBtn!.trigger('click');
    expect(wrapper.text()).not.toContain('清除選取');

    // 規則圖不顯示 IP 名稱
    expect(wrapper.text()).not.toContain('王小明');
    expect(wrapper.find('[data-chart="policy-order"]').exists()).toBe(true);
    expect(wrapper.find('[data-chart="policy-sankey"]').exists()).toBe(true);
  });

  it('手動重新整理、冷卻倒數與依名稱找規則截斷提示', async () => {
    const { wrapper, mocks } = mountPage({ cooldown: 45 });
    await flushPromises();

    // 冷卻中按鈕停用並顯示倒數
    const refreshBtn = wrapper.findAll('button').find((b) => b.text().includes('重新整理'));
    expect(refreshBtn?.attributes('disabled')).toBeDefined();
    expect(refreshBtn?.text()).toContain('45s');

    // 依名稱找規則回傳 55 筆 → 顯示截斷提示
    const nameInput = wrapper.find('input[placeholder*="輸入姓名"]');
    await nameInput.setValue('王');
    const findBtn = wrapper.findAll('button').find((b) => b.text().includes('依名稱找規則'));
    await findBtn!.trigger('click');
    await flushPromises();

    expect(mocks.searchNames).toHaveBeenCalledWith('王');
    expect(wrapper.text()).toContain('只用前 50 個 IP 篩選');
  });

  it('PR-FIX #3 & #4: 規則圖點矩陣/Sankey 篩選順序條與 Sankey、清除選取、匯出給外部 AI(不含個資)', async () => {
    const extraRules: PolicyRule[] = [
      rule(1, 'Allow-Web-Out', {
        fromZones: ['trust'],
        toZones: ['untrust'],
        sourceUsers: ['gsmc\\s112009'],
        description: '王小明 申請開通',
        action: 'allow',
        hits: { hitCount: 100, lastHit: '2026-11-19T01:00:00Z', firstHit: null, lastReset: null, created: null, modified: null },
      }),
      rule(2, 'Allow-Guest-Net', {
        fromZones: ['guest'],
        toZones: ['untrust'],
        action: 'allow',
        hits: { hitCount: 25, lastHit: '2026-11-19T01:00:00Z', firstHit: null, lastReset: null, created: null, modified: null },
      }),
    ];
    const { backend, checkBackend } = makeBackend();
    (backend.list as ReturnType<typeof vi.fn>).mockImplementation(async (): Promise<PolicyList> => ({
      available: true,
      fetchedAt: '2026-11-19T01:00:00Z',
      hash: 'h-viz',
      versionId: 'v2',
      stale: false,
      hitsFetchedAt: '2026-11-19T01:00:00Z',
      ruleCount: extraRules.length,
      status: { collectorEnabled: true, state: 'ok', message: null, lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: 8, durationMs: 100, refreshCooldownSec: 0 },
      items: extraRules,
      total: extraRules.length,
      page: 1,
      pageSize: 100,
      defaults: DEFAULTS,
    }));

    const wrapper = mount(Policies, {
      props: {
        policyOptions: { backend, can: () => true },
        checkOptions: { backend: checkBackend, can: () => true },
      },
      global: { plugins: [ui], stubs: { RouterLink: true, Teleport: true } },
    });
    await flushPromises();

    // 切到規則圖分頁
    const vizTabBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text().includes('規則圖'));
    await vizTabBtn!.trigger('click');
    await flushPromises();

    // 說明字樣與匯出按鈕存在
    expect(wrapper.text()).toContain('Sankey 會畫出選取規則的所有 zone 組合');
    expect(wrapper.text()).toContain('匯出目前圖上的規則(含篩選與選取);不含 IP 對照姓名 / 部門、說明欄與使用者名稱');

    const orderStub = () => wrapper.findComponent({ name: 'GEChart' });
    const getCharts = () => wrapper.findAllComponents({ name: 'GEChart' });
    expect(orderStub().exists()).toBe(true);
    // 選取前:順序條有 2 條規則 + 2 條預設規則 = 4
    const orderBefore = getCharts().find((c) => c.props('chart') === 'policy-order')!.props('option') as { yAxis: { data: string[] } };
    expect(orderBefore.yAxis.data).toHaveLength(4);

    // 點選 trust → untrust 格子
    const cells = wrapper.findAll('button.m-cell');
    expect(cells).toHaveLength(2);
    const trustCell = cells.find((b) => (b.attributes('title') ?? '').includes('trust → untrust'));
    await trustCell!.trigger('click');

    // 矩陣維持 2 格不縮小,並顯示已篩選列
    expect(wrapper.findAll('button.m-cell')).toHaveLength(2);
    expect(wrapper.text()).toContain('已篩選：trust → untrust，共 1 條');

    // 順序條與 Sankey 只剩選取的 #1 Allow-Web-Out
    const orderAfter = getCharts().find((c) => c.props('chart') === 'policy-order')!.props('option') as { yAxis: { data: string[] } };
    expect(orderAfter.yAxis.data).toEqual(['#1 Allow-Web-Out']);
    const sankeyAfter = getCharts().find((c) => c.props('chart') === 'policy-sankey')!.props('option') as { series: { links: { source: string; target: string }[] }[] };
    expect(sankeyAfter.series[0]!.links.every((l) => l.source !== 'z:guest' && l.source !== 'p:預設規則')).toBe(true);

    // 複製 Markdown:只含選取的 #1,且不含姓名/部門、說明欄、使用者帳號
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copyBtn = wrapper.findAll('button').find((b) => b.text().includes('複製 Markdown'));
    await copyBtn!.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    const md = writeText.mock.calls[0]![0];
    expect(md).toContain('Allow-Web-Out');
    expect(md).not.toContain('Allow-Guest-Net');
    expect(md).not.toContain('王小明');
    expect(md).not.toContain('s112009');
    expect(md).toContain('選取 trust → untrust');

    // 清除選取 → 恢復全部 4 列
    const clearBtn = wrapper.findAll('button').find((b) => b.text().includes('清除選取'));
    await clearBtn!.trigger('click');
    const orderReset = getCharts().find((c) => c.props('chart') === 'policy-order')!.props('option') as { yAxis: { data: string[] } };
    expect(orderReset.yAxis.data).toHaveLength(4);

    // 點選 Sankey「預設規則 → 允許」連線 → 只剩 intrazone-default
    const sankeyComp = getCharts().find((c) => c.props('chart') === 'policy-sankey')!;
    sankeyComp.vm.$emit('pick', { chart: 'policy-sankey', name: 'p:預設規則>a:allow', data: { source: 'p:預設規則', target: 'a:allow' } });
    await flushPromises();
    expect(wrapper.text()).toContain('預設規則 → 允許');
    const orderDefaultOnly = getCharts().find((c) => c.props('chart') === 'policy-order')!.props('option') as { yAxis: { data: string[] } };
    expect(orderDefaultOnly.yAxis.data).toEqual(['[預設] intrazone-default']);
  });

  it('PR-FIX #5: AI 判讀完成後顯示驗證標註(相符提示與不符警告,純文字不執行 HTML)', async () => {
    const { wrapper } = mountPage();
    await flushPromises();

    // 切到排序檢查分頁
    const chkTabBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text().includes('排序檢查'));
    await chkTabBtn!.trigger('click');
    await flushPromises();

    // 情境 A: 驗證通過(flags 為空陣列)
    aiState.script = async (on) => {
      on({ event: 'content', data: { text: '檢查完成,#2 需優先處理。' } });
      on({ event: 'verify', data: { flags: [] } });
      on({ event: 'done', data: { truncated: false } });
    };
    const aiBtn = wrapper.findAll('button').find((b) => b.text().includes('AI 判讀排序建議'));
    await aiBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('系統比對:引用的規則編號都在檢查資料內');

    // 情境 B: 驗證發現不符(含 mismatch code 與 HTML 字串純文字呈現)
    aiState.script = async (on) => {
      on({ event: 'content', data: { text: '缺少 Security Profile:#114。' } });
      on({
        event: 'verify',
        data: {
          flags: [
            { kind: 'unknown', position: 999, reason: '#999:資料中沒有這條規則 <script>alert(1)</script>' },
            { kind: 'mismatch', position: 114, code: 'no-profile', actual: ['broad-early'], reason: '#114:AI 歸為沒有 Security Profile,程式檢查為過寬規則位置過前' },
          ],
        },
      });
      on({ event: 'done', data: { truncated: false } });
    };
    const reRunBtn = wrapper.findAll('button').find((b) => b.text().includes('重新 AI 判讀'));
    await reRunBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('系統比對發現 2 處 AI 引用與檢查結果不符,請以排序檢查清單為準');
    expect(wrapper.text()).toContain('#999');
    expect(wrapper.text()).toContain('資料中沒有這條規則');
    expect(wrapper.text()).toContain('#114');
    expect(wrapper.text()).toContain('程式檢查沒有把這條規則列在這一類');
    expect(wrapper.text()).toContain('沒有 Security Profile');
    expect(wrapper.text()).toContain('#114:AI 歸為沒有 Security Profile,程式檢查為過寬規則位置過前');
    expect(wrapper.text()).toContain('<script>alert(1)</script>');
    expect(wrapper.find('script').exists()).toBe(false);
  });
});
