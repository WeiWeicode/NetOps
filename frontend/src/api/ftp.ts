/**
 * FTP Log 檔案(docs/API.md §5;後端 B2-pa、B2-ad 已實作)。
 * FTP 唯讀:「刪除分析結果」只刪本系統的摘要,不動 FTP(AGENT.md §7.4)。
 * 寫入(同步、分析、取消、刪除結果)需要 netops.ftp.write;畫面按鈕以 UI.paFilesManage / UI.adFilesManage 控制。
 */
import { http } from './gateway';
import type { Job } from './jobs';

// ---------- PA(§5.1) ----------

export type PaFileState = 'new' | 'changed' | 'done' | 'error' | 'queued' | 'running';

export interface PaFile {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: string | null;
  isLog: boolean;
  state?: PaFileState;
  rows?: number | null;
  /** 資料日期 YYYY-MM-DD(已分析才有) */
  day?: string | null;
  timeMin?: string | null;
  timeMax?: string | null;
  analyzedAt?: string | null;
  ms?: number | null;
  error?: string;
}

export interface EventDir {
  type: string;
  label: string;
  dir: string;
}

export interface PaListing {
  path: string;
  /** '' = TRAFFIC 或一般目錄 */
  type: string;
  root: string;
  logDir: string;
  pattern: string;
  eventDirs: EventDir[];
  items: PaFile[];
}

export interface ImportStatus {
  busy: boolean;
  total: number;
  done: number;
  failed: number;
  queued: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string;
  syncing: boolean;
  autoSyncMinutes: number;
  running: { path: string; name: string; size: number; read: number; rows: number; seconds: number }[];
}

export interface PaStatus {
  traffic: ImportStatus;
  events: ImportStatus;
}

export const paFtp = {
  /** path 省略 = TRAFFIC 目錄 */
  list: (path?: string) => http.get<PaListing>('/api/netops/ftp/pa/files', { query: { path } }),
  status: () => http.get<PaStatus>('/api/netops/ftp/pa/status'),
  /** 背景同步(202) */
  sync: () => http.post<PaStatus>('/api/netops/ftp/pa/syncs'),
  /** 分析選取的檔案(1–500 筆;重新分析也用這個) */
  analyze: (paths: string[]) => http.post<{ added: number; skipped: number }>('/api/netops/ftp/pa/analyses', { items: paths.map((path) => ({ path })) }),
  /** 取消佇列並中斷分析中的檔案 */
  cancel: () => http.delete<{ cancelled: number }>('/api/netops/ftp/pa/analyses'),
  /** 刪除分析結果(1–500 筆;FTP 上的檔案不動) */
  forget: (paths: string[]) => http.post<{ deleted: number }>('/api/netops/ftp/pa/result-deletions', { paths }),
};

/** 單次請求的筆數上限(§5.1) */
export const PA_BATCH_MAX = 500;

// ---------- AD(§5.2) ----------

export type AdDayState = 'new' | 'changed' | 'done' | 'orphan';

export interface AdFile {
  name: string;
  size: number;
  modified: string | null;
  channel: string;
  rows: number | null;
  error: string;
}

export interface AdDay {
  day: string;
  path: string;
  state: AdDayState;
  events: number | null;
  importedAt: string | null;
  files: AdFile[];
}

export interface AdListing {
  dir: string;
  days: AdDay[];
}

export interface AdStatus {
  running: boolean;
  dir: string;
  autoSyncMinutes: number;
  lastSyncAt: string | null;
  lastSyncError: string;
  lastResult: { days: number; imported: { day: string; events: number }[] } | null;
}

export const adFtp = {
  /** 清單改工作模式(舊版逐一列出日期資料夾最長 120 秒) */
  listings: {
    create: () => http.post<Job<AdListing>>('/api/netops/ftp/ad/listings'),
    get: (id: string) => http.get<Job<AdListing>>(`/api/netops/ftp/ad/listings/${encodeURIComponent(id)}`),
    cancel: (id: string) => http.delete(`/api/netops/ftp/ad/listings/${encodeURIComponent(id)}`),
  },
  status: () => http.get<AdStatus>('/api/netops/ftp/ad/status'),
  /** 背景同步(202);正在同步回 409 NETOPS_AD_SYNC_BUSY */
  sync: () => http.post<AdStatus>('/api/netops/ftp/ad/syncs'),
  /** 不比對、一律重新匯入(1–60 天;202) */
  reimport: (days: string[]) => http.post<AdStatus>('/api/netops/ftp/ad/imports', { days }),
  forget: (days: string[]) => http.post<{ deleted: number }>('/api/netops/ftp/ad/result-deletions', { days }),
};

export const AD_IMPORT_MAX = 60;

/** AD 事件記錄名稱 */
export const AD_CHANNEL: Record<string, string> = { Security: '安全性', System: '系統', Directory_Service: '目錄服務', DNS_Server: 'DNS 伺服器' };
