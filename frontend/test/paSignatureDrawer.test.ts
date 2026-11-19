/**
 * 跨頁威脅特徵碼抽屜(usePaSignatureDrawer):ID 擷取、權限、快照 200、202 按需查詢輪詢、限流與取代取消
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/gateway';
import {
  PA_SIGNATURE_ERRORS,
  type SignatureGetResponse,
  type SignatureLookupJob,
} from '@/api/paSignature';
import { extractThreatId, usePaSignatureDrawer } from '@/composables/usePaSignatureDrawer';

const snapFound = (id: string): SignatureGetResponse => ({
  found: true,
  source: 'snapshot',
  threatVersion: '9174-10355',
  fetchedAt: '2026-11-19T01:00:00Z',
  baselineAt: '2026-11-10T00:00:00Z',
  item: {
    id,
    kind: 'vulnerability',
    name: `Vuln-${id}`,
    severity: 'critical',
    category: 'code-execution',
    affectedHost: 'server',
    engineVersion: '9.0',
    defaultAction: 'reset-both',
    cves: ['CVE-2026-8888'],
    vendorIds: [],
    disabled: false,
    timeAttribute: null,
    firstVersion: '9174-10355',
    isNew: true,
    changes: [],
    hits30d: 4,
    vault: null,
  },
});

const gate = () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
};

describe('extractThreatId', () => {
  it('支援「名稱(ID)」與純數字,其他回 null', () => {
    expect(extractThreatId('HTTP SQL Injection(34567)')).toBe('34567');
    expect(extractThreatId('HTTP SQL Injection (34567)')).toBe('34567');
    expect(extractThreatId(' 547000 ')).toBe('547000');
    expect(extractThreatId('NoId')).toBeNull();
    expect(extractThreatId('')).toBeNull();
    expect(extractThreatId(null)).toBeNull();
  });
});

describe('usePaSignatureDrawer', () => {
  it('快照 200 直接開抽屜並顯示 detail;無權限或無 ID 不呼叫 API', async () => {
    const get = vi.fn(async (id: string) => snapFound(id));
    const lookup = vi.fn();

    const denied = usePaSignatureDrawer({ backend: { get, lookup }, can: () => false });
    expect(denied.linkable('SQLi(34567)')).toBe(false);
    expect(await denied.show('SQLi(34567)')).toBe('forbidden');
    expect(get).not.toHaveBeenCalled();

    const d = usePaSignatureDrawer({ backend: { get, lookup }, can: (c) => c === 'netops.pa-signature.read' });
    expect(d.linkable('SQLi(34567)')).toBe(true);
    expect(d.linkable('NoId')).toBe(false);
    expect(await d.show('NoId')).toBe('invalid');
    expect(await d.show('SQLi(34567)')).toBe('ok');
    expect(get).toHaveBeenCalledWith('34567');
    expect(d.open).toBe(true);
    expect(d.detail?.item.id).toBe('34567');
    d.close();
    expect(d.open).toBe(false);
    expect(d.detail).toBeNull();
  });

  it('202 按需查詢開抽屜並輪詢至 done / not_found / rejected', async () => {
    let calls = 0;
    const lookup = vi.fn(
      async (): Promise<SignatureLookupJob> =>
        ++calls < 2
          ? {
              lookupId: 'lk-1',
              threatId: '888888',
              status: 'running',
              createdAt: '2026-11-19T01:00:00Z',
              startedAt: '2026-11-19T01:00:00Z',
              finishedAt: null,
              cached: false,
              mgmtCpu: 15,
              result: null,
              error: null,
              message: null,
            }
          : {
              lookupId: 'lk-1',
              threatId: '888888',
              status: 'done',
              createdAt: '2026-11-19T01:00:00Z',
              startedAt: '2026-11-19T01:00:00Z',
              finishedAt: '2026-11-19T01:00:01Z',
              cached: false,
              mgmtCpu: 15,
              result: { id: '888888', name: 'Virus-XYZ', subtype: 'virus', severity: 'high', description: 'Test virus' },
              error: null,
              message: null,
            },
    );
    const get = vi.fn(async (): Promise<SignatureGetResponse> => ({ lookupId: 'lk-1', id: '888888', status: 'queued' }));
    const d = usePaSignatureDrawer({ backend: { get, lookup }, can: () => true, pollMs: 5 });
    expect(await d.show('Virus(888888)')).toBe('ok');
    expect(calls).toBe(2);
    expect(d.open).toBe(true);
    expect(d.polling).toBe(false);
    expect(d.detail?.source).toBe('lookup');
    expect(d.detail?.item.name).toBe('Virus-XYZ');

    // CPU 過高拒絕
    const rej = usePaSignatureDrawer({
      backend: {
        get,
        lookup: vi.fn(async (): Promise<SignatureLookupJob> => ({
          lookupId: 'lk-2',
          threatId: '888888',
          status: 'rejected',
          createdAt: null,
          startedAt: null,
          finishedAt: null,
          cached: false,
          mgmtCpu: 65,
          result: null,
          error: 'CPU_HIGH',
          message: 'CPU 65% 超過門檻',
        })),
      },
      can: () => true,
      pollMs: 5,
    });
    expect(await rej.show('888888')).toBe('rejected');
    expect(rej.notice).toContain('65%');
  });

  it('429 限流 / 200 查無不開抽屜;較新的 show 或 close 取代舊請求', async () => {
    const cool = usePaSignatureDrawer({
      backend: {
        get: vi.fn(async () => {
          throw new ApiError(429, PA_SIGNATURE_ERRORS.cooldown, '請 8 秒後再試', 'r1');
        }),
        lookup: vi.fn(),
      },
      can: () => true,
    });
    expect(await cool.show('999999')).toBe('cooldown');
    expect(cool.open).toBe(false);
    expect(cool.notice).toContain('8 秒');

    const g = gate();
    const d = usePaSignatureDrawer({
      backend: {
        get: vi.fn(async (id: string) => {
          if (id === '11111') await g.wait;
          return snapFound(id);
        }),
        lookup: vi.fn(),
      },
      can: () => true,
    });
    const p1 = d.show('11111');
    expect(await d.show('22222')).toBe('ok');
    g.release();
    expect(await p1).toBe('stale');
    expect(d.detail?.item.id).toBe('22222');
  });
});
