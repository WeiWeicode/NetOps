import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { usePolling } from '@/composables/usePolling';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePolling', () => {
  it('apply 回 true 才排下一次;重複 run 只留一條輪詢', async () => {
    let busy = 3;
    const fetch = vi.fn(async () => busy--);
    const seen: number[] = [];
    const scope = effectScope();
    const p = scope.run(() => usePolling(fetch, (r) => (seen.push(r as number), (r as number) > 1), 1000))!;
    void p.run();
    void p.run();
    await vi.advanceTimersByTimeAsync(0);
    // 第一輪被第二輪取代,只套用最新的結果
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(seen.at(-1)).toBe(1);
    scope.stop();
  });

  it('錯誤也交給 apply;離開頁面後停止', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('boom');
    });
    const apply = vi.fn((_r: unknown) => true);
    const scope = effectScope();
    const p = scope.run(() => usePolling(fetch, apply, 1000))!;
    await p.run();
    expect(apply.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    scope.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
