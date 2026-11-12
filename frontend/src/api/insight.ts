/**
 * 分析儀表板(docs/API.md §4.5;後端 V-b1),需要 netops.pa.read。頁面不直接呼叫,透過 composables/useInsight。
 */
import { http } from './gateway';
import type { Coverage, SeverityCounts } from './heatmap';

export interface DateRange {
  /** YYYY-MM-DD(含當天),最長 90 天 */
  from: string;
  to: string;
}

/** 時間序列的數值 null = 沒有資料(彙總表最早的格子之前) */
export interface TrendPoint {
  t: string;
  sent: number | null;
  recv: number | null;
  sessions: number | null;
}
export interface AllowDenyPoint {
  t: string;
  allow: number | null;
  deny: number | null;
}
export interface SankeyNode {
  /** z:來源區域、a:App、d:目的區域 */
  id: string;
  name: string;
  layer: 0 | 1 | 2;
}
export interface SankeyLink {
  source: string;
  target: string;
  bytes: number;
}
export interface TopIpTraffic {
  ip: string;
  bytes: number;
  sent: number;
  recv: number;
  sessions: number;
}
export interface TopApp {
  app: string;
  bytes: number;
  sessions: number;
}

export interface TrafficInsight {
  view: 'traffic';
  from: string;
  to: string;
  bucketSeconds: number;
  allowDenyBucketSeconds: number;
  coverage: Coverage;
  trend: TrendPoint[];
  sankey: { nodes: SankeyNode[]; links: SankeyLink[] };
  topIp: TopIpTraffic[];
  topApp: TopApp[];
  allowDeny: AllowDenyPoint[];
  generatedAt: string;
}

export interface ThreatPoint {
  t: string;
  critical: number | null;
  high: number | null;
  medium: number | null;
  low: number | null;
}
export interface SeverityScore extends SeverityCounts {
  /** 前一個同長度期間;資料不足一整期時 null(畫面不顯示增減) */
  prev: SeverityCounts | null;
  prevFrom: string;
  prevTo: string;
}
export interface CountryCount {
  country: string;
  /** ISO 3166-1 alpha-2;「未知」為 null(地圖不著色) */
  iso2: string | null;
  count: number;
  critical: number;
  high: number;
}
export interface TopIp {
  ip: string;
  count: number;
  high: number;
}
export interface TopThreatName {
  name: string;
  severity: string;
  count: number;
}

export interface ThreatInsight {
  view: 'threat';
  from: string;
  to: string;
  bucketSeconds: number;
  coverage: Coverage;
  score: SeverityScore;
  timeline: ThreatPoint[];
  countries: CountryCount[];
  topInternalSrc: TopIp[];
  /** 伺服器網段未設定(V-c 之前)為 null,原因在 notes */
  topServerDst: TopIp[] | null;
  topNames: TopThreatName[];
  notes: string[];
  generatedAt: string;
}

export const insight = {
  traffic: (r: DateRange) => http.get<TrafficInsight>('/api/netops/pa/insight/traffic', { query: { ...r } }),
  threat: (r: DateRange) => http.get<ThreatInsight>('/api/netops/pa/insight/threat', { query: { ...r } }),
};
