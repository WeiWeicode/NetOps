/**
 * 活動熱力圖(V-a;docs/VIZ-RULES-DESIGN.md §4.2):期間、格子、分級、資料完整度。純函式,不依賴 Fastify 與 ClickHouse。
 *   year   以 date 所在週(週一開始)為最後一欄往前 53 週,一格一天(pa_heat_1d)
 *   month  date 所在月,一格一小時(pa_heat_1h)
 *   day    date 當天,一格 5 分鐘(pa_heat_5m);只保留 1 年(V1)
 * 開始時間在「現在」之後的格子不回。v = null 表示沒有資料(彙總表最早的格子之前,或彙總表沒有該格;AGENT.md §5:沒有資料不等於 0)。
 */
import type { HeatGrain, HeatRow } from '../../infra/clickhouse/heat.js';
import { logTimeOut, taipeiText } from '../../shared/time.js';

export const GRANULARITIES = ['year', 'month', 'day'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
/** ad 是 V-d 預留(回 409) */
export const METRICS = ['threat', 'traffic', 'deny', 'ad'] as const;
export type Metric = (typeof METRICS)[number];
export type PaMetric = Exclude<Metric, 'ad'>;

const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3600_000;
/** 日視圖(5 分鐘彙總)可查天數(V1:1 年) */
export const DAY_VIEW_RETENTION_DAYS = 365;

/** 威脅分數權重(X8):critical 10、high 5、medium 2、low 1、info 0 */
export const THREAT_WEIGHTS = { critical: 10, high: 5, medium: 2, low: 1, info: 0 } as const;

/** 台灣時間的 Y/M/D(UTC 毫秒 → 當地日期) */
const ymd = (ms: number) => {
  const d = new Date(ms + OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
};
/** 台灣時間某日 00:00 的 UTC 毫秒(月份 0 起算,會自動進位) */
const taipeiMidnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) - OFFSET_MS;
/** UTC 毫秒所在的台灣日期 00:00 */
export const taipeiDayOf = (ms: number) => {
  const x = ymd(ms);
  return taipeiMidnight(x.y, x.m, x.d);
};
/** 'YYYY-MM-DD' → 台灣 00:00 的 UTC 毫秒 */
export const parseDay = (v: string) => Date.parse(`${v}T00:00:00+08:00`);
/** UTC 毫秒 → ISO 8601 +08:00 */
export const isoTaipei = (ms: number) => logTimeOut(taipeiText(ms));
/** UTC 毫秒 → 'YYYY-MM-DD'(台灣) */
export const dayText = (ms: number) => taipeiText(ms).slice(0, 10).replace(/\//g, '-');

export interface HeatRange {
  grain: HeatGrain;
  bucketMs: number;
  fromMs: number;
  toMs: number;
  /** 每格的開始(只含開始時間 ≤ now 的格子) */
  cells: number[];
}

/** 期間與格子;dayMs = date 的台灣 00:00 */
export function heatRange(g: Granularity, dayMs: number, now: number, weekStart: 0 | 1 = 1): HeatRange {
  const x = ymd(dayMs);
  let grain: HeatGrain;
  let bucketMs: number;
  let fromMs: number;
  let toMs: number;
  if (g === 'year') {
    grain = '1d';
    bucketMs = DAY_MS;
    const back = (x.dow - weekStart + 7) % 7;
    const weekFrom = taipeiMidnight(x.y, x.m, x.d - back);
    fromMs = taipeiMidnight(x.y, x.m, x.d - back - 52 * 7);
    toMs = weekFrom + 7 * DAY_MS;
  } else if (g === 'month') {
    grain = '1h';
    bucketMs = 3600_000;
    fromMs = taipeiMidnight(x.y, x.m, 1);
    toMs = taipeiMidnight(x.y, x.m + 1, 1);
  } else {
    grain = '5m';
    bucketMs = 300_000;
    fromMs = dayMs;
    toMs = dayMs + DAY_MS;
  }
  const cells: number[] = [];
  for (let t = fromMs; t < toMs && t <= now; t += bucketMs) cells.push(t);
  return { grain, bucketMs, fromMs, toMs, cells };
}

export interface Gap {
  from: string;
  to: string;
  reason: string;
}
export interface GapMs {
  fromMs: number;
  toMs: number;
  reason: string;
}

export interface HeatCell {
  t: string;
  v: number | null;
  level: 0 | 1 | 2 | 3 | 4;
  partial: boolean;
  tip: {
    bytes: number;
    sessions: number;
    deny: number;
    threats: { critical: number; high: number; medium: number; low: number; info: number };
    topIp: { traffic: string | null; deny: string | null; threat: string | null };
  };
}

export const threatScore = (r: Pick<HeatRow, 'critical' | 'high' | 'medium' | 'low'>) =>
  THREAT_WEIGHTS.critical * r.critical + THREAT_WEIGHTS.high * r.high + THREAT_WEIGHTS.medium * r.medium + THREAT_WEIGHTS.low * r.low;

/** 威脅依最高嚴重度分級:critical 4、high 3、medium 2、low / info 1 */
export const threatLevel = (r: Pick<HeatRow, 'critical' | 'high' | 'medium' | 'low' | 'info'>): 0 | 1 | 2 | 3 | 4 =>
  r.critical ? 4 : r.high ? 3 : r.medium ? 2 : r.low || r.info ? 1 : 0;

/** 非 0 值的 25 / 50 / 75 百分位(由小到大取第 floor(p × (n − 1)) 個);沒有非 0 值時空陣列 */
export function quantileThresholds(values: number[]): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [];
  return [0.25, 0.5, 0.75].map((p) => v[Math.floor(p * (v.length - 1))]!);
}

/** 依門檻分級:0 → 0;> 0 → 1;≥ thresholds[i] → i + 2 */
export const quantileLevel = (v: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 => (v > 0 ? ((1 + thresholds.filter((t) => v >= t).length) as 1 | 2 | 3 | 4) : 0);

const metricValue = (m: PaMetric, r: HeatRow) => (m === 'traffic' ? r.bytes : m === 'deny' ? r.deny : threatScore(r));

const EMPTY: HeatRow = { t: 0, sessions: 0, bytes: 0, sent: 0, recv: 0, deny: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, topBytes: [], topDeny: [], topThreat: [] };

/** 沒有彙總列的格子要等多久才列進 gaps(最後幾格可能還有遲到的寫入,不要一直閃「資料不完整」) */
export const MISSING_GRACE_MS = 600_000;

/**
 * 組格子。since:彙總表最早的格子(null = 表內沒有資料,全部 null);gaps:已知的缺口(格子與缺口重疊 → partial)
 * 彙總表沒有該格的列 → v = null(沒有資料,不是 0;C1:例如彙總上線前的時段)。
 * 前提:pa_heat_* 由 TRAFFIC 與威脅原始表的物化檢視寫入,是稀疏表;某格只要收到任何一筆 TRAFFIC 就有列。
 * 防火牆整格 5 分鐘(或 1 小時、1 天)連一筆 TRAFFIC 都沒有,和「彙總沒寫入」一樣代表沒收到資料,不當成 0(AGENT §5)。
 * since 之後、已結束超過 MISSING_GRACE_MS 卻沒有列的連續格子,合併成 reason = 'no-data' 的缺口,和 gaps 一起回傳 allGaps(依時間排序)。
 * now 預設 Infinity:不算缺口(只給單元測試)。
 */
export function buildCells(range: HeatRange, metric: PaMetric, rows: HeatRow[], since: number | null, gaps: GapMs[], now = Infinity) {
  const byT = new Map(rows.map((r) => [r.t, r]));
  const raw = range.cells.map((t) => ({ t, r: byT.get(t) ?? null }));
  const missing: GapMs[] = [];
  if (since !== null)
    for (const { t, r } of raw) {
      if (r || t < since || t + range.bucketMs > now - MISSING_GRACE_MS) continue;
      const last = missing[missing.length - 1];
      if (last && last.toMs === t) last.toMs = t + range.bucketMs;
      else missing.push({ fromMs: t, toMs: t + range.bucketMs, reason: 'no-data' });
    }
  const allGaps = [...gaps, ...missing].sort((a, b) => a.fromMs - b.fromMs);
  const values = raw.filter((x) => x.r).map((x) => metricValue(metric, x.r!));
  const thresholds = metric === 'threat' ? [] : quantileThresholds(values);
  const cells: HeatCell[] = raw.map(({ t, r }) => {
    const row = r ?? { ...EMPTY, t };
    const v = r ? metricValue(metric, r) : null;
    const level = !r ? 0 : metric === 'threat' ? threatLevel(r) : quantileLevel(v!, thresholds);
    return {
      t: isoTaipei(t),
      v,
      level,
      partial: allGaps.some((g) => g.fromMs < t + range.bucketMs && g.toMs > t),
      tip: {
        bytes: row.bytes,
        sessions: row.sessions,
        deny: row.deny,
        threats: { critical: row.critical, high: row.high, medium: row.medium, low: row.low, info: row.info },
        topIp: { traffic: row.topBytes[0] ?? null, deny: row.topDeny[0] ?? null, threat: row.topThreat[0] ?? null },
      },
    };
  });
  return { cells, missing, allGaps, levels: metric === 'threat' ? { method: 'severity' as const, thresholds: [] as number[] } : { method: 'quantile' as const, thresholds } };
}
