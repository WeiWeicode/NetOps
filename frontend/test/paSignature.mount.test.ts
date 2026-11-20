// @vitest-environment happy-dom
/**
 * 防火牆 › 威脅特徵碼頁、跨頁抽屜與戰情室新特徵提示(TS-4)元件掛載測試:
 *   - Signatures.vue 頁首(威脅 / AV / WildFire 版本、過期警告、收集狀態/CPU、重新整理冷卻、unavailable GEmpty、AI 分頁權限)
 *   - TS-2 審查結論逐項驗證:
 *     1. firstVersion 為 null 時顯示「未知」(清單與抽屜皆同)
 *     2. 標成 rebuilt 的版本顯示「這一版差異無法計算」(清單、版本差異與抽屜皆同)
 *     3. 歷史不足時顯示「自 YYYY-MM-DD 起統計」(用 since;清單與命中比對皆同)
 *     4. 命中比對的 IP / 名稱「只依後端回傳顯示」(includeIps / topSrc / topDst / nameOfIp),前端元件不自行判斷權限
 *     5. 快照查無的 ID 走 202 + lookup,查不到顯示「本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)」
 *   - 規則覆蓋分頁(缺口摘要、unknown 不可當成已有防護、點擊開 PolicyRuleDrawer)
 *   - AI 摘要分頁(「AI 建議,需網通確認」只放開頭不重複、meta 總數與送出筆數、串流回答)
 *   - 戰情室(mergeNewSignatureHits 去重排序、NewSignatureHitsBar、EventFeed / RiskPanel / TrafficLogTable / RankingDrawer / Live.vue)
 *   - 跨頁抽屜接線(Events.vue 安全事件威脅排行、Search.vue 威脅欄位與明細、SliceDrawer.vue 威脅明細列)
 */
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { PolicyDetail } from '@/api/paPolicy';
import type {
  HitQueryResult,
  SignatureCoverage,
  SignatureDetailFound,
  SignatureList,
  SignatureLookupJob,
  SignatureStatusResponse,
  SignatureVersionDiffs,
  SignatureVersionList,
} from '@/api/paSignature';
import type { LiveLog, PaLiveSnapshot } from '@/api/paLive';
import type { HourlyInsight, NewSignatureHit, Warroom, WarroomRisk } from '@/api/warroom';
import type { PaSignatureBackend } from '@/composables/usePaSignature';
import { PA_SIGNATURE_AI_DISCLAIMER } from '@/composables/usePaSignature';
import { usePaSignatureDrawer } from '@/composables/usePaSignatureDrawer';
import { mergeNewSignatureHits } from '@/composables/useWarroom';
import SignatureDrawer from '@/components/signatures/SignatureDrawer.vue';
import SliceDrawer from '@/components/SliceDrawer.vue';
import EventFeed from '@/components/warroom/EventFeed.vue';
import NewSignatureHitsBar from '@/components/warroom/NewSignatureHitsBar.vue';
import RankingDrawer from '@/components/warroom/RankingDrawer.vue';
import RiskPanel from '@/components/warroom/RiskPanel.vue';
import TrafficLogTable from '@/components/warroom/TrafficLogTable.vue';
import Events from '@/pages/firewall/Events.vue';
import Live from '@/pages/firewall/Live.vue';
import Search from '@/pages/firewall/Search.vue';
import Signatures from '@/pages/firewall/Signatures.vue';
import ui from '@/ui';

const RouterLinkStub = {
  name: 'RouterLink',
  props: ['to'],
  template: '<a class="router-link-stub" :data-to="typeof to === \'string\' ? to : JSON.stringify(to)"><slot /></a>',
};

const MOUNT_GLOBAL = {
  plugins: [ui],
  stubs: { RouterLink: RouterLinkStub },
};

const hoisted = vi.hoisted(() => ({
  perms: new Set<string>([
    'netops.pa-signature.read',
    'netops.pa-signature-page.read',
    'netops.pa-signature-page.ai',
    'netops.pa-signature-page.refresh',
    'netops.pa-policy.read',
    'netops.pa-live.ai',
    'netops.pa-live.manage',
  ]),
  routeQuery: {} as Record<string, string>,
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
  aiScript: async (_on: (e: { event: string; data: unknown }) => void) => {},
  sigGet: vi.fn(),
  sigLookup: vi.fn(),
  evTypes: vi.fn(),
  evOverview: vi.fn(),
  paDays: vi.fn(),
  paOptions: vi.fn(),
  paLogCreate: vi.fn(),
  paLogGet: vi.fn(),
  paLogRows: vi.fn(),
  paLogCancel: vi.fn(),
  wrGet: vi.fn(),
  wrRisk: vi.fn(),
  wrInsight: vi.fn(),
  liveSnapshot: vi.fn(),
  liveLogs: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/firewall/signatures', query: hoisted.routeQuery }),
  useRouter: () => ({ replace: hoisted.routerReplace, push: hoisted.routerPush }),
  RouterLink: {
    name: 'RouterLink',
    props: ['to'],
    template: '<a class="router-link-stub" :data-to="typeof to === \'string\' ? to : JSON.stringify(to)"><slot /></a>',
  },
}));

vi.mock('@/api/gateway', async (orig) => ({
  ...(await orig<typeof import('@/api/gateway')>()),
  can: (code: string) => hoisted.perms.has(code),
}));

vi.mock('@/api/ai', () => ({
  AiStreamError: class extends Error {},
  ai: {
    explain: async (_body: unknown, on: (e: { event: string; data: unknown }) => void) => hoisted.aiScript(on),
  },
}));

vi.mock('@/api/paSignature', async (orig) => {
  const real = await orig<typeof import('@/api/paSignature')>();
  return {
    ...real,
    paSignatureApi: {
      ...real.paSignatureApi,
      get: hoisted.sigGet,
      lookup: hoisted.sigLookup,
    },
  };
});

vi.mock('@/api/paEvents', async (orig) => {
  const real = await orig<typeof import('@/api/paEvents')>();
  return {
    ...real,
    paEvents: {
      ...real.paEvents,
      types: hoisted.evTypes,
      overview: hoisted.evOverview,
    },
  };
});

vi.mock('@/api/pa', async (orig) => {
  const real = await orig<typeof import('@/api/pa')>();
  return {
    ...real,
    pa: {
      ...real.pa,
      days: hoisted.paDays,
      options: hoisted.paOptions,
    },
    paLog: {
      ...real.paLog,
      create: hoisted.paLogCreate,
      get: hoisted.paLogGet,
      rows: hoisted.paLogRows,
      cancel: hoisted.paLogCancel,
    },
  };
});

vi.mock('@/api/warroom', async (orig) => ({
  ...(await orig<typeof import('@/api/warroom')>()),
  warroom: {
    get: hoisted.wrGet,
    risk: hoisted.wrRisk,
    insight: hoisted.wrInsight,
    runInsight: vi.fn(),
  },
}));

vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return {
    ...real,
    paLive: {
      ...real.paLive,
      snapshot: hoisted.liveSnapshot,
      logs: hoisted.liveLogs,
      setControl: vi.fn(),
      streamUrl: () => '/api/netops/pa-live/stream',
      probeStream: vi.fn(),
    },
  };
});

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  constructor(public url: string) {}
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const SAMPLE_STATUS = {
  collectorEnabled: true,
  state: 'ok',
  message: null,
  lastRunAt: '2026-11-20T01:00:00Z',
  lastOkAt: '2026-11-20T01:00:00Z',
  trigger: 'poll',
  mgmtCpu: 22,
  durationMs: 1200,
  count: 20000,
  threatVersion: '9002-1234',
  fullFetch: false,
  refreshCooldownSec: 0,
  lookupCooldownSec: 0,
};

const SAMPLE_LIST: SignatureList = {
  available: true,
  threatVersion: '9002-1234',
  threatReleaseDate: '2026-11-20',
  fetchedAt: '2026-11-20T01:00:00Z',
  checkedAt: '2026-11-20T01:00:00Z',
  stale: true,
  versions: {
    appVersion: '9002-1234',
    appReleaseDate: '2026-11-20',
    avVersion: '5001-5555',
    avReleaseDate: '2026-11-19',
    wildfireVersion: '991234',
    wildfireReleaseDate: '2026-11-20',
    urlFilteringVersion: null,
  },
  counts: { vulnerability: 12000, spyware: 8000, total: 20000 },
  baselineAt: '2026-11-15T00:00:00Z',
  days: 30,
  since: '2026-11-15',
  rebuilt: true,
  hitsAvailable: true,
  status: SAMPLE_STATUS,
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    {
      id: '547000',
      kind: 'vulnerability',
      name: 'Apache HTTP Server RCE',
      severity: 'critical',
      category: 'code-execution',
      defaultAction: 'reset-both',
      disabled: false,
      cves: ['CVE-2026-0001'],
      vendorIds: ['MS-1'],
      affectedHost: 'server',
      engineVersion: '8.0',
      timeAttribute: null,
      firstVersion: '9002-1234',
      isNew: true,
      hits30d: 42,
    },
    {
      id: '91001',
      kind: 'spyware',
      name: 'Legacy Unknown Baseline Spyware',
      severity: 'high',
      category: 'command-and-control',
      defaultAction: 'alert',
      disabled: false,
      cves: [],
      vendorIds: [],
      affectedHost: 'client',
      engineVersion: '7.0',
      timeAttribute: null,
      firstVersion: null,
      isNew: false,
      hits30d: 0,
    },
  ],
};

const SAMPLE_VERSIONS: SignatureVersionList = {
  baselineAt: '2026-11-15T00:00:00Z',
  baselineVersion: '9000-1000',
  total: 3,
  items: [
    {
      threatVersion: '9002-1234',
      releaseDate: '2026-11-20',
      fetchedAt: '2026-11-20T01:00:00Z',
      savedAt: '2026-11-20T01:00:00Z',
      isBaseline: false,
      rebuilt: false,
      added: 2,
      changed: 1,
      removed: 0,
      hash: 'a'.repeat(64),
      counts: { vulnerability: 12000, spyware: 8000, total: 20000 },
    },
    {
      threatVersion: '9001-1200',
      releaseDate: '2026-11-18',
      fetchedAt: '2026-11-18T01:00:00Z',
      savedAt: '2026-11-18T01:00:00Z',
      isBaseline: false,
      rebuilt: true,
      added: 0,
      changed: 0,
      removed: 0,
      hash: 'b'.repeat(64),
      counts: { vulnerability: 11998, spyware: 8000, total: 19998 },
    },
    {
      threatVersion: '9000-1000',
      releaseDate: '2026-11-15',
      fetchedAt: '2026-11-15T01:00:00Z',
      savedAt: '2026-11-15T01:00:00Z',
      isBaseline: true,
      rebuilt: false,
      added: 0,
      changed: 0,
      removed: 0,
      hash: 'c'.repeat(64),
      counts: { vulnerability: 11990, spyware: 7995, total: 19985 },
    },
  ],
};

const DIFF_BY_VERSION: Record<string, SignatureVersionDiffs> = {
  '9002-1234': {
    threatVersion: '9002-1234',
    baseVersion: '9001-1200',
    releaseDate: '2026-11-20',
    fetchedAt: '2026-11-20T01:00:00Z',
    savedAt: '2026-11-20T01:00:00Z',
    isBaseline: false,
    rebuilt: false,
    counts: { vulnerability: 12000, spyware: 8000, total: 20000 },
    summary: { added: 1, changed: 1, removed: 0 },
    total: 2,
    page: 1,
    pageSize: 50,
    items: [
      {
        diffKind: 'added',
        id: '547000',
        kind: 'vulnerability',
        name: 'Apache HTTP Server RCE',
        severity: 'critical',
        category: 'code-execution',
        defaultAction: 'reset-both',
        disabled: false,
        cves: ['CVE-2026-0001'],
      },
      {
        diffKind: 'changed',
        id: '91001',
        kind: 'spyware',
        name: 'Legacy Unknown Baseline Spyware',
        severity: 'high',
        category: 'command-and-control',
        fields: [{ field: 'defaultAction', before: 'alert', after: 'reset-both' }],
      },
    ],
  },
  '9001-1200': {
    threatVersion: '9001-1200',
    baseVersion: '9000-1000',
    releaseDate: '2026-11-18',
    fetchedAt: '2026-11-18T01:00:00Z',
    savedAt: '2026-11-18T01:00:00Z',
    isBaseline: false,
    rebuilt: true,
    counts: { vulnerability: 11998, spyware: 8000, total: 19998 },
    summary: { added: 0, changed: 0, removed: 0 },
    total: 0,
    page: 1,
    pageSize: 50,
    items: [],
  },
  '9000-1000': {
    threatVersion: '9000-1000',
    baseVersion: null,
    releaseDate: '2026-11-15',
    fetchedAt: '2026-11-15T01:00:00Z',
    savedAt: '2026-11-15T01:00:00Z',
    isBaseline: true,
    rebuilt: false,
    counts: { vulnerability: 11990, spyware: 7995, total: 19985 },
    summary: { added: 0, changed: 0, removed: 0 },
    total: 0,
    page: 1,
    pageSize: 50,
    items: [],
  },
};

const SAMPLE_DETAIL: SignatureDetailFound = {
  found: true,
  source: 'snapshot',
  threatVersion: '9002-1234',
  fetchedAt: '2026-11-20T01:00:00Z',
  baselineAt: '2026-11-15T00:00:00Z',
  rebuilt: false,
  item: {
    id: '547000',
    kind: 'vulnerability',
    name: 'Apache HTTP Server RCE',
    severity: 'critical',
    category: 'code-execution',
    defaultAction: 'reset-both',
    disabled: false,
    cves: ['CVE-2026-0001'],
    vendorIds: ['MS-1'],
    affectedHost: 'server',
    engineVersion: '8.0',
    timeAttribute: null,
    firstVersion: null,
    isNew: true,
    hits30d: 42,
    changes: [
      {
        threatVersion: '9001-1200',
        releaseDate: '2026-11-18',
        savedAt: '2026-11-18T01:00:00Z',
        kind: 'rebuilt',
        rebuilt: true,
      },
    ],
    vault: null,
  },
};

const SAMPLE_COVERAGE: SignatureCoverage = {
  available: true,
  policyFetchedAt: '2026-11-20T00:30:00Z',
  profilesFetchedAt: '2026-11-20T00:30:00Z',
  profilesAvailable: true,
  summary: {
    totalAllowEnabled: 40,
    covered: 35,
    missingVulnerability: 2,
    missingSpyware: 1,
    missingBoth: 1,
    unknown: 1,
  },
  items: [
    {
      position: 5,
      name: 'Allow-DMZ-Web',
      fromZones: ['untrust'],
      toZones: ['dmz'],
      applications: ['web-browsing', 'ssl'],
      profileGroup: null,
      status: 'missing',
      missing: ['vulnerability', 'spyware'],
      hitCount: 500,
    },
    {
      position: 12,
      name: 'Allow-Unknown-PG',
      fromZones: ['trust'],
      toZones: ['untrust'],
      applications: ['any'],
      profileGroup: 'custom-pg',
      status: 'unknown',
      missing: [],
      reason: '找不到 Profile Group 定義',
      hitCount: 120,
    },
  ],
};

function makeHitsResult(includeIps: boolean): HitQueryResult {
  return {
    days: 30,
    since: '2026-11-15',
    from: '2026-11-15T00:00:00Z',
    to: '2026-11-20T01:00:00Z',
    scope: 'new',
    queriedIds: 5,
    truncatedIds: false,
    includeIps,
    items: [
      {
        id: '547000',
        kind: 'vulnerability',
        name: 'Apache HTTP Server RCE',
        severity: 'critical',
        hits: 18,
        repeats: 25,
        blocked: 5,
        alerted: 13,
        actions: { alert: 13, 'reset-both': 5 },
        firstSeen: '2026-11-18T02:00:00Z',
        lastSeen: '2026-11-20T00:10:00Z',
        rules: ['Allow-DMZ-Web'],
        ruleDetails: [{ name: 'Allow-DMZ-Web', unprotected: true }],
        ...(includeIps
          ? {
              topSrc: [{ ip: '10.10.10.5', count: 12 }],
              topDst: [{ ip: '10.10.200.8', count: 18 }],
            }
          : {}),
      },
    ],
  };
}

function makeBackend(over: Partial<PaSignatureBackend> = {}): PaSignatureBackend {
  const statusRes: SignatureStatusResponse = {
    available: true,
    baselineAt: '2026-11-15T00:00:00Z',
    versionCount: 3,
    ...SAMPLE_STATUS,
    refreshCooldownSec: 60,
  };
  return {
    list: vi.fn(async () => SAMPLE_LIST),
    get: vi.fn(async () => SAMPLE_DETAIL),
    lookup: vi.fn(),
    versions: vi.fn(async () => SAMPLE_VERSIONS),
    versionDiffs: vi.fn(async (ver) => DIFF_BY_VERSION[ver] ?? DIFF_BY_VERSION['9002-1234']!),
    queryHits: vi.fn(async () => ({ kind: 'result' as const, result: makeHitsResult(false) })),
    hitJob: vi.fn(),
    cancelHitJob: vi.fn(),
    queryHitIps: vi.fn(async () => ({ kind: 'result' as const, result: makeHitsResult(true) })),
    hitIpJob: vi.fn(),
    cancelHitIpJob: vi.fn(),
    coverage: vi.fn(async () => SAMPLE_COVERAGE),
    refresh: vi.fn(async () => ({ requestedAt: '2026-11-20T01:01:00Z', cooldownSec: 60 })),
    status: vi.fn(async () => statusRes),
    lookupIps: vi.fn(async () => ({
      names: {
        '10.10.10.5': { name: '王小明', department: '資訊部', device: 'NB-01', deviceType: 'pc' },
      },
    })),
    ...over,
  };
}

const SAMPLE_POLICY_DETAIL: PolicyDetail = {
  available: true,
  fetchedAt: '2026-11-20T00:30:00Z',
  hash: 'f'.repeat(64),
  versionId: 'v1',
  stale: false,
  hitsFetchedAt: '2026-11-20T00:30:00Z',
  ruleCount: 10,
  status: {
    collectorEnabled: true,
    state: 'ok',
    message: null,
    lastRunAt: '2026-11-20T00:30:00Z',
    lastOkAt: '2026-11-20T00:30:00Z',
    trigger: 'poll',
    mgmtCpu: 20,
    durationMs: 800,
    refreshCooldownSec: 0,
  },
  rule: {
    position: 5,
    name: 'Allow-DMZ-Web',
    uuid: null,
    type: 'universal',
    tags: [],
    groupTag: null,
    fromZones: ['untrust'],
    toZones: ['dmz'],
    sources: ['any'],
    sourceUsers: [],
    sourceDevices: [],
    negateSource: false,
    destinations: ['any'],
    destinationDevices: [],
    negateDestination: false,
    applications: ['web-browsing'],
    services: ['application-default'],
    categories: [],
    action: 'allow',
    profileGroup: null,
    profiles: {},
    logStart: false,
    logEnd: true,
    logSetting: null,
    schedule: null,
    disabled: false,
    description: 'DMZ web rule',
    hits: { hitCount: 500, lastHit: null, firstHit: null, lastReset: null, created: null, modified: null },
    expanded: { sources: [], destinations: [], services: [], applications: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.routeQuery = {};
  hoisted.perms = new Set([
    'netops.pa-signature.read',
    'netops.pa-signature-page.read',
    'netops.pa-signature-page.ai',
    'netops.pa-signature-page.refresh',
    'netops.pa-policy.read',
    'netops.pa-live.ai',
    'netops.pa-live.manage',
  ]);
  hoisted.aiScript = async () => {};
  hoisted.sigGet.mockResolvedValue(SAMPLE_DETAIL);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  document.body.innerHTML = '<div id="page-actions"></div>';
});

describe('Signatures.vue — 頁首、清單、版本差異、規則覆蓋與 AI 摘要(TS-4)', () => {
  it('頁首顯示威脅 / AV / WildFire 版本、過期警告、CPU 與手動重新整理，清單驗證 TS-2 結論(firstVersion 未知、since、rebuilt)', async () => {
    const backend = makeBackend();
    const drawerBackend = { get: vi.fn(async () => SAMPLE_DETAIL), lookup: vi.fn() };
    const w = mount(Signatures, {
      props: {
        signatureOptions: { backend, can: () => true },
        drawerOptions: { backend: drawerBackend, can: () => true },
        ruleDrawerOptions: {
          backend: { get: vi.fn(async () => SAMPLE_POLICY_DETAIL) } as never,
          can: () => true,
        },
      },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });
    await flushPromises();

    const text = w.text();
    // TS-Q4: 威脅、AV、WildFire 版本與發布日期
    expect(text).toContain('9002-1234');
    expect(text).toContain('5001-5555');
    expect(text).toContain('991234');
    expect(text).toContain('超過 2 小時沒更新');
    expect(text).toContain('管理平面 CPU 22%');

    // TS-2 審查結論 1: firstVersion 為 null 顯示「未知」
    expect(text).toContain('Legacy Unknown Baseline Spyware');
    expect(text).toContain('未知');
    // TS-2 審查結論 2: rebuilt 顯示「這一版差異無法計算」
    expect(text).toContain('這一版差異無法計算');
    // TS-2 審查結論 3: 歷史不足顯示「自 YYYY-MM-DD 起統計」
    expect(text).toContain('自 2026-11-15 起統計');

    // 手動重新整理按鈕觸發 refresh、呼叫 loadStatus 更新冷卻倒數並顯示通知
    const refreshBtn = w.findAll('button').find((b) => b.text().includes('重新整理'))!;
    await refreshBtn.trigger('click');
    await flushPromises();
    expect(backend.refresh).toHaveBeenCalledTimes(1);
    expect(backend.status).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain('重新整理 (60s)');
    expect(w.text()).toContain('已請收集器重新讀取威脅特徵碼');

    // 點擊特徵開啟抽屜
    const sigBtn = w.findAll('button').find((b) => b.text().includes('Apache HTTP Server RCE'))!;
    await sigBtn.trigger('click');
    await flushPromises();
    expect(drawerBackend.get).toHaveBeenCalledWith('547000');
    expect(document.body.textContent).toContain('#547000 Apache HTTP Server RCE');
    expect(document.body.textContent).toContain('這一版差異無法計算');
    expect(document.body.textContent).toContain('未知');

    w.unmount();
  });

  it('snapshots 不可用(available: false)時顯示 GEmpty;無 refresh / ai 權限時隱藏對應按鈕與分頁', async () => {
    const backend = makeBackend({
      list: vi.fn(async () => ({
        available: false as const,
        reason: 'no-snapshot' as const,
        message: '收集器尚未完成首次特徵碼同步',
        status: null,
        days: 30 as const,
        baselineAt: null,
        since: null,
        hitsAvailable: false as const,
        total: 0,
        page: 1,
        pageSize: 50,
        items: [],
      })),
    });
    const w = mount(Signatures, {
      props: {
        signatureOptions: { backend, can: () => false },
        drawerOptions: { backend: { get: vi.fn(), lookup: vi.fn() }, can: () => false },
      },
      global: MOUNT_GLOBAL,
    });
    await flushPromises();

    expect(w.text()).toContain('收集器尚未完成首次特徵碼同步');
    expect(w.text()).not.toContain('重新整理');
    expect(w.text()).not.toContain('AI 摘要');
    w.unmount();
  });

  it('版本差異分頁:切到 rebuilt 版顯示「這一版差異無法計算」,切到基準版顯示基準說明', async () => {
    const backend = makeBackend();
    const w = mount(Signatures, {
      props: {
        signatureOptions: { backend, can: () => true },
        drawerOptions: { backend: { get: vi.fn(async () => SAMPLE_DETAIL), lookup: vi.fn() }, can: () => true },
      },
      global: MOUNT_GLOBAL,
    });
    await flushPromises();

    const tabBtn = w.findAll('button').find((b) => b.text().includes('版本差異'))!;
    await tabBtn.trigger('click');
    await flushPromises();

    expect(w.text()).toContain('90 份');
    expect(w.text()).toContain('Apache HTTP Server RCE');
    expect(w.text()).toContain('reset-both');

    // 選取 rebuilt 版本 9001-1200
    const rebuiltBtn = w.findAll('button.ver-item').find((b) => b.text().includes('9001-1200'))!;
    await rebuiltBtn.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('這一版差異無法計算');

    // 選取基準版本 9000-1000
    const baseBtn = w.findAll('button.ver-item').find((b) => b.text().includes('9000-1000'))!;
    await baseBtn.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('這是第一次讀到的基準版本');

    w.unmount();
  });

  it('命中比對分頁(TS-2 審查結論):IP 與名稱只依後端回傳顯示,前端元件不自行判斷權限', async () => {
    // 情境 A: 前端 can() 全開(true),但後端回傳 includeIps: false → 不可顯示任何 IP 區塊與名稱
    const backendNoIps = makeBackend({
      queryHitIps: vi.fn(async () => ({ kind: 'result' as const, result: makeHitsResult(false) })),
    });
    const wNoIps = mount(Signatures, {
      props: {
        signatureOptions: { backend: backendNoIps, can: () => true },
        drawerOptions: { backend: { get: vi.fn(), lookup: vi.fn() }, can: () => true },
      },
      global: MOUNT_GLOBAL,
    });
    await flushPromises();

    await wNoIps.findAll('button').find((b) => b.text().includes('命中比對'))!.trigger('click');
    await flushPromises();
    await wNoIps.find('form').trigger('submit');
    await flushPromises();

    expect(wNoIps.text()).toContain('自 2026-11-15 起統計');
    expect(wNoIps.text()).toContain('此規則沒有防護，命中只是 log');
    expect(wNoIps.text()).not.toContain('前 10 來源 IP');
    expect(wNoIps.text()).not.toContain('10.10.10.5');
    expect(wNoIps.text()).not.toContain('王小明');
    wNoIps.unmount();

    // 情境 B: 前端沒有 pa-log.read(走 queryHits),但後端回傳 includeIps: true 且帶回 topSrc/topDst → 依後端回傳顯示 IP 與名稱
    const backendWithIps = makeBackend({
      queryHits: vi.fn(async () => ({ kind: 'result' as const, result: makeHitsResult(true) })),
    });
    const wWithIps = mount(Signatures, {
      props: {
        signatureOptions: { backend: backendWithIps, can: (c) => c === 'netops.ip-name.read' },
        drawerOptions: { backend: { get: vi.fn(), lookup: vi.fn() }, can: () => false },
      },
      global: MOUNT_GLOBAL,
    });
    await flushPromises();

    await wWithIps.findAll('button').find((b) => b.text().includes('命中比對'))!.trigger('click');
    await flushPromises();
    await wWithIps.find('form').trigger('submit');
    await flushPromises();

    expect(wWithIps.text()).toContain('前 10 來源 IP');
    expect(wWithIps.text()).toContain('10.10.10.5');
    expect(wWithIps.text()).toContain('10.10.200.8');
    expect(wWithIps.text()).toContain('王小明 / 資訊部 / NB-01');
    wWithIps.unmount();
  });

  it('規則覆蓋分頁:顯示缺口摘要、unknown 警告,點擊規則開啟 PolicyRuleDrawer', async () => {
    const ruleGet = vi.fn(async () => SAMPLE_POLICY_DETAIL);
    const backend = makeBackend();
    const w = mount(Signatures, {
      props: {
        signatureOptions: { backend, can: () => true },
        drawerOptions: { backend: { get: vi.fn(), lookup: vi.fn() }, can: () => true },
        ruleDrawerOptions: { backend: { get: ruleGet } as never, can: () => true },
      },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });
    await flushPromises();

    await w.findAll('button').find((b) => b.text().includes('規則覆蓋'))!.trigger('click');
    await flushPromises();

    expect(w.text()).toContain('無法判定');
    expect(w.text()).toContain('不可當成已有防護');
    expect(w.text()).toContain('Allow-DMZ-Web');

    const ruleBtn = w.findAll('button.rule-btn').find((b) => b.text().includes('Allow-DMZ-Web'))!;
    await ruleBtn.trigger('click');
    await flushPromises();
    expect(ruleGet).toHaveBeenCalledWith('Allow-DMZ-Web');

    w.unmount();
  });

  it('AI 摘要分頁:「AI 建議,需網通確認」只出現在開頭一次、顯示總數與送出筆數及串流回答', async () => {
    hoisted.aiScript = async (on) => {
      on({
        event: 'meta',
        data: {
          kind: 'pa-signature',
          model: 'qwen-test',
          threatVersion: '9002-1234',
          days: 30,
          totalHighRiskNew: 80,
          sentSignatures: 50,
          truncated: true,
          since: '2026-11-15',
          rebuilt: false,
          hitsAvailable: true,
          coverageAvailable: true,
          contextChars: 3200,
          clipped: false,
          notes: [],
          vectorError: false,
          source: 'pa-signature',
          partial: false,
          gapsKnown: true,
        },
      });
      on({ event: 'content', data: { text: '### 優先檢查項目\n- 檢查 #547000 與未防護的 allow 規則' } });
      on({ event: 'done', data: { finish: 'stop' } });
    };

    const backend = makeBackend();
    const w = mount(Signatures, {
      props: {
        signatureOptions: { backend, can: () => true },
        drawerOptions: { backend: { get: vi.fn(), lookup: vi.fn() }, can: () => true },
      },
      global: MOUNT_GLOBAL,
    });
    await flushPromises();

    await w.findAll('button').find((b) => b.text().includes('AI 摘要'))!.trigger('click');
    await flushPromises();

    const runBtn = w.findAll('button').find((b) => b.text().includes('產生 AI 摘要'))!;
    await runBtn.trigger('click');
    await flushPromises();

    const text = w.text();
    // 「AI 建議,需網通確認」只出現一次(開頭,結尾不重複)
    const count = text.split(PA_SIGNATURE_AI_DISCLAIMER).length - 1;
    expect(count).toBe(1);
    expect(text).toContain('新增高危 80 筆（送出 50 筆）');
    expect(text).toContain('優先檢查項目');
    expect(text.indexOf(PA_SIGNATURE_AI_DISCLAIMER)).toBeLessThan(text.indexOf('優先檢查項目'));

    w.unmount();
  });
});

describe('SignatureDrawer.vue — 202 按需查詢與查無提示(TS-2 審查結論)', () => {
  it('快照查無走 202 + lookup,輪詢中顯示按需進度,查無時顯示「本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)」', async () => {
    let resolveLookup!: (job: SignatureLookupJob) => void;
    const lookupPromise = new Promise<SignatureLookupJob>((r) => {
      resolveLookup = r;
    });
    const backend = {
      get: vi.fn(async () => ({ lookupId: 'lk-404', id: '999999', status: 'queued' as const })),
      lookup: vi.fn(() => lookupPromise),
    };
    const drawer = usePaSignatureDrawer({ backend, can: () => true, pollMs: 1 });
    const w = mount(SignatureDrawer, {
      props: { drawer },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });

    const p = drawer.show('Custom Virus(999999)');
    await flushPromises();
    expect(drawer.polling).toBe(true);
    expect(document.body.textContent).toContain('按需查詢');

    resolveLookup({
      lookupId: 'lk-404',
      threatId: '999999',
      status: 'not_found',
      createdAt: '2026-11-20T01:00:00Z',
      startedAt: '2026-11-20T01:00:00Z',
      finishedAt: '2026-11-20T01:00:01Z',
      cached: false,
      mgmtCpu: 18,
      result: null,
      hits30d: 1408,
      error: null,
      message: '本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)',
    });

    const res = await p;
    await flushPromises();
    expect(res).toBe('not-found');
    expect(drawer.open).toBe(true);
    expect(document.body.textContent).toContain('本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)');
    expect(document.body.textContent).toContain('1,408 筆');

    w.unmount();
  });

  it('200 快取查無(含舊 Unknown 快取轉 not_found)開啟抽屜並顯示說明與近 30 天命中數(CH 失敗顯示無法取得)', async () => {
    const backend = {
      get: vi.fn(async (id: string) => ({
        found: false as const,
        source: 'lookup' as const,
        checkedAt: '2026-11-20T01:00:00Z',
        hits30d: id === '109010004' ? 1408 : null,
        message: '本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)',
      })),
      lookup: vi.fn(),
    };
    const drawer = usePaSignatureDrawer({ backend, can: () => true });
    const w = mount(SignatureDrawer, {
      props: { drawer },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });

    expect(await drawer.show('Proxy:hola.org(109010004)')).toBe('not-found');
    await flushPromises();
    expect(drawer.open).toBe(true);
    expect(document.body.textContent).toContain('本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)');
    expect(document.body.textContent).toContain('1,408 筆');

    // ClickHouse 未連線(hits30d: null)顯示「無法取得（ClickHouse 未連線）」
    expect(await drawer.show('109010005')).toBe('not-found');
    await flushPromises();
    expect(document.body.textContent).toContain('無法取得（ClickHouse 未連線）');

    w.unmount();
  });

  it('快照查無走 202 + lookup,查到時顯示按需結果、近 30 天命中數且 firstVersion 為 null 顯示「未知」', async () => {
    const backend = {
      get: vi.fn(async () => ({ lookupId: 'lk-ok', id: '888888', status: 'queued' as const })),
      lookup: vi.fn(async (): Promise<SignatureLookupJob> => ({
        lookupId: 'lk-ok',
        threatId: '888888',
        status: 'done',
        createdAt: '2026-11-20T01:00:00Z',
        startedAt: '2026-11-20T01:00:00Z',
        finishedAt: '2026-11-20T01:00:01Z',
        cached: false,
        mgmtCpu: 20,
        result: {
          id: '888888',
          name: 'WildFire ZeroDay',
          subtype: 'virus',
          severity: 'critical',
          description: 'On-demand lookup description',
        },
        hits30d: 25,
        error: null,
        message: null,
      })),
    };
    const drawer = usePaSignatureDrawer({ backend, can: () => true, pollMs: 1 });
    const w = mount(SignatureDrawer, {
      props: { drawer },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });

    const res = await drawer.show('888888');
    await flushPromises();
    expect(res).toBe('ok');
    expect(document.body.textContent).toContain('WildFire ZeroDay');
    expect(document.body.textContent).toContain('On-demand lookup description');
    expect(document.body.textContent).toContain('25 筆');
    expect(document.body.textContent).toContain('未知');

    w.unmount();
  });
});

describe('戰情室新特徵提示與跨頁抽屜接線(TS-4)', () => {
  it('mergeNewSignatureHits 合併 WR-1 / WR-2 並以較大 count 去重、依嚴重度與命中數排序', () => {
    const wHit: NewSignatureHit = { id: '100', name: 'High A', severity: 'high', firstVersion: '9002-1', count: 5 };
    const rHitSame: NewSignatureHit = { id: '100', name: 'High A', severity: 'high', firstVersion: '9002-1', count: 12 };
    const rHitCrit: NewSignatureHit = { id: '200', name: 'Crit B', severity: 'critical', firstVersion: '9002-2', count: 3 };
    const merged = mergeNewSignatureHits(
      { newSignatureHits: [wHit] } as Warroom,
      { newSignatureHits: [rHitSame, rHitCrit] } as WarroomRisk,
    );
    expect(merged.map((x) => [x.id, x.count])).toEqual([
      ['200', 3],
      ['100', 12],
    ]);
  });

  it('NewSignatureHitsBar、EventFeed、RiskPanel、TrafficLogTable、RankingDrawer 皆可點選威脅名稱觸發 open-signature', async () => {
    const linkable = (s: string) => /\(\d+\)$|^\d+$/.test(s);

    // NewSignatureHitsBar
    const wBar = mount(NewSignatureHitsBar, {
      props: {
        hits: [{ id: '547000', name: 'Apache RCE', severity: 'critical', firstVersion: '9002-1234', count: 9 }],
        canOpenSignaturePage: true,
        sigLinkable: linkable,
      },
      global: MOUNT_GLOBAL,
    });
    expect(wBar.text()).toContain('#547000');
    expect(wBar.text()).toContain('前往威脅特徵碼');
    await wBar.find('button.wr-newsig__chip').trigger('click');
    expect(wBar.emitted('open-signature')).toEqual([['547000']]);
    wBar.unmount();

    // EventFeed
    const threatLog: LiveLog = {
      id: 't1',
      type: 'threat',
      receivedAt: '2026-11-20T01:00:00Z',
      src: '1.2.3.4',
      dst: '10.10.10.5',
      name: 'HTTP SQL Injection(30521)',
      severity: 'high',
    };
    const wFeed = mount(EventFeed, {
      props: { events: [{ log: threatLog, kind: 'threat' }], sigLinkable: linkable },
      global: MOUNT_GLOBAL,
    });
    await wFeed.find('button.wr-feed__sig-btn').trigger('click');
    expect(wFeed.emitted('open-signature')).toEqual([['HTTP SQL Injection(30521)']]);
    wFeed.unmount();

    // RiskPanel
    const wRisk = mount(RiskPanel, {
      props: {
        risk: {
          generatedAt: '2026-11-20T01:00:00Z',
          minutes: 60,
          partial: false,
          threats: 10,
          denies: 5,
          attackSources: 2,
          critical: 1,
          topThreats: [{ name: 'HTTP SQL Injection(30521)', severity: 'high', count: 10 }],
          topSources: [],
        },
        sigLinkable: linkable,
      },
      global: MOUNT_GLOBAL,
    });
    await wRisk.find('button.wr-risk__sig-btn').trigger('click');
    expect(wRisk.emitted('open-signature')).toEqual([['HTTP SQL Injection(30521)']]);
    wRisk.unmount();

    // TrafficLogTable
    const wTable = mount(TrafficLogTable, {
      props: {
        logs: [threatLog],
        filter: 'all',
        paused: false,
        focus: null,
        sigLinkable: linkable,
      },
      global: MOUNT_GLOBAL,
    });
    await wTable.find('button.wr-logbar__sig').trigger('click');
    expect(wTable.emitted('open-signature')).toEqual([['HTTP SQL Injection(30521)']]);
    wTable.unmount();

    // RankingDrawer
    const wRank = mount(RankingDrawer, {
      props: {
        modelValue: true,
        type: 'threat',
        minutes: 15,
        top: {
          type: 'threat',
          minutes: 15,
          totals: { count: 10 },
          kpis: {},
          tops: { name: [{ key: 'HTTP SQL Injection(30521)', value: 10 }] },
          perMinute: [],
          retentionSec: 86400,
        },
        lists: [{ dim: 'name', title: '名稱', byBytes: false, items: [{ key: 'HTTP SQL Injection(30521)', n: 10 }] }],
        kpis: [],
        error: null,
        loading: false,
        source: { live: true, empty: '', stale: '' },
        sigLinkable: linkable,
      },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });
    await flushPromises();
    const rankBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('HTTP SQL Injection(30521)'),
    )!;
    rankBtn.click();
    await flushPromises();
    expect(wRank.emitted('open-signature')).toEqual([['HTTP SQL Injection(30521)']]);
    wRank.unmount();
  });

  it('Live.vue 顯示 WR-1/WR-2 新特徵命中提示列，點擊開啟 SignatureDrawer', async () => {
    hoisted.wrGet.mockResolvedValue({
      generatedAt: '2026-11-20T01:00:00Z',
      minutes: 5,
      partial: false,
      segmentsSource: 'file',
      gauge: { throughputMaxBps: 1e9, sessionMax: 64000 },
      geo: { available: true, version: '2026-11', attribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } },
      sources: [],
      segments: [],
      links: [],
      kpis: { denyPerMin: 1, threat5m: 3 },
      newSignatureHits: [{ id: '547000', name: 'Apache HTTP Server RCE', severity: 'critical', firstVersion: '9002-1234', count: 3 }],
      sample: { traffic: 10, trafficSec: 300, threat: 3, threatSec: 300, complete: true },
    } satisfies Warroom);
    hoisted.wrRisk.mockResolvedValue({
      generatedAt: '2026-11-20T01:00:00Z',
      minutes: 60,
      partial: false,
      threats: 3,
      denies: 1,
      attackSources: 1,
      critical: 1,
      topThreats: [],
      topSources: [],
    } satisfies WarroomRisk);
    hoisted.wrInsight.mockResolvedValue({
      enabled: true,
      status: 'none',
      running: false,
      hour: null,
      until: null,
      text: null,
      model: null,
      trigger: null,
      partial: false,
      statsMinutes: null,
      at: null,
      error: null,
      cooldownUntil: null,
    } satisfies HourlyInsight);
    hoisted.liveSnapshot.mockResolvedValue({
      collector: {
        state: 'ok',
        message: '',
        updatedAt: '2026-11-20T01:00:00Z',
        version: '1.0',
        poll: { enabled: true, paused: false, lastOkAt: '2026-11-20T01:00:00Z', error: null, errorAt: null },
        receive: { enabled: true, paused: false, tls: false, httpLastAt: null, syslogLastAt: null },
        redis: { error: null, errorAt: null },
        counters: { received: 0, dropped: 0, rejected: 0, malformed: 0, redisFailed: 0, paused: 0 },
      },
      metrics: { session: null, cpu: null, throughput: null, interfaces: null },
    } satisfies PaLiveSnapshot);
    hoisted.liveLogs.mockResolvedValue({ type: 'traffic', items: [], nextBefore: null, scanned: 0, truncated: false, earliest: null, retentionSec: 3600 });

    const w = mount(Live, { global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();

    expect(w.text()).toContain('偵測到近 30 天新增威脅特徵碼命中');
    await w.find('button.wr-newsig__chip').trigger('click');
    await flushPromises();

    expect(hoisted.sigGet).toHaveBeenCalledWith('547000');
    expect(document.body.textContent).toContain('#547000 Apache HTTP Server RCE');
    w.unmount();
  });

  it('Events.vue(安全事件 › 威脅):點威脅名稱排行開啟 SignatureDrawer', async () => {
    hoisted.routeQuery = { type: 'threat' };
    hoisted.evTypes.mockResolvedValue({
      types: [
        {
          type: 'threat',
          label: '威脅',
          dir: '',
          source: 'clickhouse',
          rows: 100,
          days: ['2026-11-20'],
          coverage: { from: '2026-11-01', to: '2026-11-20', retentionDays: 30 },
        },
      ],
    });
    hoisted.evOverview.mockResolvedValue({
      type: 'threat',
      label: '威脅',
      source: 'clickhouse',
      from: '2026-11-20',
      to: '2026-11-20',
      rows: 100,
      files: 24,
      timeMin: '2026-11-20T00:00:00Z',
      timeMax: '2026-11-20T01:00:00Z',
      missing: 0,
      partial: false,
      import: { busy: false, failed: 0 },
      kpis: [],
      hours: [],
      tops: [
        {
          key: 'name',
          title: '威脅名稱排行',
          items: [{ key: 'Apache HTTP Server RCE(547000)', n: 42 }],
        },
      ],
    });

    const w = mount(Events, { global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();
    await w.findAll('button').find((b) => b.text().includes('重新整理'))?.trigger('click');
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();

    const threatBtn = w.findAll('button.item').find((b) => b.text().includes('Apache HTTP Server RCE(547000)'))!;
    expect(threatBtn).toBeTruthy();
    await threatBtn.trigger('click');
    await flushPromises();

    expect(hoisted.sigGet).toHaveBeenCalledWith('547000');
    expect(document.body.textContent).toContain('#547000 Apache HTTP Server RCE');
    w.unmount();
  });

  it('Search.vue(Log 明細查詢 › THREAT):點威脅名稱開啟 SignatureDrawer', async () => {
    hoisted.paDays.mockResolvedValue({ days: [{ day: '2026-11-20' }], coverage: { from: '2026-11-01', to: '2026-11-20', retentionDays: 30 } });
    hoisted.paOptions.mockResolvedValue({ apps: [], rules: [], zones: [], actions: [] });
    hoisted.paLogCreate.mockResolvedValue({
      id: 'job-1',
      status: 'done',
      result: {
        type: 'THREAT',
        from: '2026-11-20T00:00:00Z',
        to: '2026-11-20T01:00:00Z',
        total: 1,
        scanned: 10,
        seconds: 0.2,
        limit: 10000,
        files: 1,
        filesScanned: 1,
        partial: false,
      },
    });
    hoisted.paLogRows.mockResolvedValue({
      page: 1,
      total: 1,
      items: [
        {
          time: '2026-11-20T00:30:00Z',
          severity: 'critical',
          threat: 'Apache HTTP Server RCE(547000)',
          action: 'reset-both',
          src: '1.2.3.4',
          dst: '10.10.200.8',
          dport: 443,
          proto: 'tcp',
          app: 'ssl',
          srcCountry: 'US',
          bytes: 0,
        },
      ],
    });

    const w = mount(Search, { global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();
    await w.find('form').trigger('submit');
    await flushPromises();

    const sigBtn = w.find('button.sig-link');
    expect(sigBtn.exists()).toBe(true);
    await sigBtn.trigger('click');
    await flushPromises();

    expect(hoisted.sigGet).toHaveBeenCalledWith('547000');
    expect(document.body.textContent).toContain('#547000 Apache HTTP Server RCE');
    w.unmount();
  });

  it('SliceDrawer.vue(時段明細 › 威脅列):點威脅名稱開啟 SignatureDrawer', async () => {
    const fakeSlice = {
      query: ref({ type: 'threat', start: '2026-11-20T00:00:00Z', end: '2026-11-20T01:00:00Z' }),
      state: ref('ready'),
      source: ref('hot'),
      isCold: ref(false),
      retryAfter: ref(0),
      error: ref(null),
      searchLink: ref(null),
      supportsSeverity: ref(false),
      summary: ref({ bytes: null, sessions: 5, deny: 2, threats: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } }),
      result: ref({
        type: 'threat',
        seconds: 0.1,
        coverage: { partial: false, gapsKnown: true },
        summary: { bytes: null, sessions: 5, deny: 2, threats: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } },
        top: {},
        rowsTruncated: false,
        rowsLimit: 200,
        rows: [
          {
            time: '2026-11-20T00:10:00Z',
            severity: 'critical',
            name: 'Apache HTTP Server RCE(547000)',
            src: '1.2.3.4',
            dst: '10.10.200.8',
            action: 'reset-both',
          },
        ],
      }),
      openInSearch: vi.fn(),
      setSeverity: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      close: vi.fn(),
    };

    const w = mount(SliceDrawer, {
      props: { modelValue: true, slice: fakeSlice as never },
      global: MOUNT_GLOBAL,
      attachTo: document.body,
    });
    await flushPromises();

    const sigBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Apache HTTP Server RCE(547000)'),
    )!;
    expect(sigBtn).toBeTruthy();
    sigBtn.click();
    await flushPromises();

    expect(hoisted.sigGet).toHaveBeenCalledWith('547000');
    expect(document.body.textContent).toContain('#547000 Apache HTTP Server RCE');
    w.unmount();
  });

  it('Search.vue 明細彈窗含「特徵碼說明」按鈕;無 netops.pa-signature.read 權限時威脅名稱不可點', async () => {
    hoisted.paDays.mockResolvedValue({ days: [{ day: '2026-11-20' }], coverage: { from: '2026-11-01', to: '2026-11-20', retentionDays: 30 } });
    hoisted.paOptions.mockResolvedValue({ apps: [], rules: [], zones: [], actions: [] });
    hoisted.paLogCreate.mockResolvedValue({
      id: 'job-2',
      status: 'done',
      result: {
        type: 'THREAT',
        from: '2026-11-20T00:00:00Z',
        to: '2026-11-20T01:00:00Z',
        total: 1,
        scanned: 5,
        seconds: 0.1,
        limit: 10000,
        files: 1,
        filesScanned: 1,
        partial: false,
      },
    });
    hoisted.paLogRows.mockResolvedValue({
      page: 1,
      total: 1,
      items: [
        {
          time: '2026-11-20T00:30:00Z',
          severity: 'critical',
          threat: 'Apache HTTP Server RCE(547000)',
          action: 'reset-both',
          src: '1.2.3.4',
          dst: '10.10.200.8',
          dport: 443,
          proto: 'tcp',
          app: 'ssl',
          srcCountry: 'US',
          bytes: 0,
        },
      ],
    });

    // 有權限:點擊列開明細 → 點「特徵碼說明」關明細並開抽屜
    const wPerm = mount(Search, { global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();
    await wPerm.find('form').trigger('submit');
    await flushPromises();
    await wPerm.find('tbody tr').trigger('click');
    await flushPromises();
    const detailSigBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('特徵碼說明'),
    )!;
    expect(detailSigBtn).toBeTruthy();
    detailSigBtn.click();
    await flushPromises();
    expect(hoisted.sigGet).toHaveBeenCalledWith('547000');
    wPerm.unmount();

    // 無 netops.pa-signature.read 權限:表格內威脅名稱不渲染可點按鈕
    hoisted.perms.delete('netops.pa-signature.read');
    const wNoPerm = mount(Search, { global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();
    await wNoPerm.find('form').trigger('submit');
    await flushPromises();
    expect(wNoPerm.find('button.sig-link').exists()).toBe(false);
    expect(wNoPerm.text()).toContain('Apache HTTP Server RCE(547000)');
    wNoPerm.unmount();
  });
});
