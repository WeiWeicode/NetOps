/**
 * 分析儀表板的資料(V-b1;VIZ-RULES-DESIGN §6.3、HANDOFF-GEMINI-VIZ §3.3)。
 *   const traffic = useInsight('traffic')            // 或 'threat'
 *   traffic.preset('7d') / traffic.setCustom(from, to)   // 今天 / 7 / 30 / 90 天 / 自訂(≤ 90 天)
 *   traffic.data、traffic.loading、traffic.error、traffic.rangeError(自訂期間不合法的說明)、traffic.refresh()
 * 期間含今天時每 60 秒自動刷新(分頁在背景時放慢,usePolling);換期間時舊回應丟棄。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { insight, type DateRange, type ThreatInsight, type TrafficInsight } from '@/api/insight';
import { usePolling } from './usePolling';
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
  let seq = 0;

  const includesToday = computed(() => range.value.to >= today());

  async function load(): Promise<DataOf<V>> {
    return (view === 'traffic' ? insight.traffic(range.value) : insight.threat(range.value)) as Promise<DataOf<V>>;
  }

  async function refresh(): Promise<void> {
    const my = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const r = await load();
      if (my === seq) data.value = r;
    } catch (e) {
      if (my === seq) error.value = e as Error;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  // 含今天時每 60 秒背景刷新(不顯示載入中;失敗保留舊資料並顯示錯誤)
  const poll = usePolling(
    () => load(),
    (r) => {
      if (r instanceof Error) error.value = r;
      else {
        data.value = r;
        error.value = null;
      }
      return includesToday.value;
    },
    REFRESH_MS,
  );

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
    async () => {
      await refresh();
      if (includesToday.value) setTimeoutPoll();
    },
    { immediate: opts.immediate !== false },
  );
  /** 下一輪自動刷新排在 60 秒後(usePolling.run 會立即查一次,這裡延後) */
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function setTimeoutPoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void poll.run(), REFRESH_MS);
  }
  if (getCurrentScope()) onScopeDispose(() => clearTimeout(pollTimer));

  return { view, range, activePreset, presets: PRESETS, rangeError, data, loading, error, includesToday, preset, setCustom, refresh };
}
