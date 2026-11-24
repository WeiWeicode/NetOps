// @vitest-environment happy-dom
/**
 * AD-3 前端四個畫面 mount 測試:
 *   1. AD 事件總覽頂部「DC Agent 即時狀態列」(AgentBar + Events.vue):clickhouse / ftp、空資料、424、XSS 純文字插值、展開事件、輪詢停止
 *   2. AD 總覽 IP 名稱(GIpLabel)與 503 ClickHouse 不可用錯誤(不顯示成空總覽)
 *   3. AD 明細查詢(Search.vue):clickhouse DC 下拉 / ftp 自填、name 欄位 400 錯誤、503、422 匯出、GIpLabel、GSourceBadge
 *   4. AD › FTP Log 檔案「ClickHouse 對帳與補漏」卡片(ReconCard + Files.vue):展開 DC × 記錄、立即對帳、補漏輪詢、waitingAgent/ambiguous、409/424/503 不影響 FTP 清單、無權限隱藏操作
 * 所有 API 均以假資料 mock,不連任何服務。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ui from '@/ui';
import { IP_LABEL_KEY } from '@/ui/ipLabel';
import { absorbNames, clearIpNames, ipLabel } from '@/composables/ipNames';
import { ApiError } from '@/api/gateway';
import type { AdAgentsResponse, AdDays, AdOverview, AdReconDay, AdReconList, AgentStatus } from '@/api/ad';

const perms = vi.hoisted(() => ({ manage: true, search: true }));
const mockRouter = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const mockRoute = vi.hoisted(() => ({ query: {} as Record<string, string> }));
const toastSpy = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), fromError: vi.fn() }));

vi.mock('vue-router', () => ({
  useRouter: () => mockRouter,
  useRoute: () => mockRoute,
}));

const gatewaySpies = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@/api/gateway', async (orig) => {
  const real = await orig<typeof import('@/api/gateway')>();
  return {
    ...real,
    can: (code: string) => {
      if (code === 'netops.ad-files.manage') return perms.manage;
      if (code === 'netops.ad-search.read') return perms.search;
      return true;
    },
    download: gatewaySpies.download,
  };
});

vi.mock('@/ui', async (orig) => {
  const real = await orig<typeof import('@/ui')>();
  return { ...real, toast: toastSpy, confirm: vi.fn().mockResolvedValue(true) };
});

const apiMocks = vi.hoisted(() => ({
  days: vi.fn(),
  overview: vi.fn(),
  agents: vi.fn(),
  search: vi.fn(),
  reconList: vi.fn(),
  reconRun: vi.fn(),
  reconBackfill: vi.fn(),
  reconJob: vi.fn(),
  ftpStatus: vi.fn(),
  ftpSync: vi.fn(),
}));

vi.mock('@/api/ad', async (orig) => {
  const real = await orig<typeof import('@/api/ad')>();
  return {
    ...real,
    ad: { days: apiMocks.days, overview: apiMocks.overview, agents: apiMocks.agents },
    adLog: { ...real.adLog, search: apiMocks.search },
    adRecon: { list: apiMocks.reconList, run: apiMocks.reconRun, backfill: apiMocks.reconBackfill, job: apiMocks.reconJob },
  };
});

vi.mock('@/api/ftp', async (orig) => {
  const real = await orig<typeof import('@/api/ftp')>();
  return {
    ...real,
    adFtp: {
      ...real.adFtp,
      status: apiMocks.ftpStatus,
      sync: apiMocks.ftpSync,
    },
  };
});

const provide = { [IP_LABEL_KEY as symbol]: ipLabel };
const stubs = { Teleport: true };

const sampleAgent = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  computer: 'GSMC-DC1',
  dcDomain: 'gsmc.com.tw',
  state: 'ok',
  updatedAt: '2026-11-24T09:50:00+08:00',
  ageSec: 12,
  reportedAt: '2026-11-24T09:50:00+08:00',
  agentVersion: '0.1.0',
  watchdogVersion: '0.1.0',
  received: 1234,
  agent: {
    pid: 4000,
    serviceState: 'running',
    startType: 'auto',
    statusOk: true,
    lastCollectTickAt: '2026-11-24T09:50:00+08:00',
    lastSendOkAt: '2026-11-24T09:50:00+08:00',
    lastError: '',
    restarts24h: 0,
    cpuPct: 0.4,
    rssMb: 9.8,
    pendingEvents: 0,
    skippedEvents: 0,
    sendRejectStreak: 0,
  },
  channels: {
    Security: {
      lastRecordId: 50000,
      logEpoch: 0,
      fileSizeMb: 42.5,
      maxSizeMb: 128,
      oldestEventAt: '2026-11-23T09:50:00+08:00',
      coverageHours: 18.5,
      wrapRisk: true,
    },
  },
  events: [
    {
      type: 'agent_restarted',
      cause: 'hung',
      detail: '採集停滯 95 秒 <img src=x onerror=alert(1)>',
      at: '2026-11-24T08:00:00+08:00',
      receivedAt: '2026-11-24T08:00:05+08:00',
    },
  ],
  ...over,
});

const sampleDays = (source: 'clickhouse' | 'ftp'): AdDays => ({
  source,
  agents: source === 'clickhouse' ? { total: 2, ok: 1, stale: 0, offline: 1, unknown: 0, wrapRisk: 1 } : undefined,
  days: [
    source === 'clickhouse'
      ? { day: '2026-11-24', events: 20, agent: 18, ftp: 2, computers: ['GSMC-DC1', 'GSMC-DC2'] }
      : { day: '2026-11-23', events: 20, importedAt: '2026-11-24T08:10:00+08:00', files: [{ name: 'Security.csv', channel: 'Security', rows: 20 }] },
  ],
  import: { running: false, lastSyncAt: '2026-11-24T08:10:00+08:00', lastSyncError: '' },
  channels: { Security: '安全性', System: '系統', Directory_Service: '目錄服務', DNS_Server: 'DNS 伺服器' },
  securityEvents: { '4625': '登入失敗', '4740': '帳戶被鎖定' },
  channelEvents: {
    Security: { '4625': '登入失敗', '4740': '帳戶被鎖定' },
    System: { '7045': '系統安裝新服務', '104': '系統事件記錄被清除' },
    Directory_Service: { '2889': '用戶端執行未簽署的 LDAP 繫結' },
    DNS_Server: { '4015': 'DNS 伺服器發生嚴重的 Active Directory 錯誤' },
  },
});

const sampleOverview = (source: 'clickhouse' | 'ftp'): AdOverview => ({
  from: source === 'clickhouse' ? '2026-11-24' : '2026-11-23',
  to: source === 'clickhouse' ? '2026-11-24' : '2026-11-23',
  source,
  days: 1,
  total: 20,
  byChannel: { Security: 20 },
  byLevel: { audit_failure: 5 },
  timeMin: '2026-11-24T08:00:00+08:00',
  timeMax: '2026-11-24T09:50:00+08:00',
  hours: [{ hour: '2026-11-24T08:00:00+08:00', n: 20, issue: 5 }],
  events: [{ channel: 'Security', eventId: 4625, level: 'audit_failure', provider: 'Sec', n: 5, first: '2026-11-24T08:00:00+08:00', last: '2026-11-24T09:50:00+08:00', sample: '登入失敗', computers: ['GSMC-DC1'] }],
  issues: [{ channel: 'Security', eventId: 4625, level: 'audit_failure', provider: 'Sec', n: 5, first: '2026-11-24T08:00:00+08:00', last: '2026-11-24T09:50:00+08:00', sample: '登入失敗', computers: ['GSMC-DC1'] }],
  failAccounts: [{ key: 'alice', n: 5 }],
  failIps: [{ key: '10.10.1.50', n: 5 }],
  failReasons: [{ key: '密碼錯誤(0xc000006a)', n: 5, ips: [{ key: '10.10.1.50', n: 5 }], accounts: [{ key: 'alice', n: 5 }] }],
  accountChanges: [],
  privilegedChanges: 0,
  accountsCreated: 0,
  privLogons: [],
  names: { '10.10.1.50': { name: '王小明', department: '資訊處', device: 'PC-50', deviceType: '桌機' } },
});

function setHidden(v: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearIpNames();
  perms.manage = true;
  perms.search = true;
  mockRoute.query = {};
  setHidden(false);
});

afterEach(() => {
  setHidden(false);
  clearIpNames();
  vi.useRealTimers();
});

describe('畫面 1 & 2:AD 事件總覽(DC Agent 狀態列 + GIpLabel)', () => {
  it('clickhouse 模式:顯示 DC 狀態列(ok/offline/wrapRisk/展開事件、不以 v-html 渲染)與總覽 IP 名稱', async () => {
    const ov = sampleOverview('clickhouse');
    apiMocks.days.mockResolvedValue(sampleDays('clickhouse'));
    apiMocks.overview.mockImplementation(async () => {
      absorbNames(ov);
      return ov;
    });
    const agentsResp: AdAgentsResponse = {
      items: [
        sampleAgent({ agent: { ...sampleAgent().agent, lastError: '<script>xss()</script>' } }),
        sampleAgent({ computer: 'GSMC-DC2', state: 'offline', updatedAt: '2026-11-24T09:00:00+08:00', channels: {}, events: [] }),
      ],
      summary: { total: 2, ok: 1, stale: 0, offline: 1, unknown: 0, wrapRisk: 1 },
      staleSec: 90,
      offlineSec: 180,
      source: 'clickhouse',
    };
    apiMocks.agents.mockResolvedValue(agentsResp);

    const { default: Events } = await import('@/pages/ad/Events.vue');
    const w = mount(Events, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    expect(w.text()).toContain('DC Agent 即時狀態');
    expect(w.text()).toContain('GSMC-DC1');
    expect(w.text()).toContain('Security 覆寫風險');
    expect(w.text()).toContain('18.5 小時');
    expect(w.text()).toContain('離線(最後連線於');
    // 不可 v-html:惡意字串應為純文字,DOM 不出現 script / img
    expect(w.text()).toContain('<script>xss()</script>');
    expect(w.find('script').exists()).toBe(false);

    // 展開事件
    const btn = w.findAll('button').find((b) => b.text().includes('事件(1)'));
    await btn!.trigger('click');
    expect(w.text()).toContain('Agent 重啟');
    expect(w.text()).toContain('<img src=x onerror=alert(1)>');
    expect(w.find('img').exists()).toBe(false);

    // 總覽 IP 名稱(GIpLabel)
    expect(w.text()).toContain('10.10.1.50');
    expect(w.text()).toContain('王小明');

    // 隱藏與卸載都停止輪詢
    const beforeCalls = apiMocks.agents.mock.calls.length;
    setHidden(true);
    await vi.advanceTimersByTimeAsync(90_000);
    await flushPromises();
    expect(apiMocks.agents.mock.calls.length).toBe(beforeCalls);
    w.unmount();
  });

  it('ftp 模式:不顯示 DC Agent 狀態列、不呼叫 /ad/agents', async () => {
    apiMocks.days.mockResolvedValue(sampleDays('ftp'));
    apiMocks.overview.mockResolvedValue(sampleOverview('ftp'));
    const { default: Events } = await import('@/pages/ad/Events.vue');
    const w = mount(Events, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    expect(w.text()).not.toContain('DC Agent 即時狀態');
    expect(apiMocks.agents).not.toHaveBeenCalled();
    w.unmount();
  });

  it('Agent 空資料顯示 GEmpty;424 Redis 錯誤不擋總覽;503 ClickHouse 顯示錯誤而非空總覽', async () => {
    apiMocks.days.mockResolvedValue(sampleDays('clickhouse'));
    apiMocks.overview.mockResolvedValue(sampleOverview('clickhouse'));
    apiMocks.agents.mockResolvedValue({ items: [], summary: { total: 0, ok: 0, stale: 0, offline: 0, unknown: 0, wrapRisk: 0 }, staleSec: 90, offlineSec: 180, source: 'clickhouse' });
    const { default: Events } = await import('@/pages/ad/Events.vue');
    const w1 = mount(Events, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(w1.text()).toContain('尚未有 DC Agent 回報');
    w1.unmount();

    // 424 Redis 錯誤:狀態列提示,總覽仍正常
    apiMocks.agents.mockRejectedValue(new ApiError(424, 'NETOPS_REDIS_UNAVAILABLE', 'netops-redis 暫時無法使用', 'req-redis-424'));
    const w2 = mount(Events, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(w2.text()).toContain('DC 狀態暫時無法取得');
    expect(w2.text()).toContain('req-redis-42');
    expect(w2.text()).toContain('事件總數');
    w2.unmount();

    // 503 ClickHouse 錯誤:只顯示單一錯誤卡片(不與 GAlert 重複)與 requestId,不顯示成空總覽(審查 Low 2)
    apiMocks.overview.mockRejectedValue(new ApiError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'AD 事件資料庫暫時無法使用', 'req-ch-503'));
    const w3 = mount(Events, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(w3.text()).toContain('AD 事件資料庫暫時無法使用');
    expect(w3.text().match(/req-ch-503/g)?.length).toBe(1);
    expect(w3.text()).not.toContain('這段期間沒有事件');
    w3.unmount();
  });
});

describe('畫面 3:AD 明細查詢(Search.vue)', () => {
  it('clickhouse 模式:DC 下拉、name 欄位 400 錯誤、503 錯誤、表格 GIpLabel 與 GSourceBadge、匯出 422', async () => {
    apiMocks.days.mockResolvedValue(sampleDays('clickhouse'));
    apiMocks.agents.mockResolvedValue({ items: [sampleAgent()], summary: { total: 1, ok: 1, stale: 0, offline: 0, unknown: 0, wrapRisk: 0 }, staleSec: 90, offlineSec: 180, source: 'clickhouse' });
    const searchResp = {
      items: [
        {
          time: '2026-11-24T08:05:00+08:00',
          eventId: 4625,
          level: 'audit_failure' as const,
          levelText: 'Audit Failure',
          provider: 'Sec',
          computer: 'GSMC-DC1',
          recordId: '101',
          channel: 'Security',
          message: '登入失敗',
          account: 'alice',
          domain: 'GSMC',
          ip: '10.10.1.50',
          workstation: 'PC-50',
          reason: '密碼錯誤',
          actor: '',
          target: '',
          group: '',
          privileged: false,
          dcDomain: 'gsmc.com.tw',
          source: 'agent' as const,
          logEpoch: 0,
        },
        {
          time: '2026-11-24T08:01:00+08:00',
          eventId: 4625,
          level: 'audit_failure' as const,
          levelText: '稽核失敗',
          provider: 'Sec',
          computer: 'GSMC-DC2',
          recordId: '102',
          channel: 'Security',
          message: '補寫事件',
          account: 'bob',
          domain: 'GSMC',
          ip: '10.10.1.51',
          workstation: '',
          reason: '',
          actor: '',
          target: '',
          group: '',
          privileged: false,
          dcDomain: 'gsmc.com.tw',
          source: 'ftp' as const,
          logEpoch: 0,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      scanned: 20,
      source: 'clickhouse' as const,
      names: { '10.10.1.50': { name: '王小明', department: '資訊處', device: 'PC-50', deviceType: '桌機' } },
    };
    apiMocks.search.mockImplementation(async () => {
      absorbNames(searchResp);
      return searchResp;
    });

    const { default: Search } = await import('@/pages/ad/Search.vue');
    const w = mount(Search, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();

    // clickhouse 下拉含 GSMC-DC1、GSMC-DC2
    expect(w.find('select').exists()).toBe(true);
    expect(w.text()).toContain('GSMC-DC1');

    // 送出查詢
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('王小明');
    expect(w.text()).toContain('⚡ 即時');
    expect(w.text()).toContain('FTP 補寫');

    // 匯出 422 錯誤(斷言錯誤碼 NETOPS_EXPORT_TOO_LARGE 與顯示文字;審查 M2)
    toastSpy.fromError.mockClear();
    gatewaySpies.download.mockRejectedValueOnce(new ApiError(422, 'NETOPS_EXPORT_TOO_LARGE', '超過匯出上限 20,000 筆', 'req-exp-422'));
    const expBtn = w.findAll('button').find((b) => b.text().includes('匯出 CSV'));
    await expBtn!.trigger('click');
    await flushPromises();
    expect(toastSpy.fromError).toHaveBeenCalledTimes(1);
    const [expErr, expTitle] = toastSpy.fromError.mock.calls[0]!;
    expect(expErr).toBeInstanceOf(ApiError);
    expect(expErr.status).toBe(422);
    expect(expErr.code).toBe('NETOPS_EXPORT_TOO_LARGE');
    expect(expErr.message).toContain('超過匯出上限');
    expect(expErr.requestId).toBe('req-exp-422');
    expect(expTitle).toBe('匯出失敗');

    // 400 name 欄位錯誤顯示在輸入框下
    apiMocks.search.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_FAILED', '驗證失敗', 'req-name-400', [{ field: 'name', message: 'IP 對照表沒有符合的使用者姓名' }]));
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('IP 對照表沒有符合的使用者姓名');

    // 503 ClickHouse 不可用
    apiMocks.search.mockRejectedValueOnce(new ApiError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', '資料庫暫時無法使用', 'req-ch-503'));
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('AD 事件資料庫暫時無法使用');
    expect(w.text()).toContain('req-ch-503');
    w.unmount();
  });

  it('ftp 模式:DC 欄位提供自由文字輸入;clickhouse 模式網址帶入未知 DC 仍納入下拉選項(審查 Low 4)', async () => {
    apiMocks.days.mockResolvedValue(sampleDays('ftp'));
    const { default: Search } = await import('@/pages/ad/Search.vue');
    const w = mount(Search, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    expect(w.find('input[placeholder="GSMC-DC1"]').exists()).toBe(true);
    w.unmount();

    mockRoute.query = { computer: 'URL-DC9' };
    apiMocks.days.mockResolvedValue(sampleDays('clickhouse'));
    apiMocks.agents.mockResolvedValue({ items: [sampleAgent()], summary: { total: 1, ok: 1, stale: 0, offline: 0, unknown: 0, wrapRisk: 0 }, staleSec: 90, offlineSec: 180, source: 'clickhouse' });
    const w2 = mount(Search, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    expect(w2.text()).toContain('URL-DC9');
    w2.unmount();
  });

  it('AD-6 channelEvents:明細查詢顯示 System / Directory_Service / DNS_Server 事件中文名稱(審查 M1)', async () => {
    apiMocks.days.mockResolvedValue(sampleDays('clickhouse'));
    apiMocks.agents.mockResolvedValue({ items: [sampleAgent()], summary: { total: 1, ok: 1, stale: 0, offline: 0, unknown: 0, wrapRisk: 0 }, staleSec: 90, offlineSec: 180, source: 'clickhouse' });
    const row = (channel: string, eventId: number, recordId: string) => ({
      time: '2026-11-24T09:00:00+08:00',
      eventId,
      level: 'warning' as const,
      levelText: 'Warning',
      provider: 'p',
      computer: 'GSMC-DC1',
      recordId,
      channel,
      message: `msg-${eventId}`,
      account: '',
      domain: '',
      ip: '',
      workstation: '',
      reason: '',
      actor: '',
      target: '',
      group: '',
      privileged: false,
      dcDomain: 'gsmc.com.tw',
      source: 'agent' as const,
      logEpoch: 0,
    });
    apiMocks.search.mockResolvedValueOnce({
      items: [row('System', 7045, '1'), row('Directory_Service', 2889, '2'), row('DNS_Server', 4015, '3'), row('Security', 4625, '4')],
      total: 4,
      page: 1,
      pageSize: 50,
      scanned: 4,
      source: 'clickhouse',
    });

    const { default: Search } = await import('@/pages/ad/Search.vue');
    const w = mount(Search, { global: { plugins: [ui], provide, stubs } });
    await flushPromises();
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(w.text()).toContain('系統安裝新服務');
    expect(w.text()).toContain('用戶端執行未簽署的 LDAP 繫結');
    expect(w.text()).toContain('DNS 伺服器發生嚴重的 Active Directory 錯誤');
    expect(w.text()).toContain('登入失敗');
    w.unmount();
  });
});

describe('畫面 4:AD › FTP Log 檔案「ClickHouse 對帳與補漏」卡片(ReconCard + Files.vue)', () => {
  const sampleDay: AdReconDay = {
    day: '2026-11-23',
    checkedAt: '2026-11-24T08:15:00+08:00',
    status: 'gap',
    ftpFiles: 4,
    gaps: 1,
    excess: 0,
    items: [
      { computer: 'GSMC-DC1', channel: 'Security', ftp: 100, ch: 95, chAgent: 90, chFtp: 5, diff: 5, status: 'gap' },
      { computer: 'GSMC-DC1', channel: 'System', ftp: 30, ch: 30, chAgent: 30, chFtp: 0, diff: 0, status: 'ok' },
    ],
    backfills: [],
  };

  it('展開 DC × 記錄、送出補漏並輪詢至 done(顯示 waitingAgent 與 ambiguous 說明)', async () => {
    const reconList: AdReconList = { items: [sampleDay], window: { from: '2026-11-22', to: '2026-11-23' } };
    apiMocks.reconList.mockResolvedValue(reconList);
    apiMocks.reconBackfill.mockResolvedValue({
      id: 'job-1',
      day: '2026-11-23',
      files: ['Security_GSMC-DC1.csv'],
      scope: [{ computer: 'GSMC-DC1', channel: 'Security' }],
      state: 'running',
      createdBy: 'admin',
      createdAt: '2026-11-24T09:00:00+08:00',
      startedAt: '2026-11-24T09:00:01+08:00',
      finishedAt: null,
      read: 100,
      skipped: 95,
      inserted: 0,
      waitingAgent: 0,
      ambiguous: 0,
      invalid: 0,
      error: null,
    });
    apiMocks.reconJob.mockResolvedValue({
      id: 'job-1',
      day: '2026-11-23',
      files: ['Security_GSMC-DC1.csv'],
      scope: [{ computer: 'GSMC-DC1', channel: 'Security' }],
      state: 'done',
      createdBy: 'admin',
      createdAt: '2026-11-24T09:00:00+08:00',
      startedAt: '2026-11-24T09:00:01+08:00',
      finishedAt: '2026-11-24T09:00:05+08:00',
      read: 100,
      skipped: 95,
      inserted: 2,
      waitingAgent: 2,
      ambiguous: 1,
      invalid: 0,
      error: null,
    });
    apiMocks.reconRun.mockResolvedValue({ ...sampleDay, status: 'ok', gaps: 0 });

    const { default: ReconCard } = await import('@/pages/ad/ReconCard.vue');
    const w = mount(ReconCard, { global: { plugins: [ui], stubs } });
    await flushPromises();

    expect(w.text()).toContain('2026-11-23');
    expect(w.text()).toContain('有缺口');
    // 展開 DC × 記錄
    await w.find('button[aria-label="展開 2026-11-23 對帳明細"]').trigger('click');
    expect(w.text()).toContain('GSMC-DC1');
    expect(w.text()).toContain('95 (90 / 5)');

    // 點補漏 → 2 秒後輪詢完成
    const bfBtn = w.findAll('.day-actions button').find((b) => b.text().includes('補漏'));
    await bfBtn!.trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    expect(w.text()).toContain('Agent 之後會送,隔天對帳再看');
    expect(w.text()).toContain('判斷不出 Event Log 世代,未寫入,需人工確認');
    expect(apiMocks.reconRun).toHaveBeenCalledWith('2026-11-23');
    w.unmount();
  });

  it('進頁面時已有 done 工作不呼叫 POST /ad/reconciliations;自動重新對帳失敗顯示於該日(審查 M1)', async () => {
    const doneJob = {
      id: 'job-existing',
      day: '2026-11-23',
      files: ['Security_GSMC-DC1.csv'],
      scope: [{ computer: 'GSMC-DC1', channel: 'Security' }],
      state: 'done' as const,
      createdBy: 'admin',
      createdAt: '2026-11-24T08:00:00+08:00',
      startedAt: '2026-11-24T08:00:01+08:00',
      finishedAt: '2026-11-24T08:00:05+08:00',
      read: 50,
      skipped: 48,
      inserted: 2,
      waitingAgent: 0,
      ambiguous: 0,
      invalid: 0,
      error: null,
    };
    apiMocks.reconList.mockResolvedValue({ items: [{ ...sampleDay, backfills: ['job-existing'] }], window: { from: '2026-11-22', to: '2026-11-23' } });
    apiMocks.reconJob.mockResolvedValueOnce(doneJob);

    const { default: ReconCard } = await import('@/pages/ad/ReconCard.vue');
    const w = mount(ReconCard, { global: { plugins: [ui], stubs } });
    await flushPromises();
    expect(w.text()).toContain('補寫 2');
    expect(apiMocks.reconRun).not.toHaveBeenCalled();

    // 若本頁送出新補漏完成後自動重新對帳失敗,錯誤與 requestId 必須顯示在該日
    apiMocks.reconBackfill.mockResolvedValueOnce({ ...doneJob, id: 'job-new', state: 'running', finishedAt: null });
    apiMocks.reconJob.mockResolvedValueOnce({ ...doneJob, id: 'job-new', state: 'done' });
    apiMocks.reconRun.mockRejectedValueOnce(new ApiError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'ClickHouse 暫時無法使用', 'req-auto-503'));
    const bfBtn = w.findAll('.day-actions button').find((b) => b.text().includes('補漏'));
    await bfBtn!.trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(w.text()).toContain('重新對帳失敗');
    expect(w.text()).toContain('req-auto-503');
    w.unmount();
  });

  it('409 三種補漏錯誤碼回報對應標題與錯誤內容;window null 顯示空狀態;無管理權限隱藏按鈕(審查 M2)', async () => {
    apiMocks.reconList.mockResolvedValue({ items: [sampleDay], window: { from: '2026-11-22', to: '2026-11-23' } });
    const { default: ReconCard } = await import('@/pages/ad/ReconCard.vue');
    const w = mount(ReconCard, { global: { plugins: [ui], stubs } });
    await flushPromises();

    const cases: [string, string, string, string][] = [
      ['NETOPS_RECON_PENDING', '這一天 FTP 檔案尚未匯入', 'req-409-pend', 'FTP 檔案尚未匯入'],
      ['NETOPS_BACKFILL_NOTHING', '目前沒有缺口需要補漏', 'req-409-none', '沒有需要補漏的項目'],
      ['NETOPS_BACKFILL_BUSY', '補漏佇列已達上限,請稍後再試', 'req-409-busy', '補漏佇列已滿'],
    ];
    for (const [code, msg, reqId, expectedTitle] of cases) {
      toastSpy.fromError.mockClear();
      apiMocks.reconBackfill.mockRejectedValueOnce(new ApiError(409, code, msg, reqId));
      const bfBtn = w.findAll('.day-actions button').find((b) => b.text().includes('補漏'));
      await bfBtn!.trigger('click');
      await flushPromises();
      expect(toastSpy.fromError).toHaveBeenCalledTimes(1);
      const [err, title] = toastSpy.fromError.mock.calls[0]!;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(code);
      expect(err.message).toBe(msg);
      expect(err.requestId).toBe(reqId);
      expect(title).toBe(expectedTitle);
    }
    w.unmount();

    // window null
    apiMocks.reconList.mockResolvedValueOnce({ items: [], window: null });
    const wEmpty = mount(ReconCard, { global: { plugins: [ui], stubs } });
    await flushPromises();
    expect(wEmpty.text()).toContain('沒有可對帳的日子');
    wEmpty.unmount();

    // 無權限不顯示操作按鈕
    perms.manage = false;
    apiMocks.reconList.mockResolvedValueOnce({ items: [sampleDay], window: { from: '2026-11-22', to: '2026-11-23' } });
    const wRead = mount(ReconCard, { global: { plugins: [ui], stubs } });
    await flushPromises();
    expect(wRead.text()).not.toContain('立即對帳');
    expect(wRead.find('.day-actions').exists()).toBe(false);
    wRead.unmount();
  });

  it('Files.vue:ClickHouse 503 時卡片顯示提示,不影響原本 FTP 檔案清單', async () => {
    apiMocks.ftpStatus.mockResolvedValue({ dir: '/AD_Log_Backup', running: false, lastSyncAt: '2026-11-24T08:10:00+08:00', lastSyncError: '' });
    apiMocks.reconList.mockRejectedValue(new ApiError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'ClickHouse 未啟用', 'req-503'));
    const { default: Files } = await import('@/pages/ad/Files.vue');
    const w = mount(Files, { global: { plugins: [ui], stubs } });
    await flushPromises();

    expect(w.text()).toContain('ClickHouse 尚未啟用或暫時無法使用');
    expect(w.text()).toContain('req-503');
    // 原本的 FTP 資料夾卡片仍在
    expect(w.text()).toContain('FTP /AD_Log_Backup');
    expect(w.text()).toContain('尚未列出 FTP 資料夾');
    w.unmount();
  });
});
