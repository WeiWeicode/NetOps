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

  it('沒有工號時以 sub 為擁有者;沒有身分時不能建立工作', () => {
    assert.equal(ownerOf({ emp: 'S112009', sub: '1' }), 'S112009');
    assert.equal(ownerOf({ sub: 'client:x' }), 'client:x');
    assert.throws(() => new JobRunner().submit('t', ownerOf(null), async () => 1, { timeoutMs: 1 }), code('DATA_ACCESS_DENIED'));
  });
});
