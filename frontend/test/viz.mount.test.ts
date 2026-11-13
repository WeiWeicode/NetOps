// @vitest-environment happy-dom
/**
 * V-b2 熱力圖、儀表板、時段明細抽屜與 9 個圖表元件掛載測試(HANDOFF-GEMINI-VIZ §3–§8):
 *   - GHeatmap:null 斜線底紋 vs 0、partial 標記、鍵盤方向鍵 / Enter / Shift+Enter、毛玻璃 tooltip(Top 1 IP 標「約」)、觸控兩段點擊、reduced-motion 關 stagger
 *   - GDrawer / GSourceBadge:Esc 關閉、Tab 焦點鎖定、hot / cold / mixed 徽章
 *   - SliceDrawer:冷資料掃描線過場、202 waiting-job、429 busy 倒數、409 冷歸檔未提供保留 cell 彙總、503 danger 錯誤、C5 前不顯示即時連線按鈕
 *   - 9 個圖表元件:GTrendDualAxis、GSankey、GTopBars、GAppShare(donut/treemap)、GAllowDeny、GSeverityCards、GThreatTimeline、GWorldMap、GTopCompare(right=null 顯示 notes)與 formatter XSS 跳脫
 *   - Heatmap.vue / Insight.vue:AD 停用提示、日視圖 422 保留期限提示、看表格無障礙切換、點擊聯動開啟 SliceDrawer
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/gateway';
import type { HeatmapResponse } from '@/api/heatmap';
import type { SankeyNode } from '@/api/insight';
import type { SliceJob, SliceResult } from '@/api/slice';
import SliceDrawer from '@/components/SliceDrawer.vue';
import { useSlice } from '@/composables/useSlice';
import Heatmap from '@/pages/firewall/Heatmap.vue';
import Insight from '@/pages/firewall/Insight.vue';
import ui from '@/ui';
import GAllowDeny from '@/ui/charts/GAllowDeny.vue';
import GAppShare from '@/ui/charts/GAppShare.vue';
import GHeatmap from '@/ui/charts/GHeatmap.vue';
import GSankey from '@/ui/charts/GSankey.vue';
import GSeverityCards from '@/ui/charts/GSeverityCards.vue';
import GThreatTimeline from '@/ui/charts/GThreatTimeline.vue';
import GTopBars from '@/ui/charts/GTopBars.vue';
import GTopCompare from '@/ui/charts/GTopCompare.vue';
import GTrendDualAxis from '@/ui/charts/GTrendDualAxis.vue';
import GWorldMap from '@/ui/charts/GWorldMap.vue';
import GDrawer from '@/ui/components/GDrawer.vue';
import GSourceBadge from '@/ui/components/GSourceBadge.vue';
import { heatmapResponse, sliceResult, threatInsight, trafficInsight } from './fixtures/viz/generate';

const NOW = Date.parse('2026-11-11T10:07:30+08:00');

const mocks = vi.hoisted(() => {
  const charts: {
    options: Record<string, unknown>[];
    handlers: Record<string, (e: unknown) => void>;
    disposed: boolean;
  }[] = [];
  return {
    charts,
    heatmapGet: vi.fn(),
    sliceGet: vi.fn(),
    sliceJob: vi.fn(),
    sliceCancel: vi.fn(),
    traffic: vi.fn(),
    threat: vi.fn(),
    perms: new Set<string>(['netops.pa.read', 'netops.pa-log.read', 'netops.pa-heatmap.read', 'netops.pa-insight.read']),
    echartsLib: {
      echarts: {
        init: () => {
          const c = {
            options: [] as Record<string, unknown>[],
            handlers: {} as Record<string, (e: unknown) => void>,
            disposed: false,
          };
          charts.push(c);
          return {
            setOption: (o: Record<string, unknown>) => c.options.push(o),
            showLoading: () => undefined,
            hideLoading: () => undefined,
            resize: () => undefined,
            on: (ev: string, fn: (e: unknown) => void) => (c.handlers[ev] = fn),
            dispose: () => (c.disposed = true),
          };
        },
        format: {
          encodeHTML: (s: string) =>
            String(s)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;'),
        },
      },
      buildTheme: () => ({}),
      themeKey: () => 'light/glass',
      escapeHtml: (s: unknown) =>
        String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;'),
    },
  };
});

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/ui/charts/echarts', () => mocks.echartsLib);
vi.mock('@/api/heatmap', () => ({ heatmap: { get: mocks.heatmapGet } }));
vi.mock('@/api/slice', () => ({ slice: { get: mocks.sliceGet, job: mocks.sliceJob, cancel: mocks.sliceCancel } }));
vi.mock('@/api/insight', () => ({ insight: { traffic: mocks.traffic, threat: mocks.threat } }));
vi.mock('@/api/gateway', async (orig) => ({
  ...(await orig<typeof import('@/api/gateway')>()),
  can: (c: string) => mocks.perms.has(c),
}));

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes('reduce'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

async function flushCharts(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await flushPromises();
  }
}

beforeEach(async () => {
  await import('@/ui/charts/echarts');
  mocks.charts.length = 0;
  for (const f of [mocks.heatmapGet, mocks.sliceGet, mocks.sliceJob, mocks.sliceCancel, mocks.traffic, mocks.threat]) {
    f.mockReset();
  }
  mocks.sliceCancel.mockResolvedValue(undefined);
  mocks.perms = new Set(['netops.pa.read', 'netops.pa-log.read', 'netops.pa-heatmap.read', 'netops.pa-insight.read']);
  setReducedMotion(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GHeatmap 熱力圖元件', () => {
  it('區分 v === null(is-null 斜線底紋)、level 0 與 partial;鍵盤方向鍵移動、Enter 選取、Shift+Enter 下鑽', async () => {
    const res = heatmapResponse({
      granularity: 'day',
      metric: 'traffic',
      date: '2026-11-10',
      now: NOW,
      since: Date.parse('2026-11-10T01:00:00+08:00'),
    });
    const w = mount(GHeatmap, {
      props: {
        granularity: 'day',
        metric: 'traffic',
        cells: res.cells as HeatmapResponse['cells'],
        from: res.from,
        to: res.to,
      },
      global: { plugins: [ui] },
    });

    const buttons = w.findAll('button.g-heatmap__cell');
    expect(buttons.length).toBe(288);
    // 01:00 之前為 null
    expect(buttons[0]!.classes()).toContain('is-null');
    expect(buttons[0]!.attributes('aria-label')).toContain('沒有資料');
    // 01:00 之後有值
    expect(buttons[20]!.classes()).not.toContain('is-null');
    // 每 17 格一個 partial(index 16)
    expect(buttons[16]!.classes()).toContain('is-partial');
    expect(buttons[16]!.attributes('aria-label')).toContain('此時段資料不完整');

    // 鍵盤方向鍵移動(0,0 → 右 1,0 → index 1)
    await buttons[0]!.trigger('keydown', { key: 'ArrowRight' });
    expect(buttons[1]!.attributes('tabindex')).toBe('0');

    // Enter 觸發 select,Shift+Enter 觸發 drill
    await buttons[1]!.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('select')?.[0]?.[0]).toEqual(res.cells[1]);

    await buttons[1]!.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(w.emitted('drill')?.[0]?.[0]).toEqual(res.cells[1]);

    // 滑鼠懸停顯示毛玻璃 tooltip,Top 1 IP 標「約」
    await buttons[20]!.trigger('mouseenter');
    expect(w.find('.g-heatmap__tip').exists()).toBe(true);
    expect(w.find('.g-heatmap__tip').text()).toContain('約 10.10.');
    w.unmount();
  });

  it('觸控裝置點一下顯示 tooltip、再點同一格才觸發 select', async () => {
    const res = heatmapResponse({ granularity: 'day', metric: 'threat', date: '2026-11-10', now: NOW });
    const w = mount(GHeatmap, {
      props: {
        granularity: 'day',
        metric: 'threat',
        cells: res.cells.slice(0, 12) as HeatmapResponse['cells'],
        from: res.from,
        to: res.to,
      },
      global: { plugins: [ui] },
    });

    const btn = w.find('button.g-heatmap__cell');
    await btn.trigger('pointerdown', { pointerType: 'touch' });
    await btn.trigger('click');
    expect(w.emitted('select')).toBeUndefined();
    expect(w.find('.g-heatmap__tip').exists()).toBe(true);
    expect(w.find('.g-heatmap__tip').text()).toContain('再次點擊開啟時段明細');

    await btn.trigger('pointerdown', { pointerType: 'touch' });
    await btn.trigger('click');
    expect(w.emitted('select')).toHaveLength(1);
    w.unmount();
  });

  // Claude 2026-11-12(程式碼審查 #1、#3、#4、#9)
  it('滑鼠單擊延遲後才 select;雙擊只 drill(抽屜遮罩不會吃掉第二下)', async () => {
    vi.useFakeTimers();
    const res = heatmapResponse({ granularity: 'day', metric: 'traffic', date: '2026-11-10', now: NOW });
    const w = mount(GHeatmap, {
      props: { granularity: 'day', metric: 'traffic', cells: res.cells.slice(0, 12) as HeatmapResponse['cells'], from: res.from, to: res.to },
      global: { plugins: [ui] },
    });
    const btn = w.find('button.g-heatmap__cell');
    await btn.trigger('pointerdown', { pointerType: 'mouse' });
    await btn.trigger('click', { detail: 1 });
    expect(w.emitted('select')).toBeUndefined();
    vi.advanceTimersByTime(260);
    expect(w.emitted('select')).toHaveLength(1);

    await btn.trigger('click', { detail: 1 });
    await btn.trigger('click', { detail: 2 });
    await btn.trigger('dblclick');
    vi.advanceTimersByTime(260);
    expect(w.emitted('select')).toHaveLength(1);
    expect(w.emitted('drill')).toHaveLength(1);
    w.unmount();
  });

  it('年視圖欄位從 from 所在週的週起點起算(同一欄不跨週)、資料換了就清 tooltip、Home / End', async () => {
    // 2026-11-12(週四)起 14 天
    const from = '2026-11-12T00:00:00+08:00';
    const day = (i: number) => new Date(Date.parse(from) + i * 86_400_000).toISOString();
    const cells = Array.from({ length: 14 }, (_, i) => ({ t: day(i), v: 1, level: 1, partial: false, tip: { bytes: 1, sessions: 1, deny: 0, threats: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, topIp: { traffic: null, deny: null, threat: null } } }));
    const w = mount(GHeatmap, {
      props: { granularity: 'year', metric: 'traffic', cells: cells as unknown as HeatmapResponse['cells'], from, to: day(14) },
      global: { plugins: [ui] },
    });
    const b = w.findAll('button.g-heatmap__cell');
    const pos = (i: number) => [b[i]!.attributes('style')!.match(/grid-column: (\d+)/)![1], b[i]!.attributes('style')!.match(/grid-row: (\d+)/)![1]];
    expect(pos(0)).toEqual(['1', '4']); // 週四 = 第 4 列
    expect(pos(3)).toEqual(['1', '7']); // 週日仍在第 1 欄
    expect(pos(4)).toEqual(['2', '1']); // 週一換到第 2 欄
    await b[0]!.trigger('keydown', { key: 'End' });
    expect(b[13]!.attributes('tabindex')).toBe('0');
    await b[13]!.trigger('keydown', { key: 'Home' });
    expect(b[0]!.attributes('tabindex')).toBe('0');

    await b[2]!.trigger('mouseenter');
    expect(w.find('.g-heatmap__tip').exists()).toBe(true);
    await w.setProps({ cells: cells.map((c) => ({ ...c, v: 2 })) as unknown as HeatmapResponse['cells'] });
    expect(w.find('.g-heatmap__tip').exists()).toBe(false);
    w.unmount();
  });
});

describe('GSourceBadge 與 GDrawer / SliceDrawer', () => {
  it('GSourceBadge 正確顯示 hot / cold / mixed 徽章', () => {
    const hot = mount(GSourceBadge, { props: { source: 'hot' } });
    expect(hot.text()).toContain('即時熱資料');
    expect(hot.text()).not.toContain('歷史冷歸檔');

    const cold = mount(GSourceBadge, { props: { source: 'cold' } });
    expect(cold.text()).toContain('歷史冷歸檔');
    expect(cold.text()).not.toContain('即時熱資料');

    const mixed = mount(GSourceBadge, { props: { source: 'mixed' } });
    expect(mixed.text()).toContain('即時熱資料');
    expect(mixed.text()).toContain('歷史冷歸檔');
  });

  it('GDrawer 按 Esc 關閉並觸發 update:modelValue', async () => {
    const w = mount(GDrawer, {
      props: { modelValue: true, title: '測試抽屜' },
      global: { plugins: [ui], stubs: { teleport: true } },
    });
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    await w.find('.g-drawer').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false]);
    // 開著時鎖背景捲動;焦點在 body 時 document 層的 Esc 也能關(Claude 2026-11-12,程式碼審查 #6)
    expect(document.body.style.overflow).toBe('hidden');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.emitted('update:modelValue')).toHaveLength(2);
    w.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('SliceDrawer 呈現冷資料過場、202 背景查詢、429 忙碌倒數、409 保留熱力圖格彙總與完成結果', async () => {
    vi.useFakeTimers();
    const cell = heatmapResponse({ granularity: 'month', metric: 'traffic', date: '2026-10-05', now: NOW }).cells[10]! as HeatmapResponse['cells'][number];

    // 1. 409 冷歸檔尚未提供 → 中性提示並保留 cell 彙總數字
    mocks.sliceGet.mockRejectedValueOnce(
      new ApiError(409, 'NETOPS_COLD_ARCHIVE_DISABLED', '冷歸檔尚未提供', 'req-409', { hotFrom: '2026-10-13T00:00:00+08:00' }),
    );
    const s = useSlice({ now: () => NOW, pollMs: 1000 });
    const w = mount(SliceDrawer, {
      props: { modelValue: true, slice: s, cell, canDrill: true },
      global: { plugins: [ui], stubs: { teleport: true } },
    });
    await s.open({ start: '2026-10-05T08:00:00+08:00', end: '2026-10-05T09:00:00+08:00' });
    await flushPromises();
    expect(w.text()).toContain('冷歸檔尚未提供');
    expect(w.text()).toContain('此時段熱力圖彙總');
    expect(w.text()).toContain('約 10.10.');

    // 2. 429 忙碌倒數 → 中性提示與倒數重試按鈕
    mocks.sliceGet.mockRejectedValueOnce(
      new ApiError(429, 'NETOPS_COLD_QUERY_BUSY', '忙碌中', 'req-429', { retryAfter: 5 }),
    );
    await s.open({ start: '2026-10-05T08:00:00+08:00', end: '2026-10-05T09:00:00+08:00' });
    await flushPromises();
    expect(w.text()).toContain('5 秒後可重試');

    // 3. 200 完成結果(含 cold 徽章、Top 10、明細表;C5 前不顯示「查詢該 IP 當下 PA 即時連線」)
    const res = sliceResult({
      start: '2026-11-11T08:00:00+08:00',
      end: '2026-11-11T09:00:00+08:00',
      source: 'cold',
    }) as unknown as SliceResult;
    mocks.sliceGet.mockResolvedValueOnce({ kind: 'result', result: res });
    await s.open({ start: '2026-11-11T08:00:00+08:00', end: '2026-11-11T09:00:00+08:00', ip: '10.10.112.20' });
    await flushPromises();
    expect(w.text()).toContain('歷史冷歸檔');
    expect(w.text()).toContain('Top 10 排行');
    expect(w.text()).not.toContain('查詢該 IP 當下 PA 即時連線');

    // 4. 202 waiting-job 顯示背景查詢與取消按鈕
    const runningJob: SliceJob = {
      id: 'job-1',
      kind: 'pa-slice',
      status: 'running',
      createdAt: '',
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      result: null,
    };
    mocks.sliceGet.mockResolvedValueOnce({ kind: 'job', job: runningJob });
    mocks.sliceJob.mockResolvedValue(runningJob);
    await s.open({ start: '2026-10-05T08:00:00+08:00', end: '2026-10-05T09:00:00+08:00' });
    await flushPromises();
    expect(w.text()).toContain('查詢較久，已轉為背景查詢');
    expect(w.find('.slice-drawer__scanline').exists()).toBe(true);
    w.unmount();
  });
});

describe('9 個圖表元件與資安跳脫', () => {
  const tf = trafficInsight({ from: '2026-11-05', to: '2026-11-11', now: NOW });
  const th = threatInsight({ from: '2026-11-05', to: '2026-11-11', now: NOW });

  it('GTrendDualAxis、GSankey、GTopBars、GAppShare、GAllowDeny 掛載並轉發 pick;tooltip formatter 跳脫 HTML', async () => {
    const wTrend = mount(GTrendDualAxis, { props: { points: tf.trend, bucketSeconds: tf.bucketSeconds } });
    await flushPromises();
    const wSankey = mount(GSankey, { props: { nodes: tf.sankey.nodes as SankeyNode[], links: tf.sankey.links } });
    await flushPromises();
    const wTopBars = mount(GTopBars, {
      props: { items: [{ ip: '<img src=x onerror=alert(1)>', bytes: 100, sent: 40, recv: 60, sessions: 5 }] },
    });
    await flushPromises();
    const wApp = mount(GAppShare, {
      props: { items: [{ app: '<script>evil()</script>', bytes: 500, sessions: 10 }], mode: 'donut' },
    });
    await flushPromises();
    const wAd = mount(GAllowDeny, { props: { points: tf.allowDeny, bucketSeconds: tf.allowDenyBucketSeconds } });
    await flushPromises();

    expect(mocks.charts.length).toBe(5);
    // 測試 GTopBars tooltip XSS 跳脫
    const topBarsOpt = mocks.charts[2]!.options.at(-1)! as { tooltip: { formatter: (p: unknown) => string } };
    const tipHtml = topBarsOpt.tooltip.formatter([{ dataIndex: 0 }]);
    expect(tipHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(tipHtml).not.toContain('<img');

    // 測試 GAppShare 切換 treemap
    await wApp.setProps({ mode: 'treemap' });
    await flushPromises();
    const appOpt = mocks.charts[3]!.options.at(-1)! as {
      tooltip: { formatter: (p: unknown) => string };
      series: { type: string }[];
    };
    expect(appOpt.series[0]!.type).toBe('treemap');
    expect(appOpt.tooltip.formatter({ name: '<b>app</b>', value: 100, data: { sessions: 2 } })).toContain('&lt;b&gt;app&lt;/b&gt;');

    // 測試 GAllowDeny 點擊阻擋柱時 series = 'deny'
    mocks.charts[4]!.handlers.click!({ seriesName: 'deny', name: tf.allowDeny[0]!.t, value: 10 });
    expect(wAd.emitted('pick')?.[0]?.[0]).toMatchObject({ chart: 'allowDeny', series: 'deny', name: tf.allowDeny[0]!.t });

    wTrend.unmount();
    wSankey.unmount();
    wTopBars.unmount();
    wApp.unmount();
    wAd.unmount();
  });

  it('GSeverityCards、GThreatTimeline、GWorldMap、GTopCompare 正確呈現與觸發 pick', async () => {
    const wSev = mount(GSeverityCards, { props: { score: th.score } });
    expect(wSev.text()).toContain('嚴重');
    expect(wSev.text()).toContain('較前一期');
    await wSev.find('button.is-critical').trigger('click');
    expect(wSev.emitted('pick')?.[0]?.[0]).toEqual({
      chart: 'severity',
      name: 'critical',
      value: th.score.critical,
    });

    const wTl = mount(GThreatTimeline, {
      props: { points: th.timeline, bucketSeconds: th.bucketSeconds },
    });
    const wMap = mount(GWorldMap, {
      props: { countries: th.countries, top: 10 },
      global: { plugins: [ui] },
    });
    const wCmp = mount(GTopCompare, {
      props: {
        left: th.topInternalSrc,
        right: null,
        leftTitle: '發起威脅最多內網 IP',
        rightTitle: '被攻擊最多伺服器',
        notes: th.notes,
      },
      global: { plugins: [ui] },
    });
    await flushCharts();

    // GWorldMap 排行點擊已知國家 → 帶出 data: CountryCount
    await wMap.find('button.g-world-map__row').trigger('click');
    expect(wMap.emitted('pick')?.[0]?.[0]).toMatchObject({
      chart: 'country',
      name: 'CN',
      data: expect.objectContaining({ country: 'China', iso2: 'CN' }),
    });

    // GTopCompare right=null 時顯示伺服器網段尚未設定的說明
    expect(wCmp.text()).toContain('伺服器網段尚未設定');

    wSev.unmount();
    wTl.unmount();
    wMap.unmount();
    wCmp.unmount();
  });
});

// 頁面級測試掛載 10 張以上圖表,全套件冷啟動時可能超過預設 5 秒(Claude 2026-11-12,程式碼審查)
describe('Heatmap.vue 與 Insight.vue 頁面整合', { timeout: 15_000 }, () => {
  it('Heatmap.vue 顯示停用的 AD 指標與提示、處理日視圖 422 超過保留期限、點擊格子開啟 SliceDrawer', async () => {
    const res = heatmapResponse({
      granularity: 'year',
      metric: 'threat',
      date: '2026-11-11',
      now: NOW,
      since: Date.parse('2026-06-01T00:00:00+08:00'),
    });
    mocks.heatmapGet.mockResolvedValue(res);
    mocks.sliceGet.mockResolvedValue({
      kind: 'result',
      result: sliceResult({ start: res.cells.at(-1)!.t, end: res.to }),
    });

    const w = mount(Heatmap, {
      global: { plugins: [ui], stubs: { teleport: true, RouterLink: true } },
    });
    await flushPromises();

    // AD 異常按鈕存在、disabled 且顯示「AD 階段開放」
    const adBtn = w.findAll('.viz-metric-seg__btn').find((b) => b.text().includes('AD 異常'));
    expect(adBtn?.exists()).toBe(true);
    expect(adBtn?.attributes('disabled')).toBeDefined();
    expect(adBtn?.text()).toContain('AD 階段開放');

    // since 之前沒有資料的提示
    expect(w.text()).toContain('此日期前沒有資料');

    // 點擊格子開啟明細抽屜
    const cells = w.findAll('button.g-heatmap__cell');
    await cells.at(-1)!.trigger('click');
    await new Promise((r) => setTimeout(r, 300)); // 單擊延遲 250ms 才 select(等待確認不是雙擊)
    await flushPromises();
    expect(mocks.sliceGet).toHaveBeenCalled();
    expect(w.text()).toContain('即時熱資料');

    // 日視圖超過 1 年回 422 時顯示最早可查日
    mocks.heatmapGet.mockRejectedValueOnce(
      new ApiError(422, 'NETOPS_HEATMAP_OUT_OF_RETENTION', '超過 1 年', 'req-422', { earliest: '2025-11-11' }),
    );
    await w.findAll('.g-seg button').find((b) => b.text() === '日')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('每 5 分鐘資料只保留 1 年，最早可查 2025-11-11');
    w.unmount();
  });

  it('Insight.vue 支援流量 / 威脅 Tab 切換、AD Tab 停用、「看表格」無障礙切換與圖表點擊聯動', async () => {
    mocks.traffic.mockResolvedValue(trafficInsight({ from: '2026-11-05', to: '2026-11-11', now: NOW }));
    mocks.threat.mockResolvedValue(threatInsight({ from: '2026-11-05', to: '2026-11-11', now: NOW }));
    mocks.sliceGet.mockResolvedValue({
      kind: 'result',
      result: sliceResult({ start: '2026-11-11T00:00:00+08:00', end: '2026-11-12T00:00:00+08:00' }),
    });

    const w = mount(Insight, {
      global: { plugins: [ui], stubs: { teleport: true, RouterLink: true } },
    });
    await flushCharts();

    // 初次載入只查流量視角,不預查威脅視角(避免同時佔滿 2 個名額)
    expect(mocks.traffic).toHaveBeenCalledTimes(1);
    expect(mocks.threat).not.toHaveBeenCalled();

    // AD Tab 停用且標示「AD 階段開放」
    const adTab = w.findAll('.viz-tabs__tab').find((b) => b.text().includes('AD 異常'));
    expect(adTab?.attributes('disabled')).toBeDefined();
    expect(adTab?.text()).toContain('AD 階段開放');

    // 切換「看表格」並點擊表格列開啟時段明細
    const tableBtn = w.findAll('button').find((b) => b.text().includes('看表格'))!;
    await tableBtn.trigger('click');
    expect(w.text()).toContain('看圖表');
    await w.find('tbody tr').trigger('click');
    await flushPromises();
    expect(mocks.sliceGet).toHaveBeenCalled();

    // 切換到威脅分析 Tab 才載入威脅資料
    const threatTab = w.findAll('.viz-tabs__tab').find((b) => b.text().includes('威脅分析'))!;
    await threatTab.trigger('click');
    await flushCharts();
    expect(mocks.threat).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain('威脅嚴重度計分卡');
    expect(w.text()).toContain('伺服器網段尚未設定');
    w.unmount();
  });
});
