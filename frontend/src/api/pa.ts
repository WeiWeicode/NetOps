/**
 * 防火牆 PA-560 TRAFFIC(docs/API.md §4.1;後端 B2-pa 已實作),需要 netops.pa.read。
 * 明細查詢(§4.3)需要 netops.pa-log.read,在明細查詢頁另寫。
 */
import { http } from './gateway';
import type { ImportStatus } from './ftp';

export interface PaDay {
  day: string;
  files: number;
  rows: number;
}

export interface TopEntry {
  key: string;
  n: number;
  bytes?: number;
}

export interface PaOverview {
  from: string;
  to: string;
  /** 期間內已分析的檔案數;0 表示沒有資料(不是沒有流量) */
  files: number;
  /** 已分析但摘要讀不到的檔案數;大於 0 表示總覽不完整 */
  missing: number;
  /** 有檔案還在分析或分析失敗時,總覽可能不完整 */
  import: { busy: boolean; failed: number };
  rows: number;
  allow: number;
  block: number;
  bytes: number;
  sent: number;
  recv: number;
  timeMin: string | null;
  timeMax: string | null;
  hours: { hour: string; n: number; allow: number; block: number; bytes: number }[];
  actions: Record<string, number>;
  subtypes: Record<string, number>;
  top: Record<string, TopEntry[]>;
  topBytes: Record<string, TopEntry[]>;
  scan: { src: string; n: number; dsts: number; ports: number; zone: string }[];
}

export const pa = {
  days: () => http.get<{ days: PaDay[]; import: Omit<ImportStatus, 'running'> }>('/api/netops/pa/days'),
  /** from / to:YYYY-MM-DD(含當天),最長 92 天;top 1–100 */
  overview: (from: string, to: string, top = 15) => http.get<PaOverview>('/api/netops/pa/overview', { query: { from, to, top } }),
};

/** PA 的動作 → 中文與顏色(同舊版 src/utils/format.js) */
export const PA_ACTION: Record<string, { label: string; tone: string }> = {
  allow: { label: '允許', tone: 'success' },
  deny: { label: '拒絕', tone: 'danger' },
  drop: { label: '丟棄', tone: 'danger' },
  'drop-icmp': { label: '丟棄 ICMP', tone: 'danger' },
  'reset-both': { label: '重置雙方', tone: 'warning' },
  'reset-client': { label: '重置用戶端', tone: 'warning' },
  'reset-server': { label: '重置伺服器', tone: 'warning' },
};
export const actionOf = (a: string) => PA_ACTION[a] ?? { label: a, tone: 'neutral' };
