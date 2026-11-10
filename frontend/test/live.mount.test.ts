// @vitest-environment happy-dom
/**
 * 即時監控頁掛載測試(驗收 2026-11-10 §4.1、§4.4、§7-5):
 *   - 即時排行的「類型」下拉與「5 / 15 / 60 分鐘」切換、即時 log 的「暫停 / 繼續」真的有渲染
 *     (原本用 GCard 不存在的 #extra 插槽,畫面上沒有控制項,單元測試也沒抓到)
 *   - 接收未啟用(receive.enabled=false)時排行與 log 的說明文字(測試區接收已開,無法實測)
 *   - 輪詢暫停時介面流量顯示「停止更新」,不顯示暫停前最後一輪的值
 *   - URL 過濾不顯示固定為 9999 的「名稱」欄,改顯示 URL 類別
 * API 與 EventSource 以假資料替換,不連任何服務。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorStatus, PaLiveSnapshot, PaLiveTop } from '@/api/paLive';
import ui from '@/ui';
import Live from '@/pages/firewall/Live.vue';

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  series: vi.fn(),
  top: vi.fn(),
  logs: vi.fn(),
  setControl: vi.fn(),
  probeStream: vi.fn(),
}));

vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return { ...real, paLive: { ...real.paLive, ...api } };
});

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function collector(receive: Partial<CollectorStatus['receive']> = {}, poll: Partial<CollectorStatus['poll']> = {}): CollectorStatus {
  return {
    state: 'ok',
    message: '收集器運作中',
    updatedAt: '2026-11-10T01:00:00Z',
    version: '1',
    poll: { enabled: true, paused: false, lastOkAt: '2026-11-10T01:00:00Z', error: null, errorAt: null, ...poll },
    receive: { enabled: true, paused: false, tls: false, httpLastAt: null, syslogLastAt: null, ...receive },
    redis: { error: null, errorAt: null },
    counters: { received: 0, dropped: 0, rejected: 0, malformed: 0, redisFailed: 0, paused: 0 },
  };
}

function snapshot(c: CollectorStatus): PaLiveSnapshot {
  return {
    collector: c,
    metrics: {
      session: { time: '2026-11-10T01:00:00Z', active: 100, max: 1000, utilization: 10, tcp: 80, udp: 20, icmp: 0 },
      cpu: null,
      throughput: null,
      interfaces: { time: '2026-11-10T01:00:00Z', items: [{ name: 'ae1', rxBps: 20_300_000, txBps: 1_000_000 }] },
    },
  };
}

const emptyTop: PaLiveTop = { type: 'traffic', minutes: 15, totals: {}, kpis: {}, tops: {}, perMinute: [], retentionSec: 3600 };

async function mountLive(snap: PaLiveSnapshot) {
  api.snapshot.mockResolvedValue(snap);
  const w = mount(Live, { global: { plugins: [ui], stubs: { teleport: true, RouterLink: true } } });
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  api.series.mockResolvedValue({ metric: 'cpu', minutes: 60, points: [] });
  api.top.mockResolvedValue(emptyTop);
  api.logs.mockResolvedValue({ type: 'traffic', items: [], nextBefore: null, scanned: 0, truncated: false, earliest: null, retentionSec: 3600 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const card = (w: Awaited<ReturnType<typeof mountLive>>, title: string) => {
  const c = w.findAll('section.g-card').find((s) => s.find('.title').exists() && s.find('.title').text() === title);
  if (!c) throw new Error(`找不到卡片「${title}」`);
  return c;
};

describe('即時監控頁(掛載)', () => {
  it('即時排行的類型下拉、5 / 15 / 60 分鐘切換顯示在卡片標題右側;切換會重新查詢', async () => {
    const w = await mountLive(snapshot(collector()));
    const actions = card(w, '即時排行').find('header .actions');
    expect(actions.exists()).toBe(true);
    const select = actions.find('select');
    expect(select.exists()).toBe(true);
    expect(select.findAll('option').map((o) => o.text())).toContain('威脅');
    expect(actions.text()).toContain('5 分鐘');
    expect(actions.text()).toContain('60 分鐘');

    api.top.mockClear();
    await select.setValue('threat');
    await flushPromises();
    expect(api.top).toHaveBeenCalledWith('threat', 15, 10);
    await actions.findAll('button').find((b) => b.text() === '60 分鐘')!.trigger('click');
    await flushPromises();
    expect(api.top).toHaveBeenLastCalledWith('threat', 60, 10);
    w.unmount();
  });

  it('即時 log 的暫停 / 繼續按鈕顯示在卡片標題右側,按下切換', async () => {
    const w = await mountLive(snapshot(collector()));
    const btn = () => card(w, '即時 log').find('header .actions button');
    expect(btn().exists()).toBe(true);
    expect(btn().text()).toBe('暫停');
    await btn().trigger('click');
    expect(btn().text()).toBe('繼續');
    expect(card(w, '即時 log').text()).toContain('已暫停');
    w.unmount();
  });

  it('接收未啟用:排行與即時 log 都說明「接收端點未啟用,沒有 log 來源」,不寫成這段期間沒有收到', async () => {
    const w = await mountLive(snapshot(collector({ enabled: false })));
    const top = card(w, '即時排行').text();
    expect(top).toContain('沒有 log 來源');
    expect(top).toContain('接收端點未啟用,沒有 log 來源');
    expect(top).not.toContain('這段期間沒有收到');
    expect(card(w, '即時 log').text()).toContain('接收端點未啟用,沒有 log 來源');
    expect(w.text()).toContain('接收未啟用');
    w.unmount();
  });

  it('輪詢暫停:介面流量顯示「停止更新」,不顯示暫停前最後一輪的值', async () => {
    const w = await mountLive(snapshot(collector({}, { paused: true })));
    const ifs = card(w, '介面流量').text();
    expect(ifs).toContain('停止更新');
    expect(ifs).toContain('輪詢暫停');
    expect(ifs).not.toContain('ae1');
    w.unmount();
  });

  it('輪詢中:介面流量照常顯示', async () => {
    const w = await mountLive(snapshot(collector()));
    const ifs = card(w, '介面流量').text();
    expect(ifs).toContain('ae1');
    expect(ifs).toContain('20.3 Mbps');
    w.unmount();
  });

  it('URL 過濾的 log 不顯示「名稱」欄(固定 9999),改顯示 URL 類別', async () => {
    const w = await mountLive(snapshot(collector()));
    const log = () => card(w, '即時 log');
    const headers = () => log().findAll('th').map((th) => th.text());
    await log().findAll('button').find((b) => b.text() === '威脅')!.trigger('click');
    await flushPromises();
    expect(headers()).toContain('名稱');
    await log().findAll('button').find((b) => b.text() === 'URL 過濾')!.trigger('click');
    await flushPromises();
    expect(headers()).not.toContain('名稱');
    expect(headers()).toContain('URL 類別');
    w.unmount();
  });
});
