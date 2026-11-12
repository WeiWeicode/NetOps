/**
 * 分析儀表板的資料(V-b1;VIZ-RULES-DESIGN §6.3、HANDOFF-GEMINI-VIZ §3.3)。
 *   const traffic = useInsight('traffic')            // 或 'threat'
 *   traffic.preset('7d') / traffic.setCustom(from, to)   // 今天 / 7 / 30 / 90 天 / 自訂(≤ 90 天)
 *   traffic.data、traffic.loading、traffic.error、traffic.rangeError(自訂期間不合法的說明)、traffic.refresh()
 * 期間含今天時每 60 秒自動刷新(分頁在背景時 5 倍間隔)。換期間、手動刷新、自動刷新共用同一條請求路徑:
 *   只採用最後一次送出、且期間沒變的回應;換期間時先清掉舊資料(不顯示新期間標籤配舊資料);自動刷新失敗保留舊資料。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { can } from '@/api/gateway';
import { insight, type DateRange, type ThreatInsight, type TrafficInsight } from '@/api/insight';
import { API } from '@/api/perms';
import { HIDDEN_FACTOR } from './usePolling';
import { addDays, spanDays, taipeiDay } from './vizTime';

export type InsightView = 'traffic' | 'threat';
export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'custom';
export const INSIGHT_MAX_DAYS = 90;
export const REFRESH_MS = 60_000;
export const PRESETS: readonly { value: RangePreset; label: string; days?: number }[] = [
  { value: 'today', label: '今天', days: 1 },
  { value: '7d', label: '7 天', days: 7 },
  { value: '30d', label: '30 天', days: 30 },
  { value: '90d', label: '90 天', days: 90 },
  { value: 'custom', label: '自訂' },
];

type DataOf<V extends InsightView> = V extends 'traffic' ? TrafficInsight : ThreatInsight;

export function useInsight<V extends InsightView>(view: V, opts: { preset?: Exclude<RangePreset, 'custom'>; immediate?: boolean; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const today = () => taipeiDay(now());
  const presetOf = (p: Exclude<RangePreset, 'custom'>): DateRange => {
    const days = PRESETS.find((x) => x.value === p)!.days!;
    return { from: addDays(today(), 1 - days), to: today() };
  };
  const activePreset = ref<RangePreset>(opts.preset ?? '7d');
  const range = ref<DateRange>(presetOf(opts.preset ?? '7d')) as Ref<DateRange>;
  const rangeError = ref('');
  const data = shallowRef<DataOf<V> | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  const includesToday = computed(() => range.value.to >= today());

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || !includesToday.value) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    timer = setTimeout(() => void load(true), hidden ? REFRESH_MS * HIDDEN_FACTOR : REFRESH_MS);
  }

  /** background:自動刷新(不顯示載入中、失敗保留舊資料) */
  async function load(background = false): Promise<void> {
    clearTimeout(timer);
    const my = ++seq;
    const r = { ...range.value };
    if (!background) loading.value = true;
    try {
      const res = (await (view === 'traffic' ? insight.traffic(r) : insight.threat(r))) as DataOf<V>;
      if (my !== seq || disposed) return;
      data.value = res;
      error.value = null;
    } catch (e) {
      if (my !== seq || disposed) return;
      error.value = e as Error;
    } finally {
      if (my === seq && !disposed) {
        loading.value = false;
        schedule();
      }
    }
  }

  function preset(p: Exclude<RangePreset, 'custom'>) {
    activePreset.value = p;
    rangeError.value = '';
    range.value = presetOf(p);
  }

  /** 自訂期間:不合法時不查詢,rangeError 說明原因 */
  function setCustom(from: string, to: string): boolean {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const msg = !re.test(from) || !re.test(to) ? '日期格式不正確' : to < from ? '結束日期不可早於開始日期' : to > today() ? '結束日期不可晚於今天' : spanDays(from, to) > INSIGHT_MAX_DAYS ? `期間最長 ${INSIGHT_MAX_DAYS} 天` : '';
    rangeError.value = msg;
    if (msg) return false;
    activePreset.value = 'custom';
    range.value = { from, to };
    return true;
  }

  watch(
    range,
    () => {
      // 換期間:先清掉舊期間的資料與錯誤
      data.value = null;
      error.value = null;
      void load();
    },
    // sync:換期間的當下就清掉舊資料(畫面不會有一個 tick 顯示新期間標籤配舊資料)
    { immediate: opts.immediate !== false, flush: 'sync' },
  );

  if (getCurrentScope())
    onScopeDispose(() => {
      disposed = true;
      seq++;
      clearTimeout(timer);
    });

  /** 點圖表開時段明細需要 Log 明細權限(頁面只要 netops.pa.read;和 useHeatmap.canSlice 同一個判斷) */
  const canSlice = computed(() => can(API.paLogRead));
  return { view, range, activePreset, presets: PRESETS, rangeError, data, loading, error, includesToday, canSlice, preset, setCustom, refresh: () => load() };
}
