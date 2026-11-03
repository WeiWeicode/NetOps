/**
 * AD 網域(docs/API.md §6;後端 B2-ad 已實作)。
 * 總覽需要 netops.ad.read;明細查詢與匯出需要 netops.ad-log.read(§6.2)。
 */
import { http } from './gateway';

export interface AdDaySummary {
  day: string;
  events: number;
  importedAt: string | null;
  files: { name: string; channel: string; rows: number | null }[];
}

export interface AdDays {
  days: AdDaySummary[];
  /** 失敗時只有簡短訊息,細節在 FTP Log 檔案頁(GET /ftp/ad/status) */
  import: { running: boolean; lastSyncAt: string | null; lastSyncError: string };
  channels: Record<string, string>;
  securityEvents: Record<string, string>;
}

export type AdLevel = 'info' | 'warning' | 'error' | 'critical' | 'audit_success' | 'audit_failure';

export interface AdEventGroup {
  channel: string;
  eventId: number;
  level: AdLevel;
  provider: string;
  n: number;
  first: string;
  last: string;
  sample: string;
  computers: string[];
  name?: string;
}

export interface KeyCount {
  key: string;
  n: number;
}

export interface AdAccountChange {
  time: string;
  eventId: number;
  action: string;
  actor: string;
  target: string;
  group: string;
  privileged: boolean;
  computer: string;
  recordId: string;
}

export interface AdOverview {
  from: string;
  to: string;
  /** 期間內已匯入的天數;少於期間天數表示有日期沒有資料 */
  days: number;
  total: number;
  byChannel: Record<string, number>;
  byLevel: Partial<Record<AdLevel, number>>;
  timeMin: string | null;
  timeMax: string | null;
  hours: { hour: string; n: number; issue: number }[];
  events: AdEventGroup[];
  issues: AdEventGroup[];
  failAccounts: KeyCount[];
  failIps: KeyCount[];
  failReasons: (KeyCount & { ips?: KeyCount[]; accounts?: KeyCount[] })[];
  accountChanges: AdAccountChange[];
  privilegedChanges: number;
  accountsCreated: number;
  privLogons: KeyCount[];
}

export const ad = {
  days: () => http.get<AdDays>('/api/netops/ad/days'),
  /** from / to:YYYY-MM-DD(含當天),最長 92 天 */
  overview: (from: string, to: string) => http.get<AdOverview>('/api/netops/ad/overview', { query: { from, to } }),
};

export const AD_LEVEL: Record<AdLevel, { label: string; tone: string }> = {
  critical: { label: '重大', tone: 'danger' },
  error: { label: '錯誤', tone: 'danger' },
  warning: { label: '警告', tone: 'warning' },
  audit_failure: { label: '稽核失敗', tone: 'danger' },
  audit_success: { label: '稽核成功', tone: 'success' },
  info: { label: '資訊', tone: 'neutral' },
};

// ---------- 明細查詢與匯出(§6.2;資料已在本機,同步回應) ----------

export interface AdEventRow {
  time: string;
  eventId: number;
  level: AdLevel;
  levelText: string;
  provider: string;
  computer: string;
  recordId: string;
  channel: string;
  message: string;
  account: string;
  domain: string;
  ip: string;
  workstation: string;
  reason: string;
  actor: string;
  target: string;
  group: string;
  privileged: boolean;
}

/** 查詢條件:from / to 為 ISO 8601 含時區;eventId 逗號分隔 */
export interface AdEventQuery {
  from: string;
  to: string;
  channel?: string;
  level?: string;
  eventId?: string;
  q?: string;
  account?: string;
  ip?: string;
  issueOnly?: boolean;
}

/** 期間最長 31 天;匯出最多 20,000 筆(超過 422 NETOPS_EXPORT_TOO_LARGE) */
export const AD_SEARCH_MAX_DAYS = 31;
export const AD_EXPORT_MAX = 20_000;

export const adLog = {
  search: (q: AdEventQuery, page: number, pageSize: number) =>
    http.get<{ items: AdEventRow[]; total: number; page: number; pageSize: number; scanned: number }>('/api/netops/ad/events', {
      query: { ...q, issueOnly: q.issueOnly || undefined, page, pageSize },
    }),
  exportQuery: (q: AdEventQuery) => ({ ...q, issueOnly: q.issueOnly || undefined }),
};
