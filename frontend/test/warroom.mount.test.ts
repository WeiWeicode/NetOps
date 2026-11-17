// @vitest-environment happy-dom
/**
 * 戰情室(WR-5)畫面與元件掛載測試(docs/WARROOM-GEMINI-HANDOFF.md §2–§4):
 *   - Live.vue 戰情室整體掛載(頂部 6 KPI、中央 Canvas、左說明、右事件、上 AI 分析、下高風險統計、底 Log 表、系統狀態抽屜)
 *   - Notices.vue:notices[] 全部顯示(範例網段、設定錯誤、推估值、partial、GeoIP 不可用)與 DB-IP 授權連結(IP Geolocation by DB-IP → https://db-ip.com)
 *   - LegendPanel.vue:收摺切換與寫入 localStorage('wr-legend')
 *   - AiPanel.vue:光球動畫狀態、逐字顯示、自動/手動與時間、立即分析按鈕(v-if="allowed"、:disabled="!canRun"、冷卻倒數)、本小時分析失敗提示
 *   - RiskPanel.vue:4 個總覽數字(partial 時顯示「—」、attackSourcesLowerBound 為 true 時加「≥」)、Top 威脅類型與 Top 攻擊來源長條
 *   - EventFeed.vue & TrafficLogTable.vue:即時事件不受篩選影響、底部 Log 表篩選(all/deny/allow/threat)、暫停/繼續、節點聚焦同步篩選與取消聚焦
 *   - WarroomCanvas.vue:節點滑過明細 tooltip、點擊節點切換聚焦、點擊空白取消聚焦、儀表使用傳入的 gauge(不寫死)
 *   - SystemStatusDrawer.vue:收集器狀態徽章、介面流量、測試區暫停/繼續開關(呼叫 setControl)
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorControl, CollectorStatus, LiveLog, PaLiveSnapshot } from '@/api/paLive';
import type { HourlyInsight, Warroom, WarroomRisk } from '@/api/warroom';
import AiPanel from '@/components/warroom/AiPanel.vue';
import EventFeed from '@/components/warroom/EventFeed.vue';
import LegendPanel from '@/components/warroom/LegendPanel.vue';
import Notices from '@/components/warroom/Notices.vue';
import RiskPanel from '@/components/warroom/RiskPanel.vue';
import SystemStatusDrawer from '@/components/warroom/SystemStatusDrawer.vue';
import TrafficLogTable from '@/components/warroom/TrafficLogTable.vue';
import WarroomCanvas from '@/components/warroom/WarroomCanvas.vue';
import { buildNodes, sumRates, warroomNotices } from '@/composables/useWarroom';
import Live from '@/pages/firewall/Live.vue';
import ui from '@/ui';

const mocks = vi.hoisted(() => ({
  wrGet: vi.fn(),
  wrRisk: vi.fn(),
  wrInsight: vi.fn(),
  wrRunInsight: vi.fn(),
  liveSnapshot: vi.fn(),
  liveLogs: vi.fn(),
  liveSetControl: vi.fn(),
  liveStreamUrl: vi.fn(() => '/api/netops/pa-live/stream'),
  liveProbeStream: vi.fn(),
  perms: new Set<string>(['netops.pa-live.ai', 'netops.pa-live.manage']),
}));

vi.mock('@/api/warroom', async (orig) => ({
  ...(await orig<typeof import('@/api/warroom')>()),
  warroom: {
    get: mocks.wrGet,
    risk: mocks.wrRisk,
    insight: mocks.wrInsight,
    runInsight: mocks.wrRunInsight,
  },
}));

vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return {
    ...real,
    paLive: {
      ...real.paLive,
      snapshot: mocks.liveSnapshot,
      logs: mocks.liveLogs,
      setControl: mocks.liveSetControl,
      streamUrl: mocks.liveStreamUrl,
      probeStream: mocks.liveProbeStream,
    },
  };
});

vi.mock('@/api/gateway', async (orig) => ({
  ...(await orig<typeof import('@/api/gateway')>()),
  can: (code: string) => mocks.perms.has(code),
}));

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

function makeWarroom(over: Partial<Warroom> = {}): Warroom {
  return {
    generatedAt: '2026-11-17T03:00:00Z',
    minutes: 5,
    partial: false,
    segmentsSource: 'example',
    gauge: { throughputMaxBps: 2e9, sessionMax: 128_000 },
    geo: {
      available: true,
      version: '2026-11',
      attribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' },
    },
    sample: { traffic: 3000, trafficSec: 300, threat: 25, threatSec: 300, complete: true },
    sources: [
      {
        id: 'cc:TW',
        kind: 'country',
        label: '台灣',
        country: 'TW',
        conn: 900,
        deny: 18,
        threat: 2,
        topDst: [{ key: '10.10.10.10', count: 120 }],
        topApp: [{ key: 'ssl', count: 300 }],
      },
      {
        id: 'ip:45.155.205.12',
        kind: 'ip',
        label: '45.155.205.12',
        country: 'NL',
        conn: 90,
        deny: 88,
        threat: 5,
        topDst: [{ key: '10.10.200.10', count: 80 }],
        topApp: [{ key: 'ssh', count: 75 }],
      },
    ],
    segments: [
      { id: 'vlan10', kind: 'vlan', label: 'VLAN 10 辦公', icon: 'pc', conn: 700, bytes: 8_400_000, threat: 1 },
      { id: 'dmz-web', kind: 'service', label: 'DMZ Web', icon: 'server', conn: 290, bytes: 3_500_000, threat: 6 },
    ],
    links: [
      { source: 'cc:TW', segment: 'vlan10', conn: 2.5, allow: 2.4, deny: 0.08, threat: 0.02 },
      { source: 'ip:45.155.205.12', segment: 'dmz-web', conn: 0.3, allow: 0.01, deny: 0.27, threat: 0.02 },
    ],
    kpis: { denyPerMin: 420, threat5m: 15 },
    ...over,
  };
}

function makeRisk(over: Partial<WarroomRisk> = {}): WarroomRisk {
  return {
    generatedAt: '2026-11-17T03:00:00Z',
    minutes: 60,
    partial: false,
    threats: 35,
    denies: 19200,
    attackSources: 148,
    attackSourcesLowerBound: true,
    critical: 16,
    topThreats: [
      { name: 'SSH Brute Force', severity: 'critical', count: 14 },
      { name: 'SMB Scan', severity: 'high', count: 9 },
    ],
    topSources: [
      { key: '45.155.205.12', label: 'Netherlands', country: 'NL', count: 3100, denyRatio: 0.97 },
      { key: '91.240.118.1', label: 'Russia', country: 'RU', count: 1800, denyRatio: 0.82 },
    ],
    sample: { threat: 35, complete: true },
    ...over,
  };
}

function makeSnapshot(over: Partial<PaLiveSnapshot> = {}): PaLiveSnapshot {
  const c: CollectorStatus = {
    state: 'ok',
    message: '運作中',
    updatedAt: '2026-11-17T03:00:00Z',
    version: '1.0',
    poll: { enabled: true, paused: false, lastOkAt: '2026-11-17T03:00:00Z', error: null, errorAt: null },
    receive: { enabled: true, paused: false, tls: true, httpLastAt: '2026-11-17T03:00:00Z', syslogLastAt: null },
    redis: { error: null, errorAt: null },
    counters: { received: 100, dropped: 0, rejected: 0, malformed: 0, redisFailed: 0, paused: 0 },
  };
  return {
    collector: c,
    metrics: {
      session: { time: '2026-11-17T03:00:00Z', active: 43210, max: 64000, utilization: 67.5, tcp: 30000, udp: 13000, icmp: 210 },
      cpu: { time: '2026-11-17T03:00:00Z', mgmt: 18, dataplane: 54, memUsed: 4_000_000_000, memTotal: 8_000_000_000 },
      throughput: { time: '2026-11-17T03:00:00Z', bps: 512_000_000, pps: 60000, cps: 1150 },
      interfaces: { time: '2026-11-17T03:00:00Z', items: [{ name: 'ethernet1/1', rxBps: 300_000_000, txBps: 212_000_000 }] },
    },
    control: { available: true, pollPaused: false, receivePaused: false, updatedAt: null, updatedBy: null },
    ...over,
  };
}

const SAMPLE_LOGS: LiveLog[] = [
  {
    id: 'l-1',
    type: 'traffic',
    receivedAt: '2026-11-17T03:00:01Z',
    action: 'deny',
    src: '45.155.205.12',
    dst: '10.10.200.10',
    dport: 22,
    app: 'ssh',
    rule: 'block-geo',
    bytes: 0,
    sessionid: 10001,
    country: 'NL',
    segment: 'dmz-web',
  },
  {
    id: 'l-2',
    type: 'traffic',
    receivedAt: '2026-11-17T03:00:02Z',
    action: 'allow',
    src: '114.32.10.5',
    dst: '10.10.10.25',
    dport: 443,
    app: 'ssl',
    rule: 'allow-lan',
    bytes: 18400,
    sessionid: 10002,
    country: 'TW',
    segment: 'vlan10',
  },
  {
    id: 'l-3',
    type: 'threat',
    receivedAt: '2026-11-17T03:00:03Z',
    action: 'alert',
    severity: 'critical',
    name: 'SSH Brute Force',
    src: '45.155.205.12',
    dst: '10.10.200.10',
    dport: 22,
    app: 'ssh',
    rule: 'av-vp-default',
    country: 'NL',
    segment: 'dmz-web',
  },
];

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  }
  mocks.liveStreamUrl.mockReturnValue('/api/netops/pa-live/stream');
  mocks.perms = new Set(['netops.pa-live.ai', 'netops.pa-live.manage']);
  mocks.wrGet.mockResolvedValue(makeWarroom());
  mocks.wrRisk.mockResolvedValue(makeRisk());
  mocks.wrInsight.mockResolvedValue({
    hour: '2026-11-17T03:00:00Z',
    text: '近一小時共 **15** 筆威脅，主要為 SSH Brute Force。',
    model: 'Qwen3.6',
    trigger: 'auto',
    partial: false,
    status: 'done',
    createdAt: '2026-11-17T03:00:05Z',
  } satisfies HourlyInsight);
  mocks.liveSnapshot.mockResolvedValue(makeSnapshot());
  mocks.liveLogs.mockImplementation(async (type: string) => ({
    type,
    items: SAMPLE_LOGS.filter((l) => l.type === type),
    nextBefore: null,
    scanned: 2,
    truncated: false,
    earliest: '2026-11-17T02:00:00Z',
    retentionSec: 3600,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Notices.vue 提示橫幅與 DB-IP 授權', () => {
  it('完整顯示所有 notices[] 並在有 geoAttribution 時顯示 IP Geolocation by DB-IP 連結', () => {
    const wData = makeWarroom({
      partial: true,
      message: 'Redis 連線中斷',
      segmentsSource: 'invalid',
      sample: { traffic: 100, trafficSec: 120, threat: 5, threatSec: 300, complete: false },
    });
    const rData = makeRisk({
      partial: true,
      message: '高風險統計暫時無法取得',
      sample: { threat: 10, complete: false },
    });
    const notices = warroomNotices(wData, rData);
    const w = mount(Notices, {
      props: {
        notices,
        geoAttribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' },
        stale: true,
      },
    });

    for (const n of notices) {
      expect(w.text()).toContain(n.text);
    }
    expect(w.text()).toContain('超過 15 秒未更新');
    const link = w.find('a.wr-geo-attr');
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe('IP Geolocation by DB-IP');
    expect(link.attributes('href')).toBe('https://db-ip.com');
    w.unmount();
  });

  it('geoAttribution 為 null 時不顯示 DB-IP 連結', () => {
    const w = mount(Notices, {
      props: {
        notices: [{ key: 'geo-unavailable', tone: 'warning', text: 'GeoIP 資料庫無法使用,國家歸入「其他」' }],
        geoAttribution: null,
      },
    });
    expect(w.text()).toContain('GeoIP 資料庫無法使用');
    expect(w.find('a.wr-geo-attr').exists()).toBe(false);
    w.unmount();
  });
});

describe('LegendPanel.vue 左側可收摺說明', () => {
  it('點擊按鈕切換收摺狀態並寫入 localStorage("wr-legend")', async () => {
    const w = mount(LegendPanel, {
      props: {
        modelValue: true,
        geoAttribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' },
      },
    });
    expect(w.classes()).not.toContain('mini');
    expect(w.text()).toContain('允許流量');
    expect(w.text()).toContain('IP Geolocation by DB-IP');

    await w.find('#lgBtn').trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false]);
    expect(localStorage.getItem('wr-legend')).toBe('0');

    await w.setProps({ modelValue: false });
    expect(w.classes()).toContain('mini');
    w.unmount();
  });
});

describe('AiPanel.vue 上方 AI 分析框', () => {
  it('顯示 AI 分析內容、模型與時間;依 allowed / canRun / cooldownSec 控制立即分析按鈕;failed 時顯示本小時分析失敗', async () => {
    const insight: HourlyInsight = {
      hour: '2026-11-17T03:00:00Z',
      text: '測試分析結果',
      model: 'Qwen3.6',
      trigger: 'manual',
      partial: false,
      status: 'done',
      createdAt: '2026-11-17T03:05:00Z',
    };
    const w = mount(AiPanel, {
      props: {
        text: insight.text,
        insight,
        running: false,
        failed: false,
        runError: '',
        allowed: true,
        canRun: true,
        cooldownSec: 0,
      },
    });
    expect(w.text()).toContain('手動分析');
    expect(w.text()).toContain('Qwen3.6');
    expect(w.text()).toContain('測試分析結果');

    const btn = w.find('#aiBtn');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes('disabled')).toBeUndefined();
    await btn.trigger('click');
    expect(w.emitted('run')).toHaveLength(1);

    // 冷卻中:按鈕 disabled 且顯示倒數秒數
    await w.setProps({ canRun: false, cooldownSec: 185 });
    expect(w.find('#aiBtn').attributes('disabled')).toBeDefined();
    expect(w.find('#aiBtn').text()).toContain('185s');

    // 本小時分析失敗
    await w.setProps({ failed: true, text: '' });
    expect(w.text()).toContain('本小時分析失敗');

    // 無權限時隱藏按鈕
    await w.setProps({ allowed: false });
    expect(w.find('#aiBtn').exists()).toBe(false);
    w.unmount();
  });
});

describe('RiskPanel.vue 近一小時高風險統計', () => {
  it('顯示 4 個總覽數字(attackSourcesLowerBound 加 ≥)、Top 威脅類型與 Top 攻擊來源;partial 時顯示 —', async () => {
    const w = mount(RiskPanel, {
      props: { risk: makeRisk() },
    });
    expect(w.find('#rThreat').text()).toBe('35');
    expect(w.find('#rDeny').text()).toBe('19,200');
    expect(w.find('#rSrc').text()).toBe('≥148');
    expect(w.find('#rCrit').text()).toBe('16');
    expect(w.find('#rTypes').text()).toContain('SSH Brute Force');
    expect(w.find('#rTop').text()).toContain('45.155.205.12');

    // partial 時四個數字為 null → 顯示 —
    await w.setProps({
      risk: makeRisk({
        partial: true,
        threats: null,
        denies: null,
        attackSources: null,
        critical: null,
        topThreats: [],
        topSources: [],
      }),
    });
    expect(w.find('#rThreat').text()).toBe('—');
    expect(w.find('#rDeny').text()).toBe('—');
    expect(w.find('#rSrc').text()).toBe('—');
    expect(w.find('#rCrit').text()).toBe('—');
    w.unmount();
  });
});

describe('EventFeed.vue 與 TrafficLogTable.vue', () => {
  it('EventFeed 顯示即時事件與威脅名稱;TrafficLogTable 支援篩選、暫停與取消聚焦', async () => {
    const wr = makeWarroom();
    const wFeed = mount(EventFeed, {
      props: {
        events: [
          { log: SAMPLE_LOGS[0]!, kind: 'deny' },
          { log: SAMPLE_LOGS[2]!, kind: 'threat' },
        ],
        sources: wr.sources,
        segments: wr.segments,
      },
    });
    expect(wFeed.text()).toContain('阻擋');
    expect(wFeed.text()).toContain('45.155.205.12 → DMZ Web');
    expect(wFeed.text()).toContain('SSH Brute Force');
    wFeed.unmount();

    const wTable = mount(TrafficLogTable, {
      props: {
        logs: SAMPLE_LOGS,
        filter: 'all',
        paused: false,
        focus: { side: 'segment', id: 'dmz-web' },
        sources: wr.sources,
        segments: wr.segments,
      },
      global: { plugins: [ui], stubs: { RouterLink: true } },
    });
    expect(wTable.findAll('tbody tr')).toHaveLength(3);
    expect(wTable.text()).toContain('聚焦 網段：DMZ Web');

    // 點擊篩選「阻擋」
    await wTable.find('[data-f="deny"]').trigger('click');
    expect(wTable.emitted('update:filter')?.[0]).toEqual(['deny']);

    // 點擊暫停
    await wTable.find('#pause').trigger('click');
    expect(wTable.emitted('update:paused')?.[0]).toEqual([true]);

    // 點擊取消聚焦
    await wTable.find('.wr-logbar__focus').trigger('click');
    expect(wTable.emitted('clearFocus')).toHaveLength(1);
    wTable.unmount();
  });
});

describe('WarroomCanvas.vue 節點互動與儀表滿格設定', () => {
  it('滑過節點顯示明細 tooltip、點擊節點發送 toggleFocus、點擊畫布空白處取消聚焦', async () => {
    const wr = makeWarroom({ gauge: { throughputMaxBps: 5e9, sessionMax: 256_000 } });
    const built = buildNodes(wr, null);
    const w = mount(WarroomCanvas, {
      props: {
        sources: built.sources,
        segments: built.segments,
        links: built.links,
        rates: sumRates(wr.links),
        kpis: wr.kpis,
        snapshot: makeSnapshot(),
        gauge: wr.gauge,
        focus: null,
        legendOpen: true,
      },
    });
    await flushPromises();

    const srcBtn = w.find('button[data-node-side="source"][data-node-id="cc:TW"]');
    expect(srcBtn.exists()).toBe(true);

    // 滑過節點顯示明細
    await srcBtn.trigger('mouseenter');
    expect(w.find('#tip').text()).toContain('台灣');
    expect(w.find('#tip').text()).toContain('900');
    expect(w.find('#tip').text()).toContain('ssl');

    // 點擊節點切換聚焦
    await srcBtn.trigger('click');
    expect(w.emitted('toggleFocus')?.[0]).toEqual([{ side: 'source', id: 'cc:TW' }]);

    // 點擊畫布空白處取消聚焦
    await w.find('canvas#c').trigger('click', { clientX: 5, clientY: 5 });
    expect(w.emitted('toggleFocus')?.[1]).toEqual([null]);
    w.unmount();
  });
});

describe('SystemStatusDrawer.vue 系統狀態收摺抽屜', () => {
  it('顯示收集器徽章、介面流量與測試區開關;點擊測試區開關呼叫 setControl', async () => {
    const setControl = vi.fn(async (c: { pollPaused?: boolean; receivePaused?: boolean }): Promise<CollectorControl> => ({
      available: true,
      pollPaused: !!c.pollPaused,
      receivePaused: !!c.receivePaused,
      updatedAt: '2026-11-17T03:01:00Z',
      updatedBy: 'admin',
    }));

    const w = mount(SystemStatusDrawer, {
      props: {
        modelValue: true,
        snapshot: makeSnapshot(),
        connected: true,
        setControl,
      },
      global: { plugins: [ui], stubs: { teleport: true, RouterLink: true } },
    });

    expect(w.text()).toContain('輪詢中');
    expect(w.text()).toContain('接收中');
    expect(w.text()).toContain('ethernet1/1');
    expect(w.text()).toContain('測試區開關');

    const pollBtn = w.findAll('button').find((b) => b.text().includes('輪詢：'))!;
    expect(pollBtn.exists()).toBe(true);
    await pollBtn.trigger('click');
    expect(setControl).toHaveBeenCalledWith({ pollPaused: true });
    w.unmount();
  });
});

describe('Live.vue 戰情室頁面整合掛載', () => {
  it('完整渲染戰情室頂部 KPI、提示橫幅、DB-IP 授權、AI 分析框、高風險統計、即時事件與底部 Log 表', async () => {
    const w = mount(Live, {
      global: { plugins: [ui], stubs: { teleport: true, RouterLink: true } },
    });
    await flushPromises();

    // 頂部 6 KPI
    expect(w.find('#kBps').text()).toBe('512 Mbps');
    expect(w.find('#kSess').text()).toBe('43,210');
    expect(w.find('#kCps').text()).toBe('1,150');
    expect(w.find('#kDeny').text()).toBe('420');
    expect(w.find('#kThr').text()).toBe('15');
    expect(w.find('#kCpu').text()).toBe('54%');

    // 必做:DB-IP 授權與 notices[]
    expect(w.text()).toContain('IP Geolocation by DB-IP');
    expect(w.find('a[href="https://db-ip.com"]').exists()).toBe(true);
    expect(w.text()).toContain('目前顯示範例網段');

    // AI 分析框與高風險統計
    expect(w.find('#ai').text()).toContain('Qwen3.6');
    expect(w.find('#risk').text()).toContain('19,200');
    expect(w.find('#rSrc').text()).toBe('≥148');

    // 底部 Log 表預載的紀錄
    expect(w.findAll('#lb tr').length).toBeGreaterThanOrEqual(2);
    w.unmount();
  });
});
