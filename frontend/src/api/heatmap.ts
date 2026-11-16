/**
 * 活動熱力圖(docs/API.md §4.4;後端 V-a),需要 netops.pa.read。頁面不直接呼叫,透過 composables/useHeatmap。
 */
import { http } from './gateway';

export type HeatGranularity = 'year' | 'month' | 'day';
/** ad 是 AD 階段(V-d)預留:畫面顯示但停用,不呼叫 API */
export type HeatMetric = 'threat' | 'traffic' | 'deny' | 'ad';
export type PaHeatMetric = Exclude<HeatMetric, 'ad'>;

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface HeatCell {
  /** 格子開始(ISO 8601 +08:00) */
  t: string;
  /** null = 沒有資料(彙總表最早的格子之前),和 0 不同,畫面要分得出來 */
  v: number | null;
  level: 0 | 1 | 2 | 3 | 4;
  /** 落在已知缺口(對帳缺口)內:資料可能不完整 */
  partial: boolean;
  tip: {
    bytes: number;
    sessions: number;
    deny: number;
    threats: SeverityCounts;
    /** 近似值(topK),畫面一律標「約」;沒有時 null */
    topIp: { traffic: string | null; deny: string | null; threat: string | null };
  };
}

export interface Coverage {
  /** 彙總表最早的格子;null = 沒有任何資料 */
  since: string | null;
  gaps: { from: string; to: string; reason: string }[];
  /** false:缺口未檢查(沒有對帳) */
  gapsKnown: boolean;
}

export interface HeatmapResponse {
  granularity: HeatGranularity;
  metric: PaHeatMetric;
  /** YYYY-MM-DD */
  date: string;
  from: string;
  to: string;
  bucketSeconds: number;
  coverage: Coverage;
  levels: { method: 'quantile' | 'severity'; thresholds: number[] };
  cells: HeatCell[];
  generatedAt: string;
}

export const heatmap = {
  /** date 省略為今天;日視圖超過 1 年回 422 NETOPS_HEATMAP_OUT_OF_RETENTION(details.earliest) */
  get: (q: { granularity: HeatGranularity; metric: PaHeatMetric; date?: string }) => http.get<HeatmapResponse>('/api/netops/pa/heatmap', { query: q }),
};
