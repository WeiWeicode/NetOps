/**
 * 安全事件:PA-560 TRAFFIC 以外的 log(docs/API.md §4.2;後端 B2-ad 已實作),需要 netops.pa.read。
 * 類型:threat、url、data、wildfire、decryption、globalprotect、userid(只列出有設定 FTP 目錄的類型)。
 */
import { http } from './gateway';
import type { PaSource } from './pa';

export interface PaEventType {
  type: string;
  label: string;
  dir: string;
  files: number;
  rows: number;
  /** 已分析的資料日期(新的在前) */
  days: string[];
}

export interface KeyCountGroup {
  key: string;
  title: string;
  items: { key: string; n: number }[];
}

export interface PaEventOverview {
  type: string;
  label: string;
  from: string;
  to: string;
  /** 實際使用的來源(C3:威脅、URL、資料過濾、WildFire 可為 clickhouse;其他類型一律 ftp) */
  source: 'ftp' | 'clickhouse';
  /** source 為 clickhouse 時:KPI 與排行只算到這個時間 */
  topsUntil?: string;
  /** ftp:期間內已分析的檔案數;clickhouse:有摘要的小時數 */
  files: number;
  /** 已分析、但摘要讀不到的檔案數:大於 0 表示結果不完整 */
  missing: number;
  /** 匯入中(busy)時結果也不完整;failed 為最近一輪分析失敗的檔案數 */
  import: { busy: boolean; failed: number };
  rows: number;
  timeMin: string | null;
  timeMax: string | null;
  hours: { hour: string; n: number }[];
  kpis: KeyCountGroup[];
  tops: KeyCountGroup[];
}

export const paEvents = {
  types: () => http.get<{ types: PaEventType[] }>('/api/netops/pa-events/types'),
  /** from / to:YYYY-MM-DD(含當天),最長 92 天 */
  overview: (type: string, from: string, to: string, top = 15, source?: PaSource) =>
    http.get<PaEventOverview>('/api/netops/pa-events/overview', { query: { type, from, to, top, ...(source ? { source } : {}) } }),
};
