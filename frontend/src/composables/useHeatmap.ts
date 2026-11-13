/**
 * 活動熱力圖頁的狀態(V-b1;VIZ-RULES-DESIGN §6.3、HANDOFF-GEMINI-VIZ §3.1)。頁面只用這裡,不直接呼叫 api/heatmap。
 *   const h = useHeatmap()
 *   h.granularity / h.metric / h.date(可寫的 ref;改了自動重查)、h.data、h.cells、h.loading、h.error
 *   h.prev() / h.next():前後一期(年 1 年、月 1 個月、日 1 天;不超過今天)
 *   h.drill(cell):年 / 月的格子 → 那一天的日視圖;日格不下鑽
 *   h.sliceQuery(cell):格子 → 時段明細條件(給 useSlice.open)
 *   h.metricOptions:ad 為 disabled(AD 階段開放)
 * 錯誤:ApiError;日視圖超過 1 年是 NETOPS_HEATMAP_OUT_OF_RETENTION(details.earliest),retention.dayEarliest 可先擋。
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { can } from '@/api/gateway';
import { heatmap, type HeatCell, type HeatGranularity, type HeatMetric, type HeatmapResponse, type PaHeatMetric } from '@/api/heatmap';
import { API } from '@/api/perms';
import type { SliceQuery } from '@/api/slice';
import { addDays, addMonths, plusSeconds, taipeiDay } from './vizTime';

export const METRIC_OPTIONS: readonly { value: HeatMetric; label: string; disabled?: boolean; hint?: string }[] = [
  { value: 'threat', label: '威脅等級' },
  { value: 'traffic', label: '總流量' },
  { value: 'deny', label: '阻擋數' },
  { value: 'ad', label: 'AD 異常', disabled: true, hint: 'AD 階段開放' },
];
export const GRANULARITY_OPTIONS: readonly { value: HeatGranularity; label: string }[] = [
  { value: 'year', label: '年' },
  { value: 'month', label: '月' },
  { value: 'day', label: '日' },
];
/** 日視圖(每 5 分鐘)只保留 1 年(V1) */
export const DAY_VIEW_DAYS = 365;

export interface UseHeatmapOptions {
  granularity?: HeatGranularity;
  metric?: HeatMetric;
  date?: string;
  /** false:不自動查詢(測試用) */
  immediate?: boolean;
  /** 「現在」(測試用) */
  now?: () => number;
}

export function useHeatmap(opts: UseHeatmapOptions = {}) {
  const now = opts.now ?? Date.now;
  const today = () => taipeiDay(now());
  const granularity = ref<HeatGranularity>(opts.granularity ?? 'year');
  const metric = ref<HeatMetric>(opts.metric ?? 'threat');
  const date = ref<string>(opts.date ?? today());
  const data = shallowRef<HeatmapResponse | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  let seq = 0;

  const retention = computed(() => ({ dayEarliest: addDays(today(), -DAY_VIEW_DAYS) }));
  const cells = computed<HeatCell[]>(() => data.value?.cells ?? []);
  /** 點格子開明細要 netops.pa-log.read(畫面節點 netops.pa-heatmap.read 已 includes) */
  const canSlice = computed(() => can(API.paLogRead));

  async function refresh(): Promise<void> {
    const my = ++seq;
    if (metric.value === 'ad') {
      data.value = null;
      loading.value = false;
      error.value = new Error('AD 異常指標在 AD 階段開放');
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const r = await heatmap.get({ granularity: granularity.value, metric: metric.value as PaHeatMetric, date: date.value });
      if (my === seq) data.value = r;
    } catch (e) {
      if (my === seq) {
        data.value = null;
        error.value = e as Error;
      }
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  const shift = (n: number) => {
    const d = granularity.value === 'year' ? addMonths(date.value, 12 * n) : granularity.value === 'month' ? addMonths(date.value, n) : addDays(date.value, n);
    date.value = d > today() ? today() : d;
  };
  const canNext = computed(() => date.value < today());

  /** 年 / 月的格子 → 那一天的日視圖(超過 1 年的日視圖不下鑽) */
  function drill(cell: HeatCell): boolean {
    if (granularity.value === 'day') return false;
    const d = taipeiDay(Date.parse(cell.t));
    if (d < retention.value.dayEarliest) return false;
    date.value = d;
    granularity.value = 'day';
    return true;
  }

  /** 格子 → 時段明細條件(威脅指標查威脅類;阻擋數只看非 allow;其他查 TRAFFIC) */
  function sliceQuery(cell: HeatCell): SliceQuery {
    const sec = data.value?.bucketSeconds ?? (granularity.value === 'year' ? 86400 : granularity.value === 'month' ? 3600 : 300);
    const q: SliceQuery = { start: cell.t, end: plusSeconds(cell.t, sec), type: metric.value === 'threat' ? 'threat' : 'traffic' };
    if (metric.value === 'deny') q.action = 'block';
    return q;
  }

  watch([granularity, metric, date], () => void refresh(), { immediate: opts.immediate !== false });

  return {
    granularity,
    metric,
    date,
    data,
    cells,
    loading,
    error,
    retention,
    metricOptions: METRIC_OPTIONS,
    granularityOptions: GRANULARITY_OPTIONS,
    canSlice,
    canNext,
    prev: () => shift(-1),
    next: () => shift(1),
    drill,
    sliceQuery,
    refresh,
  };
}
