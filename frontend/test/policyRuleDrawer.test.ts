/**
 * 跨頁規則抽屜(usePolicyRuleDrawer):權限、預設規則、找不到 / 快照不可用不開抽屜、較新的請求取代舊的
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/gateway';
import { PA_POLICY_ERRORS, type PolicyDetail, type PolicyRule } from '@/api/paPolicy';
import type { PaPolicyBackend } from '@/composables/usePaPolicy';
import { usePolicyRuleDrawer } from '@/composables/usePolicyRuleDrawer';

const detail = (name: string): PolicyDetail => ({
  available: true,
  fetchedAt: '2026-11-19T00:00:00Z',
  hash: 'h1',
  versionId: null,
  stale: false,
  hitsFetchedAt: null,
  ruleCount: 1,
  status: { collectorEnabled: true, state: 'ok', message: null, lastRunAt: null, lastOkAt: null, trigger: null, mgmtCpu: null, durationMs: null, refreshCooldownSec: 0 },
  rule: { position: 1, name } as PolicyRule,
});

function setup(get: (name: string) => Promise<PolicyDetail>, perms: string[] = ['netops.pa-policy.read']) {
  const backend = { get } as unknown as PaPolicyBackend;
  return usePolicyRuleDrawer({ backend, can: (c) => perms.includes(c) });
}
const fails = (e: Error) => vi.fn(async (): Promise<PolicyDetail> => {
  throw e;
});
const gate = () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
};

describe('usePolicyRuleDrawer', () => {
  it('取得規則後才開抽屜,policy.detail 給 PolicyRuleDrawer 用', async () => {
    const get = vi.fn(async (n: string) => detail(n));
    const d = setup(get);
    expect(d.open).toBe(false);
    expect(await d.show(' allow-web ')).toBe('ok');
    expect(get).toHaveBeenCalledWith('allow-web');
    expect(d.open).toBe(true);
    expect(d.policy.detail?.rule.name).toBe('allow-web');
    d.close();
    expect(d.open).toBe(false);
    expect(d.policy.detail).toBeNull();
  });

  it('沒有 netops.pa-policy.read:不可點、不呼叫 API', async () => {
    const get = vi.fn(async (n: string) => detail(n));
    const d = setup(get, []);
    expect(d.canOpen).toBe(false);
    expect(d.linkable('allow-web')).toBe(false);
    expect(await d.show('allow-web')).toBe('forbidden');
    expect(get).not.toHaveBeenCalled();
    expect(d.open).toBe(false);
  });

  it('空值與預設規則不可點', async () => {
    const get = vi.fn(async (n: string) => detail(n));
    const d = setup(get);
    expect(d.linkable('')).toBe(false);
    expect(d.linkable(null)).toBe(false);
    expect(d.linkable('interzone-default')).toBe(false);
    expect(await d.show('intrazone-default')).toBe('invalid');
    expect(get).not.toHaveBeenCalled();
  });

  it('找不到規則:不開抽屜,notice 說明', async () => {
    const d = setup(fails(new ApiError(404, PA_POLICY_ERRORS.notFound, '找不到', 'r1')));
    expect(await d.show('old-rule')).toBe('not-found');
    expect(d.open).toBe(false);
    expect(d.notice).toContain('old-rule');
    expect(d.loading).toBe(false);
  });

  it('快照不可用 / 後端 403 / 其他錯誤', async () => {
    const un = setup(fails(new ApiError(503, PA_POLICY_ERRORS.unavailable, '尚無快照', 'r')));
    expect(await un.show('a')).toBe('unavailable');
    expect(un.notice).toBe('尚無快照');
    const fb = setup(fails(new ApiError(403, 'FORBIDDEN', 'no', 'r')));
    expect(await fb.show('a')).toBe('forbidden');
    expect(fb.open).toBe(false);
    const er = setup(fails(new Error('連線中斷')));
    expect(await er.show('a')).toBe('error');
    expect(er.notice).toBe('連線中斷');
  });

  it('較新的 show 取代舊的', async () => {
    const g = gate();
    const d = setup(async (n: string) => {
      if (n === 'first') await g.wait;
      return detail(n);
    });
    const p1 = d.show('first');
    expect(await d.show('second')).toBe('ok');
    g.release();
    expect(await p1).toBe('stale');
    expect(d.policy.detail?.rule.name).toBe('second');
  });

  it('close 後才回來的結果不開抽屜', async () => {
    const g = gate();
    const d = setup(async (n: string) => {
      await g.wait;
      return detail(n);
    });
    const p = d.show('x');
    d.close();
    g.release();
    expect(await p).toBe('stale');
    expect(d.open).toBe(false);
  });
});
