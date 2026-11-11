/**
 * 防火牆 PA-560 TRAFFIC(docs/API.md §4.1;後端 B2-pa 已實作),需要 netops.pa.read。
 * 明細查詢(§4.3)需要 netops.pa-log.read。
 */
import { http } from './gateway';
import type { ImportStatus } from './ftp';
import type { Job } from './jobs';

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

/** 資料來源(C3;docs/API.md §4.1):省略時依後端設定(預設 auto) */
export type PaSource = 'ftp' | 'clickhouse' | 'auto';

export interface PaOverview {
  from: string;
  to: string;
  /** 實際使用的來源 */
  source: 'ftp' | 'clickhouse';
  /** source 為 clickhouse 時:排行、疑似掃描只算到這個時間(之後的小時還沒有排行);ftp 時不提供 */
  topsUntil?: string;
  /** ftp:期間內已分析的檔案數;clickhouse:有資料的小時數。0 表示沒有資料(不是沒有流量) */
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
  overview: (from: string, to: string, top = 15, source?: PaSource) => http.get<PaOverview>('/api/netops/pa/overview', { query: { from, to, top, ...(source ? { source } : {}) } }),
  /** 明細查詢的下拉選項(期間內出現過的值) */
  options: (from: string, to: string, source?: PaSource) => http.get<PaOptions>('/api/netops/pa/options', { query: { from, to, ...(source ? { source } : {}) } }),
};

export interface PaOptions {
  apps: string[];
  rules: string[];
  zones: string[];
  actions: string[];
}

// ---------- Log 明細查詢與匯出(§4.3,工作模式;後端 B2-logs) ----------

/** 期間最長 31 天 */
export const PA_SEARCH_MAX_DAYS = 31;

export const PA_SEARCH_KEYS = ['src', 'dst', 'ip', 'port', 'proto', 'app', 'rule', 'action', 'fromZone', 'toZone', 'user', 'country', 'q'] as const;
export type PaSearchKey = (typeof PA_SEARCH_KEYS)[number];

/** 送出的查詢:from / to 為 ISO 8601 含時區,其他條件選填 */
export type PaSearchBody = { from: string; to: string; limit?: number } & Partial<Record<PaSearchKey, string>>;

export interface PaSearchResult {
  from: string;
  to: string;
  total: number;
  limit: number;
  files: number;
  filesScanned: number;
  scanned: number;
  seconds: number;
  /** '' 全部掃完 | 'limit' 達筆數上限 | 'timeout' 超過掃描秒數或等不到 FTP 連線 | 'closed' 服務關閉 | 'error' 讀取失敗(後三者結果不完整) */
  stopReason: '' | 'limit' | 'timeout' | 'closed' | 'error';
}

export interface PaLogRow {
  time: string;
  subtype: string;
  action: string;
  src: string;
  sport: number;
  dst: string;
  dport: number;
  proto: string;
  app: string;
  rule: string;
  fromZone: string;
  toZone: string;
  srcUser: string;
  natSrc: string;
  natDst: string;
  bytes: number;
  sent: number;
  recv: number;
  packets: number;
  elapsed: number;
  endReason: string;
  category: string;
  srcCountry: string;
  dstCountry: string;
  appRisk: number;
  threat: string;
  severity: string;
  url: string;
}

export type PaSearchJob = Job<PaSearchResult, { filesScanned: number; files: number; rows: number; found: number }>;

const searchPath = (id: string) => `/api/netops/pa/log-searches/${encodeURIComponent(id)}` as const;
export const paLog = {
  create: (body: PaSearchBody) => http.post<PaSearchJob>('/api/netops/pa/log-searches', body),
  get: (id: string) => http.get<PaSearchJob>(searchPath(id)),
  cancel: (id: string) => http.delete(searchPath(id)),
  rows: (id: string, page: number, pageSize: number) =>
    http.get<{ items: PaLogRow[]; total: number; page: number; pageSize: number }>(`${searchPath(id)}/rows`, { query: { page, pageSize } }),
  exportPath: (id: string) => `${searchPath(id)}/export` as const,
};

/** 明細欄位名稱(畫面與匯出;同舊版 FIELD_LABELS) */
export const PA_FIELD_LABELS: Record<keyof PaLogRow, string> = {
  time: '時間',
  subtype: '類型',
  action: '動作',
  src: '來源 IP',
  sport: '來源 Port',
  dst: '目的 IP',
  dport: '目的 Port',
  proto: '協定',
  app: '應用程式',
  rule: '規則',
  fromZone: '來源區域',
  toZone: '目的區域',
  srcUser: '使用者',
  natSrc: 'NAT 來源',
  natDst: 'NAT 目的',
  bytes: '位元組',
  sent: '送出',
  recv: '接收',
  packets: '封包',
  elapsed: '持續(秒)',
  endReason: '結束原因',
  category: 'URL 類別',
  srcCountry: '來源國家',
  dstCountry: '目的國家',
  appRisk: 'App 風險',
  threat: '威脅名稱',
  severity: '嚴重性',
  url: 'URL / 檔名',
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
