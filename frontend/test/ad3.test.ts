// @vitest-environment happy-dom
/**
 * AD-3 前端純函式與輪詢 composable 單元測試:
 *   - adEvents:isDcToken、fieldValidationError、collectDcOptions、錯誤判斷
 *   - adAgents:30 秒輪詢、頁面隱藏時停止、重新顯示立即查詢、scope 結束清除
 *   - adReconcile:backfillErrorTitle、defaultReconRange、2 秒工作輪詢隱藏停止與完成停止
 *   - GSourceBadge:agent「⚡ 即時」、ftp「FTP 補寫」與既有 hot/cold/mixed 相容
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { ApiError } from '@/api/gateway';
import { collectDcOptions, fieldValidationError, isClickHouseUnavailable, isDcToken, isRedisUnavailable } from '@/composables/adEvents';
import { useAdAgents } from '@/composables/adAgents';
import { backfillErrorTitle, defaultReconRange, useAdReconcile } from '@/composables/adReconcile';
import GSourceBadge from '@/ui/components/GSourceBadge.vue';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  reconList: vi.fn(),
  reconRun: vi.fn(),
  reconBackfill: vi.fn(),
  reconJob: vi.fn(),
}));

vi.mock('@/api/ad', async (orig) => {
  const real = await orig<typeof import('@/api/ad')>();
  return {
    ...real,
    ad: { ...real.ad, agents: api.agents },
    adRecon: { list: api.reconList, run: api.reconRun, backfill: api.reconBackfill, job: api.reconJob },
  };
});

function setHidden(v: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setHidden(false);
});

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('adEvents 純函式(AD-3)', () => {
  it('isDcToken 與 collectDcOptions', () => {
    expect(isDcToken('GSMC-DC1.gsmc.com.tw', 64)).toBe(true);
    expect(isDcToken('bad space', 64)).toBe(false);
    expect(isDcToken('a'.repeat(65), 64)).toBe(false);
    expect(isDcToken('a'.repeat(253), 253)).toBe(true);
    expect(collectDcOptions(['GSMC-DC2', 'GSMC-DC1'], [['GSMC-DC1', 'GSC-DC3'], undefined])).toEqual([
      { label: 'GSC-DC3', value: 'GSC-DC3' },
      { label: 'GSMC-DC1', value: 'GSMC-DC1' },
      { label: 'GSMC-DC2', value: 'GSMC-DC2' },
    ]);
  });

  it('fieldValidationError 與錯誤碼判斷', () => {
    const err = new ApiError(400, 'VALIDATION_FAILED', '驗證失敗', 'req-1234567890ab-extra', [{ field: 'name', message: 'IP 對照表沒有符合的使用者姓名' }]);
    expect(fieldValidationError(err, 'name')).toBe('IP 對照表沒有符合的使用者姓名(requestId req-12345678)');
    expect(fieldValidationError(err, 'other')).toBe('');
    expect(isClickHouseUnavailable(new ApiError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'ch down', null))).toBe(true);
    expect(isRedisUnavailable(new ApiError(424, 'NETOPS_REDIS_UNAVAILABLE', 'redis down', null))).toBe(true);
  });
});

describe('useAdAgents 輪詢生命週期', () => {
  const okResp = { items: [], summary: { total: 0, ok: 0, stale: 0, offline: 0, unknown: 0, wrapRisk: 0 }, staleSec: 90, offlineSec: 180, source: 'clickhouse' as const };

  it('30 秒輪詢、頁面隱藏時停止、重新顯示立即重查、離開 scope 清除', async () => {
    api.agents.mockResolvedValue(okResp);
    const enabled = ref(true);
    const scope = effectScope();
    scope.run(() => useAdAgents(enabled, 30_000));

    await flushPromises();
    expect(api.agents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(api.agents).toHaveBeenCalledTimes(2);

    // 頁面隱藏 → 停止輪詢,經過 120 秒都不再發請求
    setHidden(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(api.agents).toHaveBeenCalledTimes(2);

    // 重新顯示 → 立刻再查一次並恢復輪詢
    setHidden(false);
    await flushPromises();
    expect(api.agents).toHaveBeenCalledTimes(3);

    // 離開頁面(scope 結束)→ 完全清除
    scope.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(api.agents).toHaveBeenCalledTimes(3);
  });
});

describe('useAdReconcile 補漏工作輪詢與錯誤工具', () => {
  it('backfillErrorTitle 與 defaultReconRange', () => {
    expect(backfillErrorTitle(new ApiError(409, 'NETOPS_RECON_PENDING', 'x', null))).toBe('FTP 檔案尚未匯入');
    expect(backfillErrorTitle(new ApiError(409, 'NETOPS_BACKFILL_NOTHING', 'x', null))).toBe('沒有需要補漏的項目');
    expect(backfillErrorTitle(new ApiError(409, 'NETOPS_BACKFILL_BUSY', 'x', null))).toBe('補漏佇列已滿');
    expect(backfillErrorTitle(new ApiError(424, 'NETOPS_REDIS_UNAVAILABLE', 'x', null))).toBe('Redis 暫時無法使用');
    const r = defaultReconRange(Date.parse('2026-11-24T10:00:00+08:00'));
    expect(r.to).toBe('2026-11-24');
    expect(r.from).toBe('2026-08-26');
  });

  it('補漏工作每 2 秒輪詢、隱藏停止、done 後重跑對帳並停止', async () => {
    const jobBase = {
      id: 'j1',
      day: '2026-11-23',
      files: ['Security_GSMC-DC1.csv'],
      scope: [{ computer: 'GSMC-DC1', channel: 'Security' }],
      createdBy: 'admin',
      createdAt: '2026-11-24T01:00:00+08:00',
      startedAt: '2026-11-24T01:00:01+08:00',
      finishedAt: null,
      read: 10,
      skipped: 8,
      inserted: 2,
      waitingAgent: 0,
      ambiguous: 0,
      invalid: 0,
      error: null,
    };
    api.reconBackfill.mockResolvedValue({ ...jobBase, state: 'queued' });
    api.reconJob
      .mockResolvedValueOnce({ ...jobBase, state: 'running' })
      .mockResolvedValueOnce({ ...jobBase, state: 'done', finishedAt: '2026-11-24T01:00:05+08:00' });
    api.reconRun.mockResolvedValue({
      day: '2026-11-23',
      checkedAt: '2026-11-24T01:00:06+08:00',
      status: 'ok',
      ftpFiles: 1,
      gaps: 0,
      excess: 0,
      items: [],
      backfills: ['j1'],
    });

    const scope = effectScope();
    const rec = scope.run(() => useAdReconcile(2_000))!;
    await rec.startBackfill('2026-11-23');
    expect(api.reconJob).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(api.reconJob).toHaveBeenCalledTimes(1);

    // 隱藏分頁 → 停止輪詢
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(api.reconJob).toHaveBeenCalledTimes(1);

    // 恢復顯示 → 立刻再查 → done 後重跑 runDay 並停止輪詢
    setHidden(false);
    await flushPromises();
    expect(api.reconJob).toHaveBeenCalledTimes(2);
    expect(api.reconRun).toHaveBeenCalledWith('2026-11-23');

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(api.reconJob).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('載入時已完成的補漏工作不自動重新對帳;進行中轉完成若重對帳失敗記於 dayError;防重疊請求與空 day(審查 M1、Low 1)', async () => {
    const doneJob = {
      id: 'j-done',
      day: '2026-11-23',
      files: ['Security_GSMC-DC1.csv'],
      scope: [{ computer: 'GSMC-DC1', channel: 'Security' }],
      state: 'done' as const,
      createdBy: 'admin',
      createdAt: '2026-11-24T01:00:00+08:00',
      startedAt: '2026-11-24T01:00:01+08:00',
      finishedAt: '2026-11-24T01:00:05+08:00',
      read: 10,
      skipped: 8,
      inserted: 2,
      waitingAgent: 0,
      ambiguous: 0,
      invalid: 0,
      error: null,
    };
    api.reconList.mockResolvedValue({
      window: { from: '2026-11-22', to: '2026-11-23' },
      items: [{ day: '2026-11-23', checkedAt: '2026-11-24T08:00:00+08:00', status: 'ok', ftpFiles: 1, gaps: 0, excess: 0, items: [], backfills: ['j-done'] }],
    });
    api.reconJob.mockResolvedValueOnce(doneJob);

    const scope = effectScope();
    const rec = scope.run(() => useAdReconcile(2_000))!;
    await rec.load();
    await flushPromises();
    // 載入時工作已是 done:只顯示結果,不打 POST /ad/reconciliations
    expect(rec.jobs.value['j-done']?.state).toBe('done');
    expect(api.reconRun).not.toHaveBeenCalled();

    // 進行中輪詢遇到頁面恢復可見不發重疊請求;空 day 完成不打 runDay('')
    let resolveSlow!: (v: typeof doneJob) => void;
    api.reconJob.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveSlow = r;
        }),
    );
    const p1 = rec.pollJob('j-slow', '');
    setHidden(true);
    setHidden(false);
    // j-slow 仍在進行中,恢復可見不可重複呼叫 adRecon.job
    expect(api.reconJob).toHaveBeenCalledTimes(2);
    resolveSlow({ ...doneJob, id: 'j-slow', day: '', state: 'done' });
    await p1;
    await flushPromises();
    expect(api.reconRun).not.toHaveBeenCalled();

    // 觀察到 running → done 後自動 runDay 失敗時,錯誤記入 dayError(不吞掉)
    api.reconJob
      .mockResolvedValueOnce({ ...doneJob, id: 'j-run', state: 'running' })
      .mockResolvedValueOnce({ ...doneJob, id: 'j-run', state: 'done' });
    api.reconRun.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', '沒有寫入權限', 'req-recon-403'));
    await rec.pollJob('j-run', '2026-11-23');
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(api.reconRun).toHaveBeenCalledWith('2026-11-23');
    expect(rec.dayError.value['2026-11-23']).toBeInstanceOf(ApiError);
    scope.stop();
  });
});

describe('GSourceBadge 支援 AD 資料來源與原有 PA 熱冷標記', () => {
  it('agent → 即時、ftp → FTP 補寫(獨立 .is-ftp 樣式)、hot/cold 維持不變;live=false 不加 role="status"(審查 Low 3)', () => {
    const a = mount(GSourceBadge, { props: { source: 'agent', live: false } });
    expect(a.text()).toContain('即時');
    expect(a.attributes('role')).toBeUndefined();
    const f = mount(GSourceBadge, { props: { source: 'ftp', live: false } });
    expect(f.text()).toContain('FTP 補寫');
    expect(f.find('.is-ftp').exists()).toBe(true);
    expect(f.find('.is-cold').exists()).toBe(false);
    expect(f.attributes('role')).toBeUndefined();
    const h = mount(GSourceBadge, { props: { source: 'hot' } });
    expect(h.text()).toContain('即時熱資料');
    expect(h.attributes('role')).toBe('status');
    const c = mount(GSourceBadge, { props: { source: 'cold' } });
    expect(c.text()).toContain('歷史冷歸檔');
    expect(c.find('.is-cold').exists()).toBe(true);
  });
});
