/**
 * 時段明細(docs/API.md §4.4;後端 V-a),需要 netops.pa-log.read。30 秒內完成回結果,否則回 202 工作(composables/useSlice 處理輪詢)。
 */
import { http } from './gateway';
import type { SeverityCounts } from './heatmap';
import type { Job } from './jobs';

export type SliceType = 'traffic' | 'threat';
export type SliceSource = 'hot' | 'cold' | 'mixed';

export interface SliceQuery {
  /** ISO 8601 含時區;end − start ≤ 1 天 */
  start: string;
  end: string;
  type?: SliceType;
  /** 單一 IP 或 CIDR(不接受萬用字元) */
  ip?: string;
  src?: string;
  dst?: string;
  app?: string;
  fromZone?: string;
  toZone?: string;
  dport?: number;
  action?: 'allow' | 'block';
  country?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  threatName?: string;
  /** 0–200,預設 100 */
  rows?: number;
  sort?: 'time' | 'bytes';
}

export interface SliceTopItem {
  key: string;
  /** traffic */
  sessions?: number;
  bytes?: number;
  /** threat */
  count?: number;
  severity?: string;
}

export interface SliceResult {
  source: SliceSource;
  type: SliceType;
  start: string;
  end: string;
  filters: Record<string, string | number>;
  summary: { sessions: number; bytes: number; sent: number; recv: number; deny: number; threats: SeverityCounts };
  /** traffic:src、dst、app、dport、dstCountry;threat:name、src、dst、srcCountry */
  top: Record<string, SliceTopItem[]>;
  /** 欄位同 Log 明細(time 為 +08:00) */
  rows: Record<string, string | number>[];
  rowsLimit: number;
  rowsTruncated: boolean;
  coverage: { partial: boolean; gaps: { from: string; to: string; reason: string }[]; gapsKnown: boolean };
  seconds: number;
}

export type SliceJob = Job<SliceResult, Record<string, unknown>>;

/** 200 的結果有 source;202 的工作有 kind = 'pa-slice' */
export const isSliceJob = (x: SliceResult | SliceJob): x is SliceJob => (x as SliceJob).kind === 'pa-slice';

export const slice = {
  get: async (q: SliceQuery): Promise<{ kind: 'result'; result: SliceResult } | { kind: 'job'; job: SliceJob }> => {
    const r = await http.get<SliceResult | SliceJob>('/api/netops/pa/slice', { query: { ...q } });
    return isSliceJob(r) ? { kind: 'job', job: r } : { kind: 'result', result: r };
  },
  job: (id: string) => http.get<SliceJob>(`/api/netops/pa/slices/${encodeURIComponent(id)}`),
  /** 冪等(204) */
  cancel: (id: string) => http.delete<void>(`/api/netops/pa/slices/${encodeURIComponent(id)}`),
};
