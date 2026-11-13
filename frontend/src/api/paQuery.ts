/**
 * PA 精準查詢(C5;docs/API.md §3.3),需要 netops.pa-query.read(只給 netops-admin,按鈕 netops.pa-live.query)。
 * 頁面不直接呼叫,透過 composables/usePaQuery。
 */
import { http } from './gateway';

export type PaQueryKind = 'log' | 'session';
export type PaQueryStatus = 'queued' | 'running' | 'done' | 'failed' | 'rejected';

export interface PaQueryBody {
  kind: PaQueryKind;
  /** 單一 IPv4 / IPv6 */
  ip: string;
  /** log:traffic(預設)/ threat;from / to 為 ISO 8601 含時區,視窗 ≤ 15 分鐘、結束在 1 小時內 */
  logType?: 'traffic' | 'threat';
  from?: string;
  to?: string;
  /** 1–500(預設 500) */
  nlogs?: number;
  /** session:src = 該 IP 為來源(預設)、dst = 為目的 */
  direction?: 'src' | 'dst';
}

export interface PaQueryState {
  enabled: boolean;
  executor: boolean;
  heartbeatAgeSec: number | null;
  activeSec: number;
  globalCoolSec: number;
  userCoolSec: number;
  mgmtCpu: number | null;
}

export interface PaQueryJob {
  id: string;
  kind: PaQueryKind;
  status: PaQueryStatus;
  params: Record<string, unknown>;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  mgmtCpu: number | null;
  error: { code: string; message: string } | null;
  /** log:欄位同 Log 明細(time 為 PA 設備時間 'yyyy/MM/dd HH:mm:ss');session:id、app、state、src、sport、dst、dport、proto、fromZone、toZone、startTime、bytes、rule、natSrc… */
  result: { rows: Record<string, string | number>[]; count: number; truncated: boolean } | null;
}

export const paQuery = {
  status: () => http.get<PaQueryState>('/api/netops/pa-query/status'),
  submit: (b: PaQueryBody) => http.post<PaQueryJob>('/api/netops/pa-query/jobs', b),
  job: (id: string) => http.get<PaQueryJob>(`/api/netops/pa-query/jobs/${encodeURIComponent(id)}`),
};
