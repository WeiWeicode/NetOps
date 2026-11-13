/**
 * PA 精準查詢(C5;docs/PA-LOG-CLICKHOUSE-GUIDE.md §9、ARCHITECTURE D31、IMPL-PLAN C0 E4 結果)。netops-api 只驗證與送出,PA-560 由 netops-pa 查。
 *   log      單一 IP 的 TRAFFIC / 威脅 log:時間視窗 ≤ 15 分鐘、結束在 1 小時內、nlogs ≤ 500
 *   session  Session Browser:單一 IP 為來源或目的的當下連線
 * 限流(E4、§9.3;大範圍實測前不放寬):全系統同時 1 個、全域間隔 10 秒、每人冷卻 60 秒;
 *   最新管理平面 CPU 快照 > 50% 先擋(netops-pa 送出前還會再取樣一次);被擋一律 429 NETOPS_PA_QUERY_BUSY + Retry-After(不回 5xx)。
 * netops-pa 沒有開查詢執行者(PA_QUERY_ENABLED,測試區預設關閉)或心跳超過 60 秒:409 NETOPS_PA_QUERY_DISABLED(設定 / 狀態,不用 5xx)。
 * Redis 連不上:424 NETOPS_REDIS_UNAVAILABLE(同 R1)。工作只有建立者本人可查(比對 owner)。
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AppError } from '../../errors.js';
import type { PaQueryState, PaQueryStore } from '../../infra/redis/pa-query.js';

export const PAQ_MAX_WINDOW_MS = 15 * 60_000;
export const PAQ_MAX_AGE_MS = 60 * 60_000;
export const PAQ_MAX_NLOGS = 500;
/** E4(2026-11-10):管理平面 CPU 超過 50% 不送 */
export const PAQ_MAX_MGMT_CPU = 50;

export type PaQueryKind = 'log' | 'session';

export interface PaQueryBody {
  kind: PaQueryKind;
  ip: string;
  /** log */
  logType?: 'traffic' | 'threat';
  from?: string;
  to?: string;
  nlogs?: number;
  /** session:src = 該 IP 為來源、dst = 為目的 */
  direction?: 'src' | 'dst';
}

export type PaQueryStatus = 'queued' | 'running' | 'done' | 'failed' | 'rejected';

export interface PaQueryJob {
  id: string;
  kind: PaQueryKind;
  status: PaQueryStatus;
  params: Record<string, unknown>;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 送出前取樣到的管理平面 CPU(%) */
  mgmtCpu: number | null;
  error: { code: string; message: string } | null;
  result: { rows: Record<string, unknown>[]; count: number; truncated: boolean } | null;
}

const bad = (field: string, message: string) => new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field, message }]);
const busy = (retryAfter: number, message: string) => Object.assign(new AppError(429, 'NETOPS_PA_QUERY_BUSY', message, { retryAfter }), { retryAfter });
const redisDown = (cause: unknown) => Object.assign(new AppError(424, 'NETOPS_REDIS_UNAVAILABLE', 'PA 查詢佇列(netops-redis)暫時無法使用,請稍後再試'), { cause });

/** 參數驗證(純函式):回傳送給 netops-pa 的 params(netops-pa 會再驗一次) */
export function validateQuery(b: PaQueryBody, now: number): Record<string, unknown> {
  const ip = String(b.ip ?? '').trim();
  if (!isIP(ip) || ip.includes('%')) throw bad('ip', '只接受單一 IPv4 / IPv6 位址');
  if (b.kind === 'session') return { ip, direction: b.direction ?? 'src' };
  if (b.kind !== 'log') throw bad('kind', '只能是 log 或 session');
  if (!b.from) throw bad('from', '必填');
  if (!b.to) throw bad('to', '必填');
  const from = Date.parse(b.from);
  const to = Date.parse(b.to);
  if (Number.isNaN(from) || !/(Z|[+-]\d{2}:\d{2})$/.test(b.from)) throw bad('from', '時間格式必須是 ISO 8601 且含時區');
  if (Number.isNaN(to) || !/(Z|[+-]\d{2}:\d{2})$/.test(b.to)) throw bad('to', '時間格式必須是 ISO 8601 且含時區');
  if (to <= from) throw bad('to', '結束時間必須晚於開始時間');
  if (to - from > PAQ_MAX_WINDOW_MS) throw bad('to', '時間視窗最長 15 分鐘');
  if (to < now - PAQ_MAX_AGE_MS || to > now + 60_000) throw bad('to', '結束時間要在最近 1 小時內(更早的請用 Log 明細查詢)');
  return { logType: b.logType ?? 'traffic', ip, from: new Date(from).toISOString(), to: new Date(to).toISOString(), nlogs: b.nlogs ?? PAQ_MAX_NLOGS };
}

const num = (v: string | undefined) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function toJob(id: string, h: Record<string, string>): PaQueryJob {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(h.params ?? '{}') as Record<string, unknown>;
  } catch {
    params = {};
  }
  let rows: Record<string, unknown>[] | null = null;
  if (h.status === 'done') {
    try {
      const r = JSON.parse(h.result ?? '[]');
      rows = Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
    } catch {
      rows = [];
    }
  }
  const status = (['queued', 'running', 'done', 'failed', 'rejected'].includes(h.status ?? '') ? h.status : 'failed') as PaQueryStatus;
  // 錯誤代碼只接受 NETOPS_ 開頭(值來自 Redis);訊息截斷
  const code = /^NETOPS_[A-Z_]{1,60}$/.test(h.error ?? '') ? h.error! : 'NETOPS_PA_QUERY_FAILED';
  return {
    id,
    kind: h.kind === 'session' ? 'session' : 'log',
    status,
    params,
    createdAt: h.createdAt || null,
    startedAt: h.startedAt || null,
    finishedAt: h.finishedAt || null,
    mgmtCpu: num(h.mgmtCpu),
    error: status === 'failed' || status === 'rejected' ? { code, message: (h.message || 'PA 查詢失敗').slice(0, 300) } : null,
    result: rows ? { rows, count: rows.length, truncated: h.truncated === '1' } : null,
  };
}

export function createPaQueryService(store: PaQueryStore | null, now: () => number = Date.now) {
  const need = () => {
    if (!store) throw new AppError(409, 'NETOPS_PA_QUERY_DISABLED', 'PA 精準查詢未啟用(沒有設定 netops-redis)');
    return store;
  };
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw redisDown(err);
    }
  };

  async function state(owner: string): Promise<PaQueryState> {
    const s = need();
    return call(() => s.state(owner, now()));
  }

  async function submit(owner: string, body: PaQueryBody): Promise<PaQueryJob> {
    // 工號格式不符時不組 Redis 鍵(資安審查 C5 L7:原本被包成 424)
    if (!owner || !/^[\w:.-]{1,80}$/.test(owner)) throw new AppError(403, 'NETOPS_JOB_OWNER_UNKNOWN', '無法識別使用者,不能送出查詢');
    const params = validateQuery(body, now());
    const s = need();
    const st = await call(() => s.state(owner, now()));
    if (!st.executor) throw new AppError(409, 'NETOPS_PA_QUERY_DISABLED', 'PA 精準查詢未啟用(netops-pa 沒有開查詢執行者;測試區預設關閉)');
    if (!st.enabled) throw new AppError(409, 'NETOPS_PA_QUERY_DISABLED', 'PA 收集器(netops-pa)停止回報狀態,暫時無法查詢');
    if (st.mgmtCpu !== null && st.mgmtCpu > PAQ_MAX_MGMT_CPU) throw busy(30, `PA-560 管理平面 CPU ${st.mgmtCpu}% 超過 ${PAQ_MAX_MGMT_CPU}%,為保護設備暫停查詢,請稍後再試`);
    const id = randomUUID();
    const r = await call(() => s.submit(owner, id, body.kind, params));
    if (!r.ok) {
      const msg = r.reason === 'user-cooldown' ? `每人每 60 秒只能查一次,請 ${r.retryAfter} 秒後再試` : r.reason === 'global-cooldown' ? `PA 查詢間隔中,請 ${r.retryAfter} 秒後再試` : `已有 PA 查詢在執行(全系統一次一個),請 ${r.retryAfter} 秒後再試`;
      throw busy(r.retryAfter, msg);
    }
    return { id, kind: body.kind, status: 'queued', params, createdAt: new Date(now()).toISOString(), startedAt: null, finishedAt: null, mgmtCpu: null, error: null, result: null };
  }

  async function job(owner: string, id: string): Promise<PaQueryJob> {
    const s = need();
    const h = await call(() => s.job(id));
    // 別人的工作與不存在的一律 404,不透露是否存在
    if (!h || !owner || h.emp !== owner) throw new AppError(404, 'NETOPS_PA_QUERY_NOT_FOUND', '找不到這個查詢(可能已超過 10 分鐘),請重新送出');
    return toJob(id, h);
  }

  return { state, submit, job, close: () => store?.close() ?? Promise.resolve() };
}

export type PaQueryService = ReturnType<typeof createPaQueryService>;
