// @vitest-environment happy-dom
/**
 * 跨頁安全規則抽屜接線(usePolicyRuleDrawer + PolicyRuleDrawer;需求方 2026-11-23):
 *   - Log 明細查詢(Search.vue):規則欄、明細對話框「規則內容」;沒有 netops.pa-policy.read 時規則名稱只顯示文字
 *   - 規則找不到(NETOPS_PA_POLICY_NOT_FOUND)/ 沒有快照(NETOPS_PA_POLICY_UNAVAILABLE)時不開抽屜,以提示說明原因
 *   - 戰情室 TrafficLogTable、RankingDrawer:規則名稱可點時送出 open-rule;不可點時只顯示文字
 */
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/gateway';
import type { LiveLog } from '@/api/paLive';
import { PA_POLICY_ERRORS, type PolicyDetail, type PolicyRule } from '@/api/paPolicy';
import RankingDrawer from '@/components/warroom/RankingDrawer.vue';
import TrafficLogTable from '@/components/warroom/TrafficLogTable.vue';
import Search from '@/pages/firewall/Search.vue';
import ui, { toast } from '@/ui';

const hoisted = vi.hoisted(() => ({
  perms: new Set<string>(['netops.pa-policy.read']),
  paDays: vi.fn(),
  paOptions: vi.fn(),
  paLogCreate: vi.fn(),
  paLogGet: vi.fn(),
  paLogRows: vi.fn(),
  paLogCancel: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/firewall/search', query: {} }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/api/gateway', async (orig) => ({
  ...(await orig<typeof import('@/api/gateway')>()),
  can: (code: string) => hoisted.perms.has(code),
}));

vi.mock('@/api/pa', async (orig) => {
  const real = await orig<typeof import('@/api/pa')>();
  return {
    ...real,
    pa: { ...real.pa, days: hoisted.paDays, options: hoisted.paOptions },
    paLog: { ...real.paLog, create: hoisted.paLogCreate, get: hoisted.paLogGet, rows: hoisted.paLogRows, cancel: hoisted.paLogCancel },
  };
});

const MOUNT_GLOBAL = { plugins: [ui] };

function policyDetail(name: string): PolicyDetail {
  return {
    available: true,
    fetchedAt: '2026-11-23T00:30:00Z',
    hash: 'f'.repeat(64),
    versionId: 'v1',
    stale: false,
    hitsFetchedAt: '2026-11-23T00:30:00Z',
    ruleCount: 10,
    status: { collectorEnabled: true, state: 'ok', message: null, lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: null, durationMs: null, refreshCooldownSec: 0 },
    rule: {
      position: 3,
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
      applications: ['ssl'],
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
      description: 'LAN 上網',
      hits: { hitCount: 10, lastHit: null, firstHit: null, lastReset: null, created: null, modified: null },
      expanded: { sources: [], destinations: [], services: [], applications: [] },
    } as unknown as PolicyRule,
  };
}

/** 規則單條 API 假後端 + 權限(注入 Search.vue 的 ruleDrawerOptions) */
function ruleOptions(get: (name: string) => Promise<PolicyDetail>, allowed = true) {
  return { backend: { get } as never, can: (c: string) => allowed && c === 'netops.pa-policy.read' };
}

/** Log 明細查詢:送出查詢後回一列 TRAFFIC */
async function mountSearch(ruleDrawerOptions: ReturnType<typeof ruleOptions>, rule = 'allow-lan') {
  hoisted.paDays.mockResolvedValue({ days: [{ day: '2026-11-23' }], coverage: { from: '2026-11-01', to: '2026-11-23', retentionDays: 30 } });
  hoisted.paOptions.mockResolvedValue({ apps: [], rules: [], zones: [], actions: [] });
  hoisted.paLogCreate.mockResolvedValue({
    id: 'job-1',
    status: 'done',
    result: { type: 'TRAFFIC', from: '2026-11-23T00:00:00Z', to: '2026-11-23T01:00:00Z', total: 1, scanned: 10, seconds: 0.2, limit: 10000, files: 1, filesScanned: 1, partial: false },
  });
  hoisted.paLogRows.mockResolvedValue({
    page: 1,
    total: 1,
    items: [{ time: '2026-11-23T00:30:00Z', action: 'allow', src: '10.10.10.5', dst: '8.8.8.8', dport: 443, proto: 'tcp', app: 'ssl', rule, fromZone: 'trust', toZone: 'untrust', bytes: 100 }],
  });
  const w = mount(Search, { props: { ruleDrawerOptions }, global: MOUNT_GLOBAL, attachTo: document.body });
  await flushPromises();
  await w.find('form').trigger('submit');
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.perms = new Set(['netops.pa-policy.read']);
  document.body.innerHTML = '';
});

describe('Search.vue(Log 明細查詢)點規則名稱開安全規則抽屜', () => {
  it('規則欄可點,開出規則內容抽屜', async () => {
    const get = vi.fn(async (n: string) => policyDetail(n));
    const w = await mountSearch(ruleOptions(get));

    const btn = w.find('button.sig-link');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe('allow-lan');
    await btn.trigger('click');
    await flushPromises();

    expect(get).toHaveBeenCalledWith('allow-lan');
    expect(document.body.textContent).toContain('#3 allow-lan');
    w.unmount();
  });

  it('明細對話框「規則內容」關掉明細並開規則抽屜', async () => {
    const get = vi.fn(async (n: string) => policyDetail(n));
    const w = await mountSearch(ruleOptions(get));

    await w.find('tbody tr').trigger('click');
    await flushPromises();
    const ruleBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('規則內容'));
    expect(ruleBtn).toBeTruthy();
    ruleBtn!.click();
    await flushPromises();

    expect(get).toHaveBeenCalledWith('allow-lan');
    expect(document.body.textContent).not.toContain('連線明細');
    expect(document.body.textContent).toContain('#3 allow-lan');
    w.unmount();
  });

  it('沒有 netops.pa-policy.read:規則名稱只顯示文字,明細也沒有「規則內容」', async () => {
    const get = vi.fn(async (n: string) => policyDetail(n));
    const w = await mountSearch(ruleOptions(get, false));

    expect(w.find('button.sig-link').exists()).toBe(false);
    expect(w.text()).toContain('allow-lan');
    await w.find('tbody tr').trigger('click');
    await flushPromises();
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent?.includes('規則內容'))).toBe(false);
    expect(get).not.toHaveBeenCalled();
    w.unmount();
  });

  it('預設規則(interzone-default)沒有規則內容,只顯示文字', async () => {
    const get = vi.fn(async (n: string) => policyDetail(n));
    const w = await mountSearch(ruleOptions(get), 'interzone-default');
    expect(w.find('button.sig-link').exists()).toBe(false);
    expect(w.text()).toContain('interzone-default');
    w.unmount();
  });

  it('規則找不到(NETOPS_PA_POLICY_NOT_FOUND):不開抽屜,提示明確原因', async () => {
    const info = vi.spyOn(toast, 'info');
    const get = vi.fn(async (): Promise<PolicyDetail> => {
      throw new ApiError(404, PA_POLICY_ERRORS.notFound, '找不到規則', 'req-1');
    });
    const w = await mountSearch(ruleOptions(get));

    await w.find('button.sig-link').trigger('click');
    await flushPromises();

    expect(info).toHaveBeenCalledWith(expect.stringContaining('找不到規則「allow-lan」'));
    expect(document.body.textContent).not.toContain('#3 allow-lan');

    // 從明細對話框點「規則內容」失敗時,明細保留
    info.mockClear();
    await w.find('tbody tr').trigger('click');
    await flushPromises();
    Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('規則內容'))!.click();
    await flushPromises();
    expect(info).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('連線明細');
    w.unmount();
  });

  it('沒有規則快照(NETOPS_PA_POLICY_UNAVAILABLE):不開抽屜,提示後端訊息', async () => {
    const info = vi.spyOn(toast, 'info');
    const get = vi.fn(async (): Promise<PolicyDetail> => {
      throw new ApiError(404, PA_POLICY_ERRORS.unavailable, '目前沒有安全規則快照(收集器尚未取得)', 'req-2');
    });
    const w = await mountSearch(ruleOptions(get));

    await w.find('button.sig-link').trigger('click');
    await flushPromises();

    expect(info).toHaveBeenCalledWith('目前沒有安全規則快照(收集器尚未取得)');
    w.unmount();
  });
});

describe('戰情室 TrafficLogTable、RankingDrawer 規則名稱', () => {
  const log: LiveLog = {
    id: 'l-1',
    type: 'traffic',
    receivedAt: '2026-11-23T01:00:00Z',
    action: 'allow',
    src: '10.10.10.5',
    dst: '8.8.8.8',
    dport: 443,
    app: 'ssl',
    rule: 'allow-lan',
  };

  it('TrafficLogTable:ruleLinkable 為 true 時規則名稱可點,送出 open-rule', async () => {
    const w = mount(TrafficLogTable, {
      props: { logs: [log], filter: 'all', paused: false, focus: null, ruleLinkable: (n: string) => n === 'allow-lan' },
      global: MOUNT_GLOBAL,
    });
    const btn = w.find('button.wr-logbar__rule');
    expect(btn.text()).toBe('allow-lan');
    await btn.trigger('click');
    expect(w.emitted('open-rule')).toEqual([['allow-lan']]);
    w.unmount();
  });

  it('TrafficLogTable:沒有 ruleLinkable(無權限)時規則名稱只顯示文字', () => {
    const w = mount(TrafficLogTable, {
      props: { logs: [log], filter: 'all', paused: false, focus: null },
      global: MOUNT_GLOBAL,
    });
    expect(w.find('button.wr-logbar__rule').exists()).toBe(false);
    expect(w.find('#lb').text()).toContain('allow-lan');
    w.unmount();
  });

  const rankProps = (ruleLinkable?: (n: string) => boolean) => ({
    modelValue: true,
    type: 'traffic' as const,
    minutes: 15 as const,
    top: { type: 'traffic' as const, minutes: 15, totals: { count: 10 }, kpis: {}, tops: { rule: [{ key: 'allow-lan', value: 10 }] }, perMinute: [], retentionSec: 86400 },
    lists: [{ dim: 'rule', title: '規則', byBytes: false, items: [{ key: 'allow-lan', n: 10 }] }],
    kpis: [],
    error: null,
    loading: false,
    source: { live: true, empty: '', stale: '' },
    ruleLinkable,
  });

  it('RankingDrawer:規則排行可點,送出 open-rule', async () => {
    const w = mount(RankingDrawer, { props: rankProps(() => true), global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('allow-lan'));
    expect(btn).toBeTruthy();
    btn!.click();
    await flushPromises();
    expect(w.emitted('open-rule')).toEqual([['allow-lan']]);
    expect(w.emitted('open-signature')).toBeUndefined();
    w.unmount();
  });

  it('RankingDrawer:沒有 ruleLinkable 時規則排行不可點', async () => {
    const w = mount(RankingDrawer, { props: rankProps(), global: MOUNT_GLOBAL, attachTo: document.body });
    await flushPromises();
    expect(document.body.textContent).toContain('allow-lan');
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent?.includes('allow-lan'))).toBe(false);
    w.unmount();
  });
});
