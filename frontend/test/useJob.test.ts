import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { ApiError } from '@/api/gateway';
import type { Job } from '@/api/jobs';
import { POLL_MS, useJob } from '@/composables/useJob';

const job = (status: Job['status'], o: Partial<Job<string>> = {}): Job<string> => ({
  id: 'j1',
  kind: 'test',
  status,
  createdAt: '2026-11-03T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  progress: null,
  error: null,
  result: null,
  ...o,
});

function setup(gets: (Job<string> | Error)[]) {
  const api = {
    create: vi.fn(async () => job('running')),
    get: vi.fn(async () => {
      const r = gets.shift() ?? job('running');
      if (r instanceof Error) throw r;
      return r;
    }),
    cancel: vi.fn(async () => undefined),
  };
  const scope = effectScope();
  const j = scope.run(() => useJob<undefined, string>(api))!;
  return { api, j, scope };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useJob', () => {
  it('查詢到完成為止,完成後停止並給 result', async () => {
    const { api, j } = setup([job('running'), job('done', { result: 'ok' })]);
    await j.start(undefined);
    expect(j.running.value).toBe(true);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(j.result.value).toBeNull();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(j.result.value).toBe('ok');
    expect(j.running.value).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('工作失敗:error 用說明文字', async () => {
    const { j } = setup([job('failed', { error: { code: 'NETOPS_JOB_TIMEOUT', message: 'timeout' } })]);
    await j.start(undefined);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(j.error.value?.message).toBe('工作超過執行時間上限');
    expect(j.running.value).toBe(false);
  });

  it('服務重新啟動(404 NETOPS_JOB_NOT_FOUND):提示重新送出', async () => {
    const { j } = setup([new ApiError(404, 'NETOPS_JOB_NOT_FOUND', 'not found', 'r1')]);
    await j.start(undefined);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(j.error.value?.message).toContain('重新送出');
    expect((j.error.value as ApiError).requestId).toBe('r1');
    // 查不到就停止,畫面不再顯示進行中
    expect(j.running.value).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  });

  it('建立期間就離開頁面:工作回來後立即取消,不佔名額', async () => {
    const { api, j, scope } = setup([]);
    let resolve!: (v: Job<string>) => void;
    api.create.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const started = j.start(undefined);
    scope.stop();
    resolve(job('running', { id: 'late' }));
    await started;
    expect(api.cancel).toHaveBeenCalledWith('late');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('建立失敗(409 名額已滿)', async () => {
    const { api, j } = setup([]);
    api.create.mockRejectedValueOnce(new ApiError(409, 'NETOPS_JOB_LIMIT_EXCEEDED', 'limit', null));
    await j.start(undefined);
    expect(j.error.value?.message).toContain('每人 2 個');
    expect(j.running.value).toBe(false);
  });

  it('離開頁面(scope 結束)時取消進行中的工作', async () => {
    const { api, j, scope } = setup([]);
    await j.start(undefined);
    scope.stop();
    expect(api.cancel).toHaveBeenCalledWith('j1');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('已完成的工作不再呼叫取消', async () => {
    const { api, j, scope } = setup([job('done', { result: 'ok' })]);
    await j.start(undefined);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    scope.stop();
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
