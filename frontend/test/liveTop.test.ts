// @vitest-environment happy-dom
/** 戰情室即時排行(useLiveTop + RankingDrawer;需求方 2026-11-17 加回舊頁排行卡) */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { PaLiveTop } from '@/api/paLive';
import RankingDrawer from '@/components/warroom/RankingDrawer.vue';
import { kpiListsOf, TOP_POLL_MS, topListsOf, useLiveTop } from '@/composables/useLiveTop';
import ui from '@/ui';

const mocks = vi.hoisted(() => ({ top: vi.fn() }));
vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return { ...real, paLive: { ...real.paLive, top: mocks.top } };
});

const sample = (over: Partial<PaLiveTop> = {}): PaLiveTop => ({
  type: 'traffic',
  minutes: 15,
  totals: { count: 120, bytes: 2048 },
  kpis: { action: { allow: 100, deny: 20 } },
  tops: { src: [{ key: '10.0.0.1', value: 50 }], dstBytes: [{ key: '10.0.0.2', value: 4096 }], app: [] },
  perMinute: [],
  retentionSec: 3600,
  ...over,
});

describe('topListsOf / kpiListsOf', () => {
  it('略過空的維度、Bytes 維度依流量、KPI 由大到小', () => {
    const lists = topListsOf(sample());
    expect(lists.map((l) => l.dim)).toEqual(['src', 'dstBytes']);
    expect(lists[0]).toMatchObject({ title: '來源 IP', byBytes: false, items: [{ key: '10.0.0.1', n: 50 }] });
    expect(lists[1]).toMatchObject({ byBytes: true, items: [{ key: '10.0.0.2', n: 0, bytes: 4096 }] });
    expect(kpiListsOf(sample())[0]).toEqual({ key: 'action', title: 'Action', items: [['allow', 100], ['deny', 20]] });
    expect(topListsOf(null)).toEqual([]);
  });
});

describe('useLiveTop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.top.mockReset();
    mocks.top.mockResolvedValue(sample());
  });
  afterEach(() => vi.useRealTimers());

  it('面板關閉不查詢;開啟才查並每 30 秒更新;關閉後停止', async () => {
    const active = ref(false);
    const scope = effectScope();
    const t = scope.run(() => useLiveTop({ active, mock: false }))!;
    await vi.advanceTimersByTimeAsync(TOP_POLL_MS * 2);
    expect(mocks.top).not.toHaveBeenCalled();
    active.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.top).toHaveBeenCalledWith('traffic', 15, 10);
    expect(t.lists.value).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(TOP_POLL_MS);
    expect(mocks.top).toHaveBeenCalledTimes(2);
    active.value = false;
    await vi.advanceTimersByTimeAsync(TOP_POLL_MS * 3);
    expect(mocks.top).toHaveBeenCalledTimes(3); // 關閉前已排的那一輪跑完後不再排
    scope.stop();
  });

  it('切換類型與分鐘數:清掉舊結果並重查;錯誤保留在 error', async () => {
    const active = ref(true);
    const scope = effectScope();
    const t = scope.run(() => useLiveTop({ active, mock: false }))!;
    await vi.advanceTimersByTimeAsync(0);
    mocks.top.mockRejectedValueOnce(new Error('boom'));
    t.minutes.value = 60;
    await nextTick();
    expect(t.top.value).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.top).toHaveBeenLastCalledWith('traffic', 60, 10);
    expect(t.error.value?.message).toBe('boom');
    t.type.value = 'threat';
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.top).toHaveBeenLastCalledWith('threat', 60, 10);
    expect(t.error.value).toBeNull();
    scope.stop();
  });
});

describe('RankingDrawer.vue', () => {
  const base = {
    modelValue: true,
    type: 'traffic' as const,
    minutes: 15 as const,
    error: null,
    loading: false,
    source: { live: true, empty: '', stale: '接收停止' },
  };
  const g = { global: { plugins: [ui], stubs: { teleport: true } } };

  it('顯示總數、KPI 與排行;切換分鐘數發出 update:minutes', async () => {
    const top = sample();
    const w = mount(RankingDrawer, { props: { ...base, top, lists: topListsOf(top), kpis: kpiListsOf(top) }, ...g });
    await flushPromises();
    expect(w.text()).toContain('最近 15 分鐘');
    expect(w.text()).toContain('來源 IP');
    expect(w.text()).toContain('deny');
    const btn = w.findAll('button').find((b) => b.text().includes('60 分鐘'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    expect(w.emitted('update:minutes')?.[0]).toEqual([60]);
    w.unmount();
  });

  it('沒有來源時說明「沒有 log 來源」,不寫成沒有資料', async () => {
    const top = sample({ tops: {}, kpis: {} });
    const w = mount(RankingDrawer, { props: { ...base, top, lists: [], kpis: [], source: { live: false, empty: '接收端點未啟用', stale: '' } }, ...g });
    await flushPromises();
    expect(w.text()).toContain('沒有 log 來源');
    expect(w.text()).not.toContain('這段期間沒有資料');
    w.unmount();
  });
});
