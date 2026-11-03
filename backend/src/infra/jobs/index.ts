/**
 * 長時間工作(ARCHITECTURE D6、AGENT.md §7.3):超過路由逾時的操作改成「送出工作 → 查詢結果」。
 *   - 工作只有建立者本人可查、可取消(比對 emp);別人的工作與不存在的工作一律回 404,不透露是否存在
 *   - 有數量上限(每人進行中、全部進行中、保留筆數)與執行秒數上限
 *   - 只存在記憶體:程序重啟後失效,查詢時回明確的 NETOPS_JOB_NOT_FOUND(單一容器,D9)
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobContext {
  /** 取消、逾時時中止;工作內的 FTP 掃描等要配合停止 */
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
  now?: () => number;
}

export const JOB_DEFAULTS = { maxActivePerOwner: 2, maxActive: 6, concurrency: 2, retainMs: 30 * 60_000, maxRetained: 100 } as const;

/** 工作執行失敗時給使用者看的訊息:AppError 照實回報,其他錯誤不回傳內部細節 */
const toError = (err: unknown): { code: string; message: string } =>
  err instanceof AppError ? { code: err.code, message: err.message } : { code: 'NETOPS_JOB_FAILED', message: '工作執行失敗' };

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private readonly opt: Required<Omit<JobRunnerOptions, 'now'>>;
  private readonly now: () => number;

  constructor(options: JobRunnerOptions = {}, private readonly onError?: (kind: string, err: unknown) => void) {
    const { now, ...rest } = options;
    this.opt = { ...JOB_DEFAULTS, ...rest };
    this.now = now ?? Date.now;
  }

  /** 送出工作;超過上限回 409 NETOPS_JOB_LIMIT_EXCEEDED */
  submit<R>(kind: string, owner: string, run: (ctx: JobContext) => Promise<R>, { timeoutMs }: { timeoutMs: number }): JobView<R> {
    if (!owner) throw new AppError(403, 'DATA_ACCESS_DENIED', '無法識別使用者,不能建立工作');
    this.sweep();
    const active = [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
    if (active.filter((j) => j.owner === owner).length >= this.opt.maxActivePerOwner)
      throw new AppError(409, 'NETOPS_JOB_LIMIT_EXCEEDED', `每人最多同時 ${this.opt.maxActivePerOwner} 個工作,請等候完成或先取消`);
    if (active.length >= this.opt.maxActive) throw new AppError(409, 'NETOPS_JOB_LIMIT_EXCEEDED', '系統工作已滿,請稍後再試');
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

  /** 取消(冪等:已結束的工作不變);不存在或不是本人回 404 */
  cancel(id: string, owner: string, kind?: string): JobView {
    const job = this.find(id, owner, kind);
    if (job.status === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1);
      this.finish(job, 'cancelled');
    } else if (job.status === 'running') job.controller.abort(new AppError(409, 'NETOPS_JOB_CANCELLED', '工作已取消'));
    return this.view(job);
  }

  /** 已完成工作的結果(給匯出、分頁用);尚未完成回 409 */
  result<R>(id: string, owner: string, kind?: string): R {
    const job = this.find(id, owner, kind);
    if (job.status !== 'done') throw new AppError(409, 'NETOPS_JOB_NOT_DONE', job.status === 'failed' || job.status === 'cancelled' ? '工作未成功完成,沒有結果' : '工作尚未完成');
    return job.result as R;
  }

  /** 關閉服務時中止全部工作 */
  close(): void {
    this.queue.length = 0;
    for (const j of this.jobs.values()) if (j.status === 'running' || j.status === 'queued') j.controller.abort(new AppError(503, 'NETOPS_JOB_ABORTED', '服務關閉,工作已中止'));
  }

  private find(id: string, owner: string, kind?: string): Job {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || (kind && job.kind !== kind)) throw new AppError(404, 'NETOPS_JOB_NOT_FOUND', '找不到這個工作(可能已逾期,或服務重新啟動後失效),請重新送出');
    return job;
  }

  private view<R>(j: Job<R>): JobView<R> {
    const { id, kind, status, createdAt, startedAt, finishedAt, progress, error, result } = j;
    return { id, kind, status, createdAt, startedAt, finishedAt, progress, error, result: status === 'done' ? result : null };
  }

  private pump(): void {
    while (this.running < this.opt.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date(this.now()).toISOString();
    const timer = setTimeout(() => job.controller.abort(new AppError(504, 'NETOPS_JOB_TIMEOUT', '工作超過執行時間上限,已中止')), job.timeoutMs);
    timer.unref?.();
    try {
      const result = await Promise.race([
        job.run({ signal: job.controller.signal, progress: (p) => void (job.progress = p) }),
        new Promise<never>((_, reject) => job.controller.signal.addEventListener('abort', () => reject(job.controller.signal.reason), { once: true })),
      ]);
      job.result = result;
      this.finish(job, 'done');
    } catch (err) {
      const aborted = job.controller.signal.aborted;
      const reason = aborted ? job.controller.signal.reason : err;
      if (aborted && reason instanceof AppError && reason.code === 'NETOPS_JOB_CANCELLED') return this.finish(job, 'cancelled');
      if (!(reason instanceof AppError)) this.onError?.(job.kind, reason);
      job.error = toError(reason);
      this.finish(job, 'failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(job: Job, status: JobStatus): void {
    job.status = status;
    job.finishedAt = new Date(this.now()).toISOString();
    job.expiresAt = this.now() + this.opt.retainMs;
  }

  /** 清掉逾期的已完成工作;超過保留筆數時先丟最舊的已完成工作 */
  private sweep(): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.expiresAt <= t) this.jobs.delete(id);
    if (this.jobs.size <= this.opt.maxRetained) return;
    const done = [...this.jobs.values()].filter((j) => Number.isFinite(j.expiresAt)).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const j of done.slice(0, this.jobs.size - this.opt.maxRetained)) this.jobs.delete(j.id);
  }
}

/** 工作的擁有者:比對工號(AGENT.md §7.3);系統對系統呼叫沒有工號時用 sub */
export const ownerOf = (identity: { emp?: string; sub: string } | null): string => identity?.emp || identity?.sub || '';
