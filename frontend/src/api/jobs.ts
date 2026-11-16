/**
 * 長時間工作(docs/API.md §1.1;ARCHITECTURE D6):建立回 202 + Job,前端每 1–2 秒查詢一次,取消一律 DELETE …/{id}(冪等 204)。
 * 工作只有建立者本人可查;服務重新啟動後回 404 NETOPS_JOB_NOT_FOUND,畫面要提示重新送出。
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job<R = unknown, P = Record<string, number>> {
  id: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: P | null;
  error: { code: string; message: string } | null;
  result: R | null;
}

export const isFinished = (s: JobStatus): boolean => s === 'done' || s === 'failed' || s === 'cancelled';

/** 工作失敗或失效時的說明 */
export const JOB_ERROR: Record<string, string> = {
  NETOPS_JOB_NOT_FOUND: '工作已失效(逾期或服務重新啟動),請重新送出',
  NETOPS_JOB_LIMIT_EXCEEDED: '進行中的工作太多(每人 2 個、全系統 6 個),請稍後再試或先取消其他工作',
  NETOPS_JOB_TIMEOUT: '工作超過執行時間上限',
  NETOPS_JOB_ABORTED: '服務正在關閉,工作已中止,請稍後重新送出',
};
