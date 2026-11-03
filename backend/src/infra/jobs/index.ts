/**
 * 長時間工作(ARCHITECTURE D6、AGENT.md §7.3):超過路由逾時的操作改成「送出工作 → 查詢結果」。
 *   - 工作只有建立者本人可查、可取消(比對工號);別人的工作與不存在的工作一律回 404,不透露是否存在
 *   - 有數量上限(每人進行中、全部進行中、保留筆數)與執行秒數上限
 *   - 取消、逾時後狀態立即改變,但名額要等工作真正停止(run 結束)才釋放,避免反覆送出 → 取消累積背景工作
 *   - 只存在記憶體:程序重啟後失效,查詢時回明確的 NETOPS_JOB_NOT_FOUND(單一容器,D9)
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobContext {
  /** 取消、逾時、服務關閉時中止;工作內的 FTP 掃描等要配合停止並中斷連線 */
  signal: AbortSignal;
  /** 更新進度(查詢時原樣回傳,不放路徑等內部資訊) */
  progress(p: Record<string, unknown>): void;
}

export interface JobView<R = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  result: R | null;
}

interface Job<R = unknown> extends JobView<R> {
  owner: string;
  controller: AbortController;
  run: (ctx: JobContext) => Promise<R>;
  timeoutMs: number;
  expiresAt: number;
  /** run 已結束(或從未開始):名額只看這個,不看 status */
  settled: boolean;
}

export interface JobRunnerOptions {
  /** 每人同時進行中(排隊 + 執行)的工作數 */
  maxActivePerOwner?: number;
  /** 全部進行中的工作數 */
  maxActive?: number;
  /** 同時執行的工作數(其餘排隊) */
  concurrency?: number;
  /** 完成後保留多久可查詢 */
  retainMs?: number;
  /** 最多保留幾筆(含已完成;超過時先丟最舊的已完成工作) */
  maxRetained?: number;
  /** 每人最多保留幾筆已完成的工作(超過時先丟自己最舊的,不影響別人的結果) */
  maxRetainedPerOwner?: number;
  now?: () => number;
}

export const JOB_DEFAULTS = { maxActivePerOwner: 2, maxActive: 6, concurrency: 2, retainMs: 30 * 60_000, maxRetained: 100, maxRetainedPerOwner: 10 } as const;
/** 執行時間上限的範圍(setTimeout 超過 2^31-1 會立刻觸發) */
const MAX_TIMEOUT_MS = 60 * 60_000;

/** 工作執行失敗時給使用者看的訊息:AppError 照實回報,其他錯誤不回傳內部細節 */
const toError = (err: unknown): { code: string; message: string } =>
  err instanceof AppError ? { code: err.code, message: err.message } : { code: 'NETOPS_JOB_FAILED', message: '工作執行失敗' };

const CANCELLED = 'NETOPS_JOB_CANCELLED';

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private closed = false;
  private readonly opt: Required<Omit<JobRunnerOptions, 'now'>>;
  private readonly now: () => number;

  constructor(options: JobRunnerOptions = {}, private readonly onError?: (kind: string, err: unknown) => void) {
    const { now, ...rest } = options;
    this.opt = { ...JOB_DEFAULTS, ...rest };
    this.now = now ?? Date.now;
  }

  /** 送出工作;超過上限回 409 NETOPS_JOB_LIMIT_EXCEEDED */
  submit<R>(kind: string, owner: string, run: (ctx: JobContext) => Promise<R>, { timeoutMs }: { timeoutMs: number }): JobView<R> {
    if (this.closed) throw new AppError(503, 'NETOPS_JOB_ABORTED', '服務正在關閉,請稍後再試');
    if (!owner) throw new AppError(403, 'NETOPS_JOB_OWNER_UNKNOWN', '無法識別使用者,不能建立工作');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeoutMs 必須是 1–${MAX_TIMEOUT_MS}:${timeoutMs}`);
    this.sweep();
    const active = [...this.jobs.values()].filter((j) => !j.settled);
    if (active.filter((j) => j.owner === owner).length >= this.opt.maxActivePerOwner)
      throw new AppError(409, 'NETOPS_JOB_LIMIT_EXCEEDED', `每人最多同時 ${this.opt.maxActivePerOwner} 個工作,請等候完成或先取消`);
    if (active.length >= this.opt.maxActive) throw new AppError(409, 'NETOPS_JOB_LIMIT_EXCEEDED', '系統工作已滿,請稍後再試');
    // 每人保留的已完成工作有上限(新工作完成後最多保留 maxRetainedPerOwner 筆)
    const mine = [...this.jobs.values()].filter((j) => j.owner === owner && j.settled).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const j of mine.slice(0, Math.max(0, mine.length - this.opt.maxRetainedPerOwner + 1))) this.jobs.delete(j.id);
    const job: Job<R> = {
      id: randomUUID(),
      kind,
      owner,
      status: 'queued',
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      result: null,
      controller: new AbortController(),
      run,
      timeoutMs,
      expiresAt: Number.POSITIVE_INFINITY,
      settled: false,
    };
    this.jobs.set(job.id, job as Job);
    this.queue.push(job as Job);
    this.pump();
    return this.view(job);
  }

  /** 建立者本人查詢;不存在、已逾期或不是本人都回 404 */
  get<R>(id: string, owner: string, kind?: string): JobView<R> {
    return this.view(this.find(id, owner, kind) as Job<R>);
  }

  /**
   * 取消:狀態立即改為 cancelled(已結束的工作不變);不存在或不是本人回 404(路由層決定是否視為成功)
   * discard:已結束的工作直接移除(釋放結果佔用的記憶體)
   */
  cancel(id: string, owner: string, kind?: string, { discard = false }: { discard?: boolean } = {}): JobView {
    const job = this.find(id, owner, kind);
    if (discard && job.settled) {
      this.jobs.delete(id);
      return this.view(job);
    }
    if (job.status === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.settled = true;
      this.finish(job, 'cancelled');
    } else if (job.status === 'running') {
      // abort 會同步觸發 execute 的 onAbort,狀態立即改為 cancelled
      job.controller.abort(new AppError(409, CANCELLED, '工作已取消'));
    }
    return this.view(job);
  }

  /** 已完成工作的結果(給分頁、匯出用);尚未完成回 409 */
  result<R>(id: string, owner: string, kind?: string): R {
    const job = this.find(id, owner, kind);
    if (job.status !== 'done') throw new AppError(409, 'NETOPS_JOB_NOT_DONE', job.status === 'failed' || job.status === 'cancelled' ? '工作未成功完成,沒有結果' : '工作尚未完成');
    return job.result as R;
  }

  /** 關閉服務:中止全部工作,之後不再接受新工作 */
  close(): void {
    this.closed = true;
    const reason = new AppError(503, 'NETOPS_JOB_ABORTED', '服務關閉,工作已中止');
    for (const j of this.queue.splice(0)) {
      j.settled = true;
      j.error = toError(reason);
      this.finish(j, 'failed');
    }
    for (const j of this.jobs.values()) if (j.status === 'running') j.controller.abort(reason);
  }

  private find(id: string, owner: string, kind?: string): Job {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || (kind && job.kind !== kind)) throw new AppError(404, 'NETOPS_JOB_NOT_FOUND', '找不到這個工作(可能已逾期,或服務重新啟動後失效),請重新送出');
    return job;
  }

  /** 回傳複本,呼叫端改動不影響工作內容 */
  private view<R>(j: Job<R>): JobView<R> {
    const { id, kind, status, createdAt, startedAt, finishedAt, progress, error } = j;
    return {
      id,
      kind,
      status,
      createdAt,
      startedAt,
      finishedAt,
      progress: progress && { ...progress },
      error: error && { ...error },
      result: status === 'done' ? j.result : null,
    };
  }

  private pump(): void {
    while (this.running < this.opt.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.execute(job).finally(() => {
        job.settled = true;
        this.running--;
        this.pump();
      });
    }
  }

  /** 回傳的 Promise 在 run 真正結束後才 resolve(名額在那之後才釋放) */
  private async execute(job: Job): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date(this.now()).toISOString();
    const { signal } = job.controller;
    const timer = setTimeout(() => job.controller.abort(new AppError(504, 'NETOPS_JOB_TIMEOUT', '工作超過執行時間上限,已中止')), job.timeoutMs);
    timer.unref?.();
    // 中止時狀態立即改變(查詢看得到),不必等 run 結束
    const onAbort = () => {
      if (job.status !== 'running') return;
      const reason = signal.reason;
      if (reason instanceof AppError && reason.code === CANCELLED) return this.finish(job, 'cancelled');
      job.error = toError(reason);
      this.finish(job, 'failed');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      // 先檢查:run 開始前就已中止時,'abort' 事件不會再觸發
      if (signal.aborted) throw signal.reason;
      const result = await job.run({ signal, progress: (p) => void (job.progress = p) });
      if (job.status === 'running') {
        job.result = result;
        this.finish(job, 'done');
      }
    } catch (err) {
      if (job.status === 'running') {
        if (!(err instanceof AppError)) this.onError?.(job.kind, err);
        job.error = toError(signal.aborted ? signal.reason : err);
        this.finish(job, 'failed');
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private finish(job: Job, status: JobStatus): void {
    job.status = status;
    job.finishedAt = new Date(this.now()).toISOString();
    job.expiresAt = this.now() + this.opt.retainMs;
  }

  /** 清掉逾期且已停止的工作;超過保留筆數時先丟最舊的已完成工作 */
  private sweep(): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.settled && j.expiresAt <= t) this.jobs.delete(id);
    if (this.jobs.size <= this.opt.maxRetained) return;
    const done = [...this.jobs.values()].filter((j) => j.settled).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const j of done.slice(0, this.jobs.size - this.opt.maxRetained)) this.jobs.delete(j.id);
  }
}

/** 工作的擁有者:比對工號(AGENT.md §7.3);系統對系統呼叫沒有工號時用 sub。加前綴避免兩者撞名 */
export const ownerOf = (identity: { emp?: string; sub: string } | null): string =>
  identity?.emp ? `emp:${identity.emp}` : identity?.sub ? `sub:${identity.sub}` : '';
