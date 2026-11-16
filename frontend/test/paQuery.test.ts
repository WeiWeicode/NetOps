/**
 * C5 PA 精準查詢(usePaQuery):沒有按鈕權限不呼叫 API、送出 → 輪詢到完成、429 倒數、rejected、最近 log 的時間視窗 ≤ 15 分鐘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { ApiError } from '@/api/gateway';
import type { PaQueryJob } from '@/api/paQuery';
import { usePaQuery } from '@/composables/usePaQuery';

const m = vi.hoisted(() => ({ status: vi.fn(), submit: vi.fn(), job: vi.fn(), perms: new Set<string>(['netops.pa-live.query']) }));
vi.mock('@/api/paQuery', () => ({ paQuery: { status: m.status, submit: m.submit, job: m.job } }));
vi.mock('@/api/gateway', async (orig) => ({ ...(await orig<typeof import('@/api/gateway')>()), can: (c: string) => m.perms.has(c) }));

const NOW = Date.parse('2026-11-12T10:00:00+08:00');
const job = (status: PaQueryJob['status'], o: Partial<PaQueryJob> = {}): PaQueryJob => ({
  id: 'j1', kind: 'session', status, params: {}, createdAt: null, startedAt: null, finishedAt: null, mgmtCpu: null, error: null, result: null, ...o,
});
const setup = () => {
  const scope = effectScope();
  const q = scope.run(() => usePaQuery({ now: () => NOW }))!;
  return { q, scope };
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const f of [m.status, m.submit, m.job]) f.mockReset();
  m.perms = new Set(['netops.pa-live.query']);
  m.status.mockResolvedValue({ enabled: true, executor: true, heartbeatAgeSec: 2, activeSec: 0, globalCoolSec: 0, userCoolSec: 0, mgmtCpu: 4 });
});
afterEach(() => vi.useRealTimers());

describe('usePaQuery', () => {
  it('沒有按鈕權限(viewer):canQuery false,不呼叫任何 API', async () => {
    m.perms = new Set();
    const { q } = setup();
    await q.refreshState();
    await q.session('10.0.0.1');
    expect(q.canQuery.value).toBe(false);
    expect(m.status).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('送出 → waiting → 每 2 秒輪詢到 done;完成後重新讀狀態', async () => {
    m.submit.mockResolvedValue(job('queued'));
    m.job.mockResolvedValueOnce(job('running')).mockResolvedValueOnce(job('done', { result: { rows: [{ src: '10.0.0.1' }], count: 1, truncated: false } }));
    const { q } = setup();
    await q.refreshState();
    expect(q.ready.value).toBe(true);
    await q.session('10.0.0.1', 'dst');
    expect(m.submit).toHaveBeenCalledWith({ kind: 'session', ip: '10.0.0.1', direction: 'dst' });
    expect(q.state.value).toBe('waiting');
    expect(q.ready.value).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(q.state.value).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(q.state.value).toBe('done');
    expect(q.job.value?.result?.count).toBe(1);
    expect(m.status).toHaveBeenCalledTimes(2);
  });

  it('429:busy 並倒數 details.retryAfter;倒數中 ready 為 false', async () => {
    m.submit.mockRejectedValue(new ApiError(429, 'NETOPS_PA_QUERY_BUSY', '忙碌', 'r', { retryAfter: 3 }));
    const { q } = setup();
    await q.refreshState();
    await q.session('10.0.0.1');
    expect(q.state.value).toBe('busy');
    expect(q.waitSec.value).toBe(3);
    expect(q.ready.value).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(q.retryAfter.value).toBe(0);
    expect(q.ready.value).toBe(true);
  });

  it('rejected(管理平面 CPU 過高)與 failed 保留錯誤訊息', async () => {
    m.submit.mockResolvedValue(job('queued'));
    m.job.mockResolvedValue(job('rejected', { error: { code: 'NETOPS_PA_QUERY_CPU_HIGH', message: 'CPU 過高' } }));
    const { q } = setup();
    await q.session('10.0.0.1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(q.state.value).toBe('rejected');
    expect(q.job.value?.error?.code).toBe('NETOPS_PA_QUERY_CPU_HIGH');
  });

  it('最近 log:時間視窗最多 15 分鐘、結束在現在', async () => {
    m.submit.mockResolvedValue(job('queued', { kind: 'log' }));
    const { q } = setup();
    await q.recentLog('10.0.0.1', 60, 'threat');
    const b = m.submit.mock.calls[0]![0];
    expect(b).toMatchObject({ kind: 'log', ip: '10.0.0.1', logType: 'threat' });
    expect(Date.parse(b.to) - Date.parse(b.from)).toBe(15 * 60_000);
    expect(Date.parse(b.to)).toBe(NOW);
  });

  it('完成後冷卻 60 秒:剩餘秒數會遞減,歸零後重新讀狀態、ready 恢復(審查 #1)', async () => {
    let t = NOW;
    m.status.mockResolvedValueOnce({ enabled: true, executor: true, heartbeatAgeSec: 2, activeSec: 0, globalCoolSec: 0, userCoolSec: 60, mgmtCpu: 4 });
    const scope = effectScope();
    const q = scope.run(() => usePaQuery({ now: () => t }))!;
    await q.refreshState();
    expect(q.waitSec.value).toBe(60);
    for (let i = 0; i < 61; i++) {
      t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(q.waitSec.value).toBe(0);
    expect(m.status).toHaveBeenCalledTimes(2);
    expect(q.ready.value).toBe(true);
    scope.stop();
  });

  it('輪詢單次失敗不放棄;429 倒數結束後不再是錯誤(審查 #3、#4)', async () => {
    m.submit.mockResolvedValueOnce(job('queued'));
    m.job.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(job('done', { result: { rows: [], count: 0, truncated: false } }));
    const { q } = setup();
    await q.session('10.0.0.1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(q.state.value).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(q.state.value).toBe('done');
    m.submit.mockRejectedValueOnce(new ApiError(429, 'NETOPS_PA_QUERY_BUSY', '忙碌', 'r', { retryAfter: 2 }));
    await q.session('10.0.0.1');
    expect(q.state.value).toBe('busy');
    await vi.advanceTimersByTimeAsync(2000);
    expect(q.error.value).toBeNull();
    expect(q.state.value).toBe('idle');
  });

  it('執行者未啟用或還在冷卻:ready 為 false;離開頁面停止輪詢', async () => {
    m.status.mockResolvedValue({ enabled: true, executor: true, heartbeatAgeSec: 2, activeSec: 0, globalCoolSec: 0, userCoolSec: 42, mgmtCpu: 4 });
    const { q, scope } = setup();
    await q.refreshState();
    expect(q.waitSec.value).toBe(42);
    expect(q.ready.value).toBe(false);
    m.submit.mockResolvedValue(job('queued'));
    m.job.mockResolvedValue(job('running'));
    await q.session('10.0.0.1');
    scope.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.job).not.toHaveBeenCalled();
  });
});
