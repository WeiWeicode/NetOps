/**
 * AC5 熱力圖「AI 指出異常格」:從熱力圖格子挑出異常時段(純函式;IMPL-PLAN AC5 ②)。
 *   月視圖最多 744 格、日視圖 288 格、年視圖 371 格,不全送給模型:只送整體統計與前幾名異常格。
 * 做法(穩健統計,不受少數極端值影響):
 *   - 基準:中位數與 MAD(中位數絕對偏差);月視圖依「一天中的同一個小時」分組比較(上班 / 下班時段量本來就不同),
 *     年視圖依平日 / 假日分組,日視圖整天一組;同組有資料的格子少於 MIN_GROUP 時改用整段
 *   - 偏離程度 z = (值 − 基準中位數) ÷ 尺度;尺度 = max(1.4826 × MAD, 基準中位數的 10%, 整段非 0 平均的 5%),避免 MAD 為 0 時每格都異常
 *   - 異常高:z ≥ Z_MIN 且高於整段中位數;威脅指標另外把有嚴重 / 高風險的格子列為異常(依嚴重、高的筆數排序)
 *   - 異常低(只有流量):z ≤ −Z_MIN 且基準中位數 > 0(可能斷線或資料缺漏);最後一格可能還在累積,不列
 *   - 沒有資料的格子(v = null)不是 0,不參與計算,只列數量(AGENT.md §5)
 */
import { isoTaipei, type HeatCell } from '../../pa-heat/heat.js';

export type HeatGranularity = 'year' | 'month' | 'day';
export type HeatMetric = 'traffic' | 'deny' | 'threat';

/** 熱力圖回應(GET /pa/heatmap,service.heatmap 的結果)中 AI 用到的部分 */
export interface HeatmapForAi {
  granularity: HeatGranularity;
  metric: HeatMetric;
  date: string;
  from: string;
  to: string;
  bucketSeconds: number;
  coverage: { since: string | null; gaps: { from: string; to: string; reason: string }[]; gapsKnown: boolean };
  cells: HeatCell[];
}

export interface AnomalyCell {
  /** 格子開始(ISO +08:00) */
  t: string;
  /** 格子結束 */
  end: string;
  v: number;
  level: number;
  /** high:異常高;low:異常低;severity:有嚴重 / 高風險威脅 */
  kind: 'high' | 'low' | 'severity';
  /** 偏離程度(基準的尺度倍數;四捨五入到 0.1) */
  z: number;
  /** 基準(同組中位數) */
  baseline: number;
  /** 值 ÷ 基準;基準為 0 時 null */
  ratio: number | null;
  /** 下班時間(平日 08:00–19:00 以外)或週末;年視圖只看週末 */
  offHours: boolean;
  partial: boolean;
  tip: HeatCell['tip'];
}

export interface HeatStats {
  cells: number;
  withData: number;
  nulls: number;
  partial: number;
  sum: number;
  mean: number;
  median: number;
  p90: number;
  max: { t: string; v: number } | null;
  /** 各等級(0–4)的格數(只算有資料的格子) */
  levels: [number, number, number, number, number];
  /** 比較基準 */
  baseline: 'hour-of-day' | 'weekday' | 'all';
}

/** 送給模型的異常高最多幾格 */
export const ANOMALY_MAX = 10;
/** 異常低最多幾格 */
export const LOW_MAX = 3;
/** 偏離門檻 */
export const Z_MIN = 3.5;
/** 分組基準至少要幾格有資料 */
export const MIN_GROUP = 8;

/** 由小到大排序後的分位數(線性內插) */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const median = (values: number[]) => quantile([...values].sort((a, b) => a - b), 0.5);

/** ISO +08:00 → 台灣時間的小時與星期(0 = 週日);字串直接取,不受執行環境時區影響 */
export function localParts(t: string): { hour: number; dow: number } {
  const hour = Number(t.slice(11, 13)) || 0;
  const dow = new Date(`${t.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return { hour, dow };
}
const isWeekend = (dow: number) => dow === 0 || dow === 6;
export function offHoursOf(t: string, granularity: HeatGranularity): boolean {
  const { hour, dow } = localParts(t);
  if (isWeekend(dow)) return true;
  return granularity !== 'year' && (hour < 8 || hour >= 19);
}

/** 分組鍵:月視圖 = 小時;年視圖 = 平日 / 假日;日視圖 = 整天一組 */
function groupOf(t: string, g: HeatGranularity): string {
  if (g === 'month') return `h${localParts(t).hour}`;
  if (g === 'year') return isWeekend(localParts(t).dow) ? 'weekend' : 'weekday';
  return 'all';
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function pickHeatAnomalies(d: HeatmapForAi): { stats: HeatStats; anomalies: AnomalyCell[]; lows: AnomalyCell[] } {
  const cells = d.cells;
  const bucketMs = d.bucketSeconds * 1000;
  const has = cells.filter((c): c is HeatCell & { v: number } => c.v !== null);
  const values = has.map((c) => c.v).sort((a, b) => a - b);
  const sum = values.reduce((s, v) => s + v, 0);
  const levels: HeatStats['levels'] = [0, 0, 0, 0, 0];
  for (const c of has) levels[Math.min(4, Math.max(0, c.level))]!++;
  const maxCell = has.reduce<(typeof has)[number] | null>((m, c) => (!m || c.v > m.v ? c : m), null);
  const globalMedian = quantile(values, 0.5);
  const positives = values.filter((v) => v > 0);
  const positiveMean = positives.length ? positives.reduce((s, v) => s + v, 0) / positives.length : 0;

  // 分組基準
  const groups = new Map<string, number[]>();
  for (const c of has) {
    const k = groupOf(c.t, d.granularity);
    groups.set(k, [...(groups.get(k) ?? []), c.v]);
  }
  const grouped = d.granularity !== 'day' && [...groups.values()].every((g) => g.length >= MIN_GROUP);
  const baseOf = new Map<string, { med: number; scale: number }>();
  const baseFor = (vals: number[]) => {
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    return { med, scale: Math.max(1.4826 * mad, 0.1 * med, 0.05 * positiveMean, Number.EPSILON) };
  };
  const all = baseFor(values);
  if (grouped) for (const [k, vals] of groups) baseOf.set(k, baseFor(vals));
  const base = (t: string) => (grouped ? baseOf.get(groupOf(t, d.granularity))! : all);

  const toAnomaly = (c: HeatCell & { v: number }, kind: AnomalyCell['kind']): AnomalyCell => {
    const b = base(c.t);
    return {
      t: c.t,
      end: isoTaipei(Date.parse(c.t) + bucketMs),
      v: c.v,
      level: c.level,
      kind,
      z: round1((c.v - b.med) / b.scale),
      baseline: b.med,
      ratio: b.med > 0 ? round1(c.v / b.med) : null,
      offHours: offHoursOf(c.t, d.granularity),
      partial: c.partial,
      tip: c.tip,
    };
  };

  const scored = has.map((c) => ({ c, z: (c.v - base(c.t).med) / base(c.t).scale }));
  const byTime = (a: { c: HeatCell }, b: { c: HeatCell }) => a.c.t.localeCompare(b.c.t);
  const high = scored.filter((x) => x.c.v > 0 && x.z >= Z_MIN && x.c.v > globalMedian).sort((a, b) => b.z - a.z || byTime(a, b));
  let anomalies: AnomalyCell[];
  if (d.metric === 'threat') {
    // 威脅:先列有嚴重 / 高風險的格子(依嚴重、高的筆數),再補統計上偏高的格子
    const sev = has
      .filter((c) => c.tip.threats.critical > 0 || c.tip.threats.high > 0)
      .sort((a, b) => b.tip.threats.critical - a.tip.threats.critical || b.tip.threats.high - a.tip.threats.high || b.v - a.v || a.t.localeCompare(b.t));
    const picked = sev.slice(0, ANOMALY_MAX).map((c) => toAnomaly(c, 'severity'));
    const seen = new Set(picked.map((x) => x.t));
    for (const x of high) {
      if (picked.length >= ANOMALY_MAX) break;
      if (!seen.has(x.c.t)) picked.push(toAnomaly(x.c, 'high'));
    }
    anomalies = picked;
  } else anomalies = high.slice(0, ANOMALY_MAX).map((x) => toAnomaly(x.c, 'high'));

  // 異常低:只看流量(阻擋、威脅少是好事);最後一格可能還在累積
  const last = cells[cells.length - 1]?.t;
  const lows =
    d.metric === 'traffic'
      ? scored
          .filter((x) => x.c.t !== last && base(x.c.t).med > 0 && x.z <= -Z_MIN)
          .sort((a, b) => a.z - b.z || byTime(a, b))
          .slice(0, LOW_MAX)
          .map((x) => toAnomaly(x.c, 'low'))
      : [];

  return {
    stats: {
      cells: cells.length,
      withData: has.length,
      nulls: cells.length - has.length,
      partial: cells.filter((c) => c.partial).length,
      sum,
      mean: has.length ? sum / has.length : 0,
      median: globalMedian,
      p90: quantile(values, 0.9),
      max: maxCell ? { t: maxCell.t, v: maxCell.v } : null,
      levels,
      baseline: !grouped ? 'all' : d.granularity === 'month' ? 'hour-of-day' : 'weekday',
    },
    anomalies,
    lows,
  };
}
