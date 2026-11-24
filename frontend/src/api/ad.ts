/**
 * AD 網域(docs/API.md §6;AD-3 新增 ClickHouse 查詢、DC Agent 即時狀態、FTP 對帳與補漏)。
 * 總覽與 DC Agent 狀態需要 netops.ad.read;明細查詢與匯出需要 netops.ad-log.read;對帳與補漏需要 netops.ftp.read / write。
 */
import { http } from './gateway';
import type { IpNameLabel } from '@/composables/ipNames';

export type AdSource = 'ftp' | 'clickhouse';

export type AgentState = 'ok' | 'stale' | 'offline' | 'unknown';

export interface AgentSummary {
  total: number;
  ok: number;
  stale: number;
  offline: number;
  unknown: number;
  wrapRisk: number;
}

export interface AgentChannelStatus {
  lastRecordId: number | null;
  logEpoch: number | null;
  fileSizeMb: number | null;
  maxSizeMb: number | null;
  oldestEventAt: string | null;
  coverageHours: number | null;
  wrapRisk: boolean | null;
}

export interface AgentEvent {
  type: string;
  cause: string;
  detail: string;
  at: string | null;
  receivedAt: string | null;
}

export interface AgentStatus {
  computer: string;
  dcDomain: string;
  state: AgentState;
  updatedAt: string | null;
  ageSec: number | null;
  reportedAt: string | null;
  agentVersion: string;
  watchdogVersion: string;
  received: number;
  agent: {
    pid: number | null;
    serviceState: string;
    startType: string;
    statusOk: boolean | null;
    lastCollectTickAt: string | null;
    lastSendOkAt: string | null;
    lastError: string;
    restarts24h: number | null;
    cpuPct: number | null;
    rssMb: number | null;
    pendingEvents: number | null;
    skippedEvents: number | null;
    sendRejectStreak: number | null;
  };
  channels: Record<string, AgentChannelStatus>;
  events: AgentEvent[];
}

export interface AdAgentsResponse {
  items: AgentStatus[];
  summary: AgentSummary;
  staleSec: number;
  offlineSec: number;
  source: AdSource;
}

export interface AdDaySummary {
  day: string;
  events: number;
  /** ftp 來源才有 */
  importedAt?: string | null;
  files?: { name: string; channel: string; rows: number | null }[];
  /** clickhouse 來源才有 */
  agent?: number;
  ftp?: number;
  computers?: string[];
}

export interface AdDays {
  source?: AdSource;
  /** clickhouse 時附 DC Agent 狀態摘要(Redis 無法使用時為 null) */
  agents?: AgentSummary | null;
  days: AdDaySummary[];
  /** 失敗時只有簡短訊息,細節在 FTP Log 檔案頁(GET /ftp/ad/status) */
  import: { running: boolean; lastSyncAt: string | null; lastSyncError: string };
  channels: Record<string, string>;
  securityEvents: Record<string, string>;
  /** 各記錄類別的事件中文名稱對照表(Security / System / Directory_Service / DNS_Server;AD-6) */
  channelEvents?: Record<string, Record<string, string>>;
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
  source?: AdSource;
  /** 期間內有資料的天數;少於期間天數表示有日期沒有資料 */
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
  names?: Record<string, IpNameLabel>;
}

export const ad = {
  days: () => http.get<AdDays>('/api/netops/ad/days'),
  /** from / to:YYYY-MM-DD(含當天),最長 92 天 */
  overview: (from: string, to: string) => http.get<AdOverview>('/api/netops/ad/overview', { query: { from, to } }),
  /** DC Agent 即時狀態(netops.ad.read);Redis 無法使用回 424 NETOPS_REDIS_UNAVAILABLE */
  agents: () => http.get<AdAgentsResponse>('/api/netops/ad/agents'),
};

export const AD_LEVEL: Record<AdLevel, { label: string; tone: string }> = {
  critical: { label: '重大', tone: 'danger' },
  error: { label: '錯誤', tone: 'danger' },
  warning: { label: '警告', tone: 'warning' },
  audit_failure: { label: '稽核失敗', tone: 'danger' },
  audit_success: { label: '稽核成功', tone: 'success' },
  info: { label: '資訊', tone: 'neutral' },
};

// ---------- 明細查詢與匯出(§6.2;資料已在本機 / ClickHouse,同步回應) ----------

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
  dcDomain?: string;
  source?: 'agent' | 'ftp';
  logEpoch?: number | null;
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
  computer?: string;
  dcDomain?: string;
  name?: string;
}

export interface AdEventSearchResponse {
  items: AdEventRow[];
  total: number;
  page: number;
  pageSize: number;
  scanned: number;
  source?: AdSource;
  names?: Record<string, IpNameLabel>;
}

/** 期間最長 31 天;匯出最多 20,000 筆(超過 422 NETOPS_EXPORT_TOO_LARGE) */
export const AD_SEARCH_MAX_DAYS = 31;
export const AD_EXPORT_MAX = 20_000;

export const adLog = {
  search: (q: AdEventQuery, page: number, pageSize: number) =>
    http.get<AdEventSearchResponse>('/api/netops/ad/events', {
      query: { ...q, issueOnly: q.issueOnly || undefined, page, pageSize },
    }),
  exportQuery: (q: AdEventQuery) => ({ ...q, issueOnly: q.issueOnly || undefined }),
  exportPath: '/api/netops/ad/events/export' as const,
};

// ---------- AD FTP 與 ClickHouse 對帳與補漏(AD-3) ----------

export type AdReconItemStatus = 'ok' | 'gap' | 'excess';
export interface AdReconItem {
  computer: string;
  channel: string;
  ftp: number;
  ch: number;
  chAgent: number;
  chFtp: number;
  diff: number;
  status: AdReconItemStatus;
}

export type AdReconStatus = 'ok' | 'gap' | 'excess' | 'pending' | 'ftp-error';
export interface AdReconDay {
  day: string;
  checkedAt: string;
  status: AdReconStatus;
  ftpFiles: number;
  gaps: number;
  excess: number;
  items: AdReconItem[];
  backfills: string[];
}

export interface AdReconList {
  items: AdReconDay[];
  window: { from: string; to: string } | null;
}

export type AdBackfillState = 'queued' | 'running' | 'done' | 'failed';
export interface AdBackfillScope {
  computer: string;
  channel: string;
}

export interface AdBackfillJob {
  id: string;
  day: string;
  files: string[];
  scope: AdBackfillScope[];
  state: AdBackfillState;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  read: number;
  skipped: number;
  inserted: number;
  waitingAgent: number;
  ambiguous: number;
  invalid: number;
  error: string | null;
}

export const adRecon = {
  list: (from: string, to: string) => http.get<AdReconList>('/api/netops/ad/reconciliations', { query: { from, to } }),
  run: (day: string) => http.post<AdReconDay>('/api/netops/ad/reconciliations', { day }),
  backfill: (day: string, scope?: AdBackfillScope[]) =>
    http.post<AdBackfillJob>('/api/netops/ad/backfills', scope?.length ? { day, scope } : { day }),
  job: (id: string) => http.get<AdBackfillJob>(`/api/netops/ad/backfills/${encodeURIComponent(id)}`),
};
