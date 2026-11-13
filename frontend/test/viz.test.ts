/**
 * V-b1 熱力圖 / 儀表板 / 時段明細的前端邏輯層(VIZ-RULES-DESIGN §6.3、§8):
 *   useHeatmap(null 與 0、下鑽、前後期、AD 停用、權限)、useSlice(200、202 → 輪詢、429 倒數、409 學 hotFrom、明細查詢連結)、
 *   useChartPick(點擊 → 時段明細條件)、useInsight(期間預設與自訂驗證)、假資料產生器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { ApiError } from '@/api/gateway';
import type { HeatmapResponse } from '@/api/heatmap';
import type { SliceJob, SliceResult } from '@/api/slice';
import { toSliceQuery } from '@/composables/useChartPick';
import { useHeatmap } from '@/composables/useHeatmap';
import { useInsight } from '@/composables/useInsight';
import { useSlice } from '@/composables/useSlice';
import { formatRange } from '@/composables/vizTime';
import { heatmapResponse, sliceResult, threatInsight, trafficInsight } from '../mock/fixtures/viz';

const mocks = vi.hoisted(() => ({
  heatmapGet: vi.fn(),
  sliceGet: vi.fn(),
  sliceJob: vi.fn(),
  sliceCancel: vi.fn(),
  traffic: vi.fn(),
  threat: vi.fn(),
  perms: new Set<string>(['netops.pa-log.read']),
}));
vi.mock('@/api/heatmap', () => ({ heatmap: { get: mocks.heatmapGet } }));
vi.mock('@/api/slice', () => ({ slice: { get: mocks.sliceGet, job: mocks.sliceJob, cancel: mocks.sliceCancel } }));
vi.mock('@/api/insight', () => ({ insight: { traffic: mocks.traffic, threat: mocks.threat } }));
vi.mock('@/api/gateway', async (orig) => ({ ...(await orig<typeof import('@/api/gateway')>()), can: (c: string) => mocks.perms.has(c) }));

// 2026-11-11(週三)10:07:30 台灣時間
const NOW = Date.parse('2026-11-11T10:07:30+08:00');
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};

beforeEach(() => {
  for (const f of [mocks.heatmapGet, mocks.sliceGet, mocks.sliceJob, mocks.sliceCancel, mocks.traffic, mocks.threat]) f.mockReset();
  mocks.sliceCancel.mockResolvedValue(undefined);
  mocks.perms = new Set(['netops.pa-log.read']);
});
afterEach(() => vi.useRealTimers());

describe('假資料產生器', () => {
  it('年 / 月 / 日格數、資料起點之前 v = null、威脅分級', () => {
    const y = heatmapResponse({ granularity: 'year', metric: 'threat', date: '2026-11-11', now: NOW });
    expect(y.cells.length).toBe(53 * 7 - 4);
    const m = heatmapResponse({ granularity: 'month', metric: 'traffic', date: '2026-10-05', now: NOW });
    expect(m.cells.length).toBe(31 * 24);
    const d = heatmapResponse({ granularity: 'day', metric: 'deny', date: '2026-11-10', now: NOW, since: Date.parse('2026-11-10T12:00:00+08:00') });
    expect(d.cells.length).toBe(288);
    expect(d.cells[0]!.v).toBeNull();
    expect(d.cells[200]!.v).not.toBeNull();
    expect(y.cells.every((c) => c.level >= 0 && c.level <= 4)).toBe(true);
    expect(trafficInsight({ from: '2026-11-10', to: '2026-11-11', now: NOW }).bucketSeconds).toBe(300);
    expect(threatInsight({ from: '2026-10-01', to: '2026-11-11', now: NOW }).bucketSeconds).toBe(86400);
  });
});

describe('useHeatmap', () => {
  const setup = (opts = {}) => {
    const scope = effectScope();
    const h = scope.run(() => useHeatmap({ now: () => NOW, ...opts }))!;
    return { h, scope };
  };

  it('預設年視圖、威脅、今天;回應的 null 與 0 原樣交給畫面', async () => {
    const r = heatmapResponse({ granularity: 'year', metric: 'threat', date: '2026-11-11', now: NOW, since: Date.parse('2026-06-01T00:00:00+08:00') });
    mocks.heatmapGet.mockResolvedValue(r as HeatmapResponse);
    const { h } = setup();
    await flush();
    expect(mocks.heatmapGet).toHaveBeenCalledWith({ granularity: 'year', metric: 'threat', date: '2026-11-11' });
    expect(h.cells.value[0]!.v).toBeNull();
    expect(h.cells.value.at(-1)!.v).not.toBeNull();
    expect(h.loading.value).toBe(false);
  });

  it('切換粒度 / 指標 / 日期自動重查;舊回應丟棄', async () => {
    let resolveOld!: (v: unknown) => void;
    mocks.heatmapGet.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    const newer = heatmapResponse({ granularity: 'month', metric: 'threat', date: '2026-11-11', now: NOW });
    mocks.heatmapGet.mockResolvedValueOnce(newer);
    const { h } = setup();
    h.granularity.value = 'month';
    await flush();
    resolveOld(heatmapResponse({ granularity: 'year', metric: 'threat', date: '2026-11-11', now: NOW }));
    await flush();
    expect(h.data.value?.granularity).toBe('month');
  });

  it('AD 指標停用:不呼叫 API、error 說明', async () => {
    mocks.heatmapGet.mockResolvedValue(heatmapResponse({ granularity: 'year', metric: 'threat', date: '2026-11-11', now: NOW }));
    const { h } = setup();
    await flush();
    mocks.heatmapGet.mockClear();
    h.metric.value = 'ad';
    await flush();
    expect(mocks.heatmapGet).not.toHaveBeenCalled();
    expect(h.error.value?.message).toContain('AD');
    expect(h.metricOptions.find((m) => m.value === 'ad')?.disabled).toBe(true);
  });

  it('下鑽:年 / 月格 → 日視圖;超過 1 年不下鑽;日格不下鑽;前後期不超過今天', async () => {
    mocks.heatmapGet.mockResolvedValue(heatmapResponse({ granularity: 'year', metric: 'threat', date: '2026-11-11', now: NOW }));
    const { h } = setup();
    await flush();
    const cell = { t: '2026-10-03T00:00:00+08:00' } as never;
    expect(h.drill(cell)).toBe(true);
    expect([h.granularity.value, h.date.value]).toEqual(['day', '2026-10-03']);
    expect(h.drill(cell)).toBe(false);
    h.granularity.value = 'month';
    expect(h.drill({ t: '2025-11-10T08:00:00+08:00' } as never)).toBe(false);
    h.date.value = '2026-11-01';
    h.next();
    expect(h.date.value).toBe('2026-11-11');
    expect(h.canNext.value).toBe(false);
    h.prev();
    expect(h.date.value).toBe('2026-10-11');
  });

  it('格子 → 時段明細條件:威脅查威脅類、阻擋數只看非 allow;權限', async () => {
    mocks.heatmapGet.mockResolvedValue(heatmapResponse({ granularity: 'month', metric: 'deny', date: '2026-11-11', now: NOW }));
    const { h } = setup({ granularity: 'month', metric: 'deny' });
    await flush();
    expect(h.sliceQuery({ t: '2026-11-11T08:00:00+08:00' } as never)).toEqual({ start: '2026-11-11T08:00:00+08:00', end: '2026-11-11T09:00:00+08:00', type: 'traffic', action: 'block' });
    expect(h.canSlice.value).toBe(true);
    mocks.perms = new Set();
    const { h: h2 } = setup({ immediate: false });
    expect(h2.canSlice.value).toBe(false);
  });
});

describe('useSlice', () => {
  const q = { start: '2026-11-11T08:00:00+08:00', end: '2026-11-11T09:00:00+08:00' };
  const setup = () => {
    const scope = effectScope();
    const s = scope.run(() => useSlice({ now: () => NOW, pollMs: 1000 }))!;
    return { s, scope };
  };
  const result = sliceResult({ ...q }) as unknown as SliceResult;
  const job = (status: SliceJob['status'], r: SliceResult | null = null): SliceJob => ({ id: 'j1', kind: 'pa-slice', status, createdAt: '', startedAt: null, finishedAt: null, progress: null, error: null, result: r });

  it('200:直接 done,source 與明細查詢連結(to 含該分鐘)', async () => {
    mocks.sliceGet.mockResolvedValue({ kind: 'result', result });
    const { s } = setup();
    await s.open({ ...q, ip: '10.0.0.1', dport: 443 });
    expect(s.state.value).toBe('done');
    expect(s.source.value).toBe('hot');
    expect(s.searchLink.value).toEqual({ path: '/firewall/search', query: { from: '2026-11-11T08:00', to: '2026-11-11T08:59', ip: '10.0.0.1', port: '443' } });
  });

  it('202:waiting-job → 輪詢到 done;離開時取消', async () => {
    vi.useFakeTimers();
    mocks.sliceGet.mockResolvedValue({ kind: 'job', job: job('running') });
    mocks.sliceJob.mockResolvedValueOnce(job('running')).mockResolvedValueOnce(job('done', result));
    const { s, scope } = setup();
    await s.open(q);
    expect(s.state.value).toBe('waiting-job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.state.value).toBe('waiting-job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.state.value).toBe('done');
    expect(s.result.value?.summary.sessions).toBe(result.summary.sessions);
    // 另開一個進行中的工作後離開頁面 → 取消
    mocks.sliceGet.mockResolvedValue({ kind: 'job', job: { ...job('running'), id: 'j2' } });
    mocks.sliceJob.mockResolvedValue({ ...job('running'), id: 'j2' });
    await s.open(q);
    scope.stop();
    await flush();
    expect(mocks.sliceCancel).toHaveBeenCalledWith('j2');
  });

  it('429:busy 並每秒倒數,倒數中 retry 不送出,到 0 後重試', async () => {
    vi.useFakeTimers();
    mocks.sliceGet.mockRejectedValueOnce(new ApiError(429, 'NETOPS_COLD_QUERY_BUSY', '忙碌', 'r1', { retryAfter: 3 }));
    const { s } = setup();
    await s.open(q);
    expect(s.state.value).toBe('busy');
    expect(s.retryAfter.value).toBe(3);
    await s.retry();
    expect(mocks.sliceGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.retryAfter.value).toBe(0);
    mocks.sliceGet.mockResolvedValueOnce({ kind: 'result', result });
    await s.retry();
    expect(s.state.value).toBe('done');
  });

  it('409 冷歸檔未提供:error(中性提示)並學到熱 / 冷分界;isCold 依時間判斷', async () => {
    const hotFrom = '2026-11-09T00:00:00+08:00';
    mocks.sliceGet.mockRejectedValueOnce(new ApiError(409, 'NETOPS_COLD_ARCHIVE_DISABLED', '冷歸檔尚未提供', 'r2', { hotFrom }));
    const { s } = setup();
    await s.open({ start: '2026-11-08T08:00:00+08:00', end: '2026-11-08T09:00:00+08:00' });
    expect(s.state.value).toBe('error');
    expect((s.error.value as ApiError).code).toBe('NETOPS_COLD_ARCHIVE_DISABLED');
    expect(s.isCold.value).toBe(true);
    mocks.sliceGet.mockResolvedValueOnce({ kind: 'result', result });
    await s.open({ start: '2026-11-09T08:00:00+08:00', end: '2026-11-09T09:00:00+08:00' });
    expect(s.isCold.value).toBe(false);
  });

  it('威脅類沒有明細查詢連結;close 清空', async () => {
    mocks.sliceGet.mockResolvedValue({ kind: 'result', result });
    const { s } = setup();
    await s.open({ ...q, type: 'threat' });
    expect(s.searchLink.value).toBeNull();
    await s.close();
    expect(s.state.value).toBe('idle');
  });
});

describe('useChartPick', () => {
  const range = { from: '2026-11-05', to: '2026-11-11' };
  it('時間類:被點的格子;Allow / Deny 的 deny、威脅時序的嚴重度帶條件', () => {
    expect(toSliceQuery({ chart: 'trend', name: '2026-11-10T08:00:00+08:00' }, range, { bucketSeconds: 3600 })).toEqual({ start: '2026-11-10T08:00:00+08:00', end: '2026-11-10T09:00:00+08:00', type: 'traffic' });
    expect(toSliceQuery({ chart: 'allowDeny', series: 'deny', name: '2026-11-10T00:00:00+08:00' }, range, { bucketSeconds: 3600, allowDenyBucketSeconds: 86400 })).toEqual({ start: '2026-11-10T00:00:00+08:00', end: '2026-11-11T00:00:00+08:00', type: 'traffic', action: 'block' });
    expect(toSliceQuery({ chart: 'timeline', series: 'high', name: '2026-11-10T00:00:00+08:00' }, range, { bucketSeconds: 86400 })).toMatchObject({ type: 'threat', severity: 'high' });
    expect(toSliceQuery({ chart: 'trend', name: 'x' }, range, { bucketSeconds: 3600 })).toBeNull();
  });

  it('其他圖表:期間最後一天 + 條件;桑基連線兩端;「其他」App 與未知國家不帶條件', () => {
    const day = { start: '2026-11-11T00:00:00+08:00', end: '2026-11-12T00:00:00+08:00' };
    expect(toSliceQuery({ chart: 'topIp', name: '10.0.0.1' }, range)).toEqual({ ...day, type: 'traffic', src: '10.0.0.1', sort: 'bytes' });
    expect(toSliceQuery({ chart: 'sankey', name: 'z:trust>a:ssl', data: { source: 'z:trust', target: 'a:ssl' } }, range)).toEqual({ ...day, type: 'traffic', sort: 'bytes', fromZone: 'trust', app: 'ssl' });
    expect(toSliceQuery({ chart: 'sankey', name: 'a:x>y', data: { source: 'a:x>y', target: 'd:未知' } }, range)).toEqual({ ...day, type: 'traffic', sort: 'bytes', app: 'x>y' });
    expect(toSliceQuery({ chart: 'sankey', name: 'z:dmz' }, range)).toEqual({ ...day, type: 'traffic', sort: 'bytes', fromZone: 'dmz' });
    expect(toSliceQuery({ chart: 'sankey', name: 'a:其他' }, range)).toEqual({ ...day, type: 'traffic', sort: 'bytes' });
    expect(toSliceQuery({ chart: 'country', name: 'CN', data: { country: 'China', iso2: 'CN' } }, range)).toEqual({ ...day, type: 'threat', country: 'China' });
    expect(toSliceQuery({ chart: 'country', name: '', data: { country: '未知', iso2: null } }, range)).toBeNull();
    expect(toSliceQuery({ chart: 'topNames', name: 'X(1)' }, range)).toMatchObject({ type: 'threat', threatName: 'X(1)' });
    expect(toSliceQuery({ chart: 'severity', name: 'critical' }, range)).toMatchObject({ type: 'threat', severity: 'critical' });
    expect(toSliceQuery({ chart: 'unknown', name: 'x' }, range)).toBeNull();
  });
});

describe('useInsight', () => {
  it('預設 7 天;換預設期間重查;自訂期間驗證(≤ 90 天、不晚於今天)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.traffic.mockImplementation(async (r) => trafficInsight({ ...r, now: NOW }));
    const scope = effectScope();
    const t = scope.run(() => useInsight('traffic', { now: () => NOW }))!;
    await flush();
    expect(mocks.traffic).toHaveBeenLastCalledWith({ from: '2026-11-05', to: '2026-11-11' });
    expect(t.data.value?.view).toBe('traffic');
    expect(t.includesToday.value).toBe(true);
    t.preset('90d');
    await flush();
    expect(mocks.traffic).toHaveBeenLastCalledWith({ from: '2026-08-14', to: '2026-11-11' });
    expect(t.setCustom('2026-08-13', '2026-11-11')).toBe(false);
    expect(t.rangeError.value).toContain('90');
    expect(t.setCustom('2026-11-01', '2026-11-12')).toBe(false);
    expect(t.setCustom('2026-11-03', '2026-11-01')).toBe(false);
    expect(t.setCustom('2026-10-01', '2026-10-31')).toBe(true);
    await flush();
    expect(t.activePreset.value).toBe('custom');
    expect(t.includesToday.value).toBe(false);
    scope.stop();
  });
});

describe('useInsight 請求順序(程式碼審查 V-b1 #1)', () => {
  it('換期間時清掉舊資料;舊期間較晚回來的回應丟棄;含今天時 60 秒後背景刷新', async () => {
    vi.useFakeTimers();
    let resolveOld!: (v: unknown) => void;
    mocks.traffic.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    mocks.traffic.mockImplementation(async (r) => trafficInsight({ ...r, now: NOW }));
    const scope = effectScope();
    const t = scope.run(() => useInsight('traffic', { now: () => NOW }))!;
    t.preset('30d');
    await flush();
    expect(t.data.value?.from).toBe('2026-10-13');
    resolveOld(trafficInsight({ from: '2026-11-05', to: '2026-11-11', now: NOW }));
    await flush();
    expect(t.data.value?.from).toBe('2026-10-13');
    const calls = mocks.traffic.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.traffic.mock.calls.length).toBe(calls + 1);
    expect(t.loading.value).toBe(false);
    t.setCustom('2026-10-01', '2026-10-31');
    expect(t.data.value).toBeNull();
    await flush();
    const after = mocks.traffic.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.traffic.mock.calls.length).toBe(after);
    scope.stop();
  });
});

describe('formatRange', () => {
  it('同一天、整天、跨午夜', () => {
    expect(formatRange('2026-11-11T08:00:00+08:00', '2026-11-11T09:00:00+08:00')).toBe('2026-11-11 08:00–09:00');
    expect(formatRange('2026-11-11T00:00:00+08:00', '2026-11-12T00:00:00+08:00')).toBe('2026-11-11');
    expect(formatRange('2026-11-11T23:55:00+08:00', '2026-11-12T00:00:00+08:00')).toBe('2026-11-11 23:55–24:00');
  });
});
