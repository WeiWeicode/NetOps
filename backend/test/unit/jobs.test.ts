/**
 * 長時間工作(infra/jobs,ARCHITECTURE D6、AGENT.md §7.3):本人才能查、上限、取消、逾時、過期
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../src/errors.js';
import { JobRunner, ownerOf, type JobContext } from '../../src/infra/jobs/index.js';

const tick = () => new Promise((r) => setImmediate(r));
const code = (c: string) => (err: unknown) => err instanceof AppError && err.code === c;

/** 等到 signal 中止才結束的工作 */
const untilAbort = ({ signal }: JobContext) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

describe('JobRunner', () => {
  it('完成後本人可取得結果;別人與不存在的 id 一律 404', async () => {
    const jobs = new JobRunner();
    const job = jobs.submit('test', 'S1', async ({ progress }) => {
      progress({ files: 1 });
      return { n: 42 };
    }, { timeoutMs: 1000 });
    assert.equal(job.status, 'running');
    await tick();
    const v = jobs.get<{ n: number }>(job.id, 'S1');
    assert.equal(v.status, 'done');
    assert.deepEqual(v.result, { n: 42 });
    assert.deepEqual(v.progress, { files: 1 });
    assert.ok(v.finishedAt);
    assert.throws(() => jobs.get(job.id, 'S2'), code('NETOPS_JOB_NOT_FOUND'));
    assert.throws(() => jobs.get('nope', 'S1'), code('NETOPS_JOB_NOT_FOUND'));
    assert.throws(() => jobs.get(job.id, 'S1', 'other-kind'), code('NETOPS_JOB_NOT_FOUND'));
  });

  it('每人進行中的工作有上限', () => {
    const jobs = new JobRunner({ maxActivePerOwner: 1 });
    jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    assert.throws(() => jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 }), code('NETOPS_JOB_LIMIT_EXCEEDED'));
    jobs.submit('t', 'S2', untilAbort, { timeoutMs: 5000 });
    jobs.close();
  });

  it('全部進行中的工作有上限;超過 concurrency 的排隊', () => {
    const jobs = new JobRunner({ maxActive: 2, concurrency: 1 });
    const a = jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    const b = jobs.submit('t', 'S2', untilAbort, { timeoutMs: 5000 });
    assert.equal(a.status, 'running');
    assert.equal(b.status, 'queued');
    assert.throws(() => jobs.submit('t', 'S3', untilAbort, { timeoutMs: 5000 }), code('NETOPS_JOB_LIMIT_EXCEEDED'));
    jobs.close();
  });

  it('取消執行中與排隊中的工作;重複取消不出錯', async () => {
    const jobs = new JobRunner({ concurrency: 1 });
    const a = jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    const b = jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    assert.equal(jobs.cancel(b.id, 'S1').status, 'cancelled');
    jobs.cancel(a.id, 'S1');
    await tick();
    assert.equal(jobs.get(a.id, 'S1').status, 'cancelled');
    assert.equal(jobs.cancel(a.id, 'S1').status, 'cancelled');
    assert.throws(() => jobs.cancel(a.id, 'S2'), code('NETOPS_JOB_NOT_FOUND'));
    assert.throws(() => jobs.result(a.id, 'S1'), code('NETOPS_JOB_NOT_DONE'));
  });

  it('超過執行時間上限時失敗,回 NETOPS_JOB_TIMEOUT', async () => {
    const jobs = new JobRunner();
    const j = jobs.submit('t', 'S1', untilAbort, { timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    const v = jobs.get(j.id, 'S1');
    assert.equal(v.status, 'failed');
    assert.equal(v.error?.code, 'NETOPS_JOB_TIMEOUT');
  });

  it('AppError 照實回報;其他錯誤不回傳內部訊息並通知 onError', async () => {
    const seen: unknown[] = [];
    const jobs = new JobRunner({}, (_k, err) => seen.push(err));
    const a = jobs.submit('t', 'S1', async () => {
      throw new AppError(503, 'NETOPS_FTP_UNAVAILABLE', 'FTP 連線失敗');
    }, { timeoutMs: 1000 });
    const b = jobs.submit('t', 'S1', async () => {
      throw new Error('ENOENT /srv/giga-netops/test/palogs');
    }, { timeoutMs: 1000 });
    await tick();
    assert.deepEqual(jobs.get(a.id, 'S1').error, { code: 'NETOPS_FTP_UNAVAILABLE', message: 'FTP 連線失敗' });
    assert.deepEqual(jobs.get(b.id, 'S1').error, { code: 'NETOPS_JOB_FAILED', message: '工作執行失敗' });
    assert.equal(seen.length, 1);
  });

  it('帶 cause 的已知錯誤:回應照實但不含原文,原文交給 onError 寫日誌', async () => {
    const seen: unknown[] = [];
    const jobs = new JobRunner({}, (_k, err) => seen.push(err));
    const e = Object.assign(new AppError(502, 'NETOPS_FTP_UNAVAILABLE', 'FTP 連線失敗:拒絕連線'), { cause: new Error('connect ECONNREFUSED 10.10.130.66:21') });
    const j = jobs.submit('t', 'S1', async () => {
      throw e;
    }, { timeoutMs: 1000 });
    await tick();
    assert.deepEqual(jobs.get(j.id, 'S1').error, { code: 'NETOPS_FTP_UNAVAILABLE', message: 'FTP 連線失敗:拒絕連線' });
    assert.equal(seen[0], e);
  });

  it('完成後超過保留時間就查不到(程序重啟同樣回 NETOPS_JOB_NOT_FOUND)', async () => {
    let now = 1_000_000;
    const jobs = new JobRunner({ retainMs: 1000, now: () => now });
    const j = jobs.submit('t', 'S1', async () => 1, { timeoutMs: 1000 });
    await tick();
    assert.equal(jobs.result(j.id, 'S1'), 1);
    now += 1001;
    assert.throws(() => jobs.get(j.id, 'S1'), code('NETOPS_JOB_NOT_FOUND'));
  });

  it('超過保留筆數時先丟最舊的已完成工作', async () => {
    const jobs = new JobRunner({ maxRetained: 2, maxActivePerOwner: 10, maxActive: 10 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(jobs.submit('t', 'S1', async () => i, { timeoutMs: 1000 }).id);
      await tick();
    }
    jobs.submit('t', 'S1', async () => 3, { timeoutMs: 1000 });
    await tick();
    assert.throws(() => jobs.get(ids[0]!, 'S1'), code('NETOPS_JOB_NOT_FOUND'));
    assert.equal(jobs.get(ids[2]!, 'S1').status, 'done');
  });

  it('擁有者以工號為主、沒有工號用 sub,兩者加前綴不會撞名;沒有身分時不能建立工作', () => {
    assert.equal(ownerOf({ emp: 'S112009', sub: '1' }), 'emp:S112009');
    assert.equal(ownerOf({ sub: 'S112009' }), 'sub:S112009');
    assert.throws(() => new JobRunner().submit('t', ownerOf(null), async () => 1, { timeoutMs: 1 }), code('NETOPS_JOB_OWNER_UNKNOWN'));
  });

  it('執行中的工作結束後,排隊的工作自動開始', async () => {
    const jobs = new JobRunner({ concurrency: 1 });
    let release!: () => void;
    const a = jobs.submit('t', 'S1', () => new Promise<number>((r) => (release = () => r(1))), { timeoutMs: 1000 });
    const b = jobs.submit('t', 'S2', async () => 2, { timeoutMs: 1000 });
    assert.equal(jobs.get(b.id, 'S2').status, 'queued');
    assert.throws(() => jobs.result(a.id, 'S1'), code('NETOPS_JOB_NOT_DONE'));
    release();
    await tick();
    await tick();
    assert.equal(jobs.get(a.id, 'S1').status, 'done');
    assert.equal(jobs.get(b.id, 'S2').status, 'done');
  });

  it('取消後狀態立即改變,但名額要等工作真正停止才釋放', async () => {
    const jobs = new JobRunner({ maxActivePerOwner: 1 });
    let stop!: () => void;
    // 不理會 signal 的工作:取消後仍在跑
    const a = jobs.submit('t', 'S1', () => new Promise<number>((r) => (stop = () => r(1))), { timeoutMs: 5000 });
    assert.equal(jobs.cancel(a.id, 'S1').status, 'cancelled');
    assert.throws(() => jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 }), code('NETOPS_JOB_LIMIT_EXCEEDED'));
    stop();
    await tick();
    await tick();
    assert.equal(jobs.get(a.id, 'S1').status, 'cancelled');
    jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    jobs.close();
  });

  it('取消後工作仍正常回傳時維持 cancelled,不會變成 done', async () => {
    const jobs = new JobRunner();
    let id = '';
    let seen!: AbortSignal;
    const j = jobs.submit('t', 'S1', async ({ signal }) => {
      await Promise.resolve();
      jobs.cancel(id, 'S1');
      seen = signal;
      return 1;
    }, { timeoutMs: 1000 });
    id = j.id;
    await tick();
    assert.ok(seen.aborted);
    assert.equal(jobs.get(j.id, 'S1').status, 'cancelled');
    assert.throws(() => jobs.result(j.id, 'S1'), code('NETOPS_JOB_NOT_DONE'));
  });

  it('close() 讓排隊與執行中的工作失敗,之後不接受新工作', async () => {
    const jobs = new JobRunner({ concurrency: 1 });
    const a = jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    const b = jobs.submit('t', 'S2', untilAbort, { timeoutMs: 5000 });
    jobs.close();
    await tick();
    for (const [id, o] of [[a.id, 'S1'], [b.id, 'S2']] as const) {
      const v = jobs.get(id, o);
      assert.equal(v.status, 'failed');
      assert.equal(v.error?.code, 'NETOPS_JOB_ABORTED');
    }
    assert.throws(() => jobs.submit('t', 'S3', untilAbort, { timeoutMs: 5000 }), code('NETOPS_JOB_ABORTED'));
  });

  it('每人保留的已完成工作有上限,只丟自己最舊的', async () => {
    const jobs = new JobRunner({ maxRetainedPerOwner: 2, maxActivePerOwner: 10, maxActive: 10 });
    const other = jobs.submit('t', 'S2', async () => 0, { timeoutMs: 1000 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(jobs.submit('t', 'S1', async () => i, { timeoutMs: 1000 }).id);
      await tick();
    }
    assert.throws(() => jobs.get(ids[0]!, 'S1'), code('NETOPS_JOB_NOT_FOUND'));
    assert.equal(jobs.get(ids[2]!, 'S1').status, 'done');
    assert.equal(jobs.get(other.id, 'S2').status, 'done');
  });

  it('discard:已結束的工作取消時直接移除;執行中的照常取消', async () => {
    const jobs = new JobRunner();
    const done = jobs.submit('t', 'S1', async () => 1, { timeoutMs: 1000 });
    await tick();
    jobs.cancel(done.id, 'S1', undefined, { discard: true });
    assert.throws(() => jobs.get(done.id, 'S1'), code('NETOPS_JOB_NOT_FOUND'));
    const running = jobs.submit('t', 'S1', untilAbort, { timeoutMs: 5000 });
    assert.equal(jobs.cancel(running.id, 'S1', undefined, { discard: true }).status, 'cancelled');
  });

  it('timeoutMs 超出範圍時拒絕(避免 setTimeout 溢位立刻觸發)', () => {
    const jobs = new JobRunner();
    for (const t of [0, -1, Number.NaN, 2 ** 31]) assert.throws(() => jobs.submit('t', 'S1', async () => 1, { timeoutMs: t }), /timeoutMs/);
  });

  it('查詢回傳複本,改動不影響工作', async () => {
    const jobs = new JobRunner();
    const j = jobs.submit('t', 'S1', async ({ progress }) => (progress({ n: 1 }), 1), { timeoutMs: 1000 });
    await tick();
    const v = jobs.get(j.id, 'S1');
    v.progress!.n = 99;
    assert.deepEqual(jobs.get(j.id, 'S1').progress, { n: 1 });
  });
});
