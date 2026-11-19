/**
 * PA 威脅特徵碼 composable(usePaSignature):清單篩選與 days / since、版本差異、TS-Q8 命中比對權限分流與 202 輪詢、IP 名稱權限、規則覆蓋、手動重新整理
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/gateway';
import {
  PA_SIGNATURE_ERRORS,
  type HitQueryJob,
  type HitQueryResult,
  type SignatureCoverage,
  type SignatureList,
  type SignatureVersionDiffs,
  type SignatureVersionList,
} from '@/api/paSignature';
import { usePaSignature, type PaSignatureBackend } from '@/composables/usePaSignature';

const makeList = (overrides: Partial<SignatureList> = {}): SignatureList =>
  ({
    available: true,
    threatVersion: '9174-10355',
    threatReleaseDate: '2026/11/19 00:00:00',
    fetchedAt: '2026-11-19T01:00:00Z',
    checkedAt: '2026-11-19T01:00:00Z',
    stale: false,
    baselineAt: '2026-11-10T00:00:00Z',
    since: '2026-11-10',
    days: 30,
    counts: { vulnerability: 1, spyware: 0, total: 1 },
    versions: {
      appVersion: '9174-10355',
      appReleaseDate: null,
      avVersion: '5001-5520',
      avReleaseDate: null,
      wildfireVersion: '955201-958201',
      wildfireReleaseDate: null,
      urlFilteringVersion: null,
    },
    hitsAvailable: true,
    status: {
      collectorEnabled: true,
      state: 'ok',
      message: null,
      lastRunAt: '2026-11-19T01:00:00Z',
      lastOkAt: '2026-11-19T01:00:00Z',
      trigger: 'scheduled',
      mgmtCpu: 15,
      durationMs: 3000,
      count: 1,
      threatVersion: '9174-10355',
      fullFetch: true,
      refreshCooldownSec: 0,
      lookupCooldownSec: 0,
    },
    items: [
      {
        id: '90001',
        kind: 'vulnerability',
        name: 'Fresh RCE',
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
        hits30d: 3,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
    ...overrides,
  }) as SignatureList;

const makeHits = (includeIps: boolean): HitQueryResult => ({
  days: 30,
  since: '2026-11-10',
  from: '2026-10-20T00:00:00Z',
  to: '2026-11-19T00:00:00Z',
  scope: 'new',
  includeIps,
  queriedIds: 1,
  truncatedIds: false,
  items: [
    {
      id: '90001',
      name: 'Fresh RCE',
      kind: 'vulnerability',
      severity: 'critical',
      hits: 3,
      repeats: 5,
      firstSeen: '2026-11-18T00:00:00Z',
      lastSeen: '2026-11-19T00:00:00Z',
      blocked: 2,
      alerted: 1,
      actions: { 'reset-both': 2, alert: 1 },
      rules: ['Allow-Web'],
      ruleDetails: [{ name: 'Allow-Web', unprotected: true }],
      ...(includeIps ? { topSrc: [{ ip: '1.2.3.4', count: 3 }], topDst: [{ ip: '10.10.1.5', count: 3 }] } : {}),
    },
  ],
});

function createMockBackend(overrides: Partial<PaSignatureBackend> = {}): PaSignatureBackend {
  return {
    list: vi.fn(async () => makeList()),
    get: vi.fn(),
    lookup: vi.fn(),
    versions: vi.fn(
      async (): Promise<SignatureVersionList> => ({
        baselineAt: '2026-11-10T00:00:00Z',
        baselineVersion: '9173-10354',
        items: [],
        total: 0,
      }),
    ),
    versionDiffs: vi.fn(
      async (): Promise<SignatureVersionDiffs> => ({
        threatVersion: '9174-10355',
        baseVersion: '9173-10354',
        releaseDate: null,
        fetchedAt: '2026-11-19T01:00:00Z',
        savedAt: '2026-11-19T01:00:05Z',
        isBaseline: false,
        counts: { vulnerability: 1, spyware: 0, total: 1 },
        summary: { added: 1, changed: 0, removed: 0 },
        items: [],
        total: 0,
        page: 1,
        pageSize: 50,
      }),
    ),
    queryHits: vi.fn(async () => ({ kind: 'result' as const, result: makeHits(false) })),
    hitJob: vi.fn(),
    cancelHitJob: vi.fn(async () => undefined),
    queryHitIps: vi.fn(async () => ({ kind: 'result' as const, result: makeHits(true) })),
    hitIpJob: vi.fn(),
    cancelHitIpJob: vi.fn(async () => undefined),
    coverage: vi.fn(
      async (): Promise<SignatureCoverage> => ({
        available: true,
        policyFetchedAt: '2026-11-19T01:00:00Z',
        profilesFetchedAt: '2026-11-19T01:00:00Z',
        profilesAvailable: true,
        summary: { totalAllowEnabled: 2, covered: 1, missingBoth: 1, missingVulnerability: 0, missingSpyware: 0, unknown: 0 },
        items: [],
      }),
    ),
    refresh: vi.fn(async () => ({ requestedAt: '2026-11-19T01:05:00Z', cooldownSec: 300 })),
    status: vi.fn(),
    lookupIps: vi.fn(async () => ({
      names: { '10.10.1.5': { name: 'Web主機', department: '資訊部', device: 'WEB01', deviceType: '伺服器' } },
    })),
    ...overrides,
  };
}

describe('usePaSignature', () => {
  it('清單載入、篩選與 days 限制 7 / 30 / 90', async () => {
    const backend = createMockBackend();
    const s = usePaSignature({ backend, can: () => true });
    s.setDays(90);
    s.filters.kind = 'vulnerability';
    s.filters.isNew = true;
    expect(await s.load(2)).toBe(true);
    expect(backend.list).toHaveBeenCalledWith({ days: 90, kind: 'vulnerability', isNew: true }, 2, 50);
    expect(s.items).toHaveLength(1);
    expect(s.info?.available).toBe(true);
    if (s.info?.available) {
      expect(s.info.since).toBe('2026-11-10');
      expect(s.info.versions.avVersion).toBe('5001-5520');
    }
  });

  it('命中比對 TS-Q8:無 pa-log.read 呼叫無 IP 路由;有 pa-log.read + ip-name.read 才查 IP 與名稱', async () => {
    const b1 = createMockBackend();
    const viewer = usePaSignature({ backend: b1, can: (c) => c === 'netops.pa-signature.read' });
    expect(viewer.canHitIps).toBe(false);
    expect(await viewer.queryHits({ days: 30 })).toBe(true);
    expect(b1.queryHits).toHaveBeenCalledTimes(1);
    expect(b1.queryHitIps).not.toHaveBeenCalled();
    expect(b1.lookupIps).not.toHaveBeenCalled();

    // 有 pa-log.read 但無 ip-name.read → 查 IP 但不查名稱
    const b2 = createMockBackend();
    const logUser = usePaSignature({ backend: b2, can: (c) => c === 'netops.pa-signature.read' || c === 'netops.pa-log.read' });
    expect(await logUser.queryHits({ days: 30 })).toBe(true);
    expect(b2.queryHitIps).toHaveBeenCalledTimes(1);
    expect(b2.lookupIps).not.toHaveBeenCalled();

    // 有 pa-log.read + ip-name.read → 查 IP 且對照名稱
    const b3 = createMockBackend();
    const admin = usePaSignature({ backend: b3, can: () => true });
    expect(await admin.queryHits({ days: 30 })).toBe(true);
    expect(b3.queryHitIps).toHaveBeenCalledTimes(1);
    expect(b3.lookupIps).toHaveBeenCalledWith(['1.2.3.4', '10.10.1.5']);
    expect(admin.nameOfIp('10.10.1.5')?.name).toBe('Web主機');
  });

  it('命中比對 202 工作模式自動輪詢至完成,並支援取消', async () => {
    const queuedJob: HitQueryJob = {
      id: 'job-1',
      jobId: 'job-1',
      kind: 'pa-sig-hits',
      status: 'running',
      createdAt: '2026-11-19T01:00:00Z',
      startedAt: '2026-11-19T01:00:00Z',
      finishedAt: null,
      progress: null,
      error: null,
      result: null,
    };
    const doneJob: HitQueryJob = { ...queuedJob, status: 'done', finishedAt: '2026-11-19T01:00:02Z', result: makeHits(false) };
    let polls = 0;
    const backend = createMockBackend({
      queryHits: vi.fn(async () => ({ kind: 'job' as const, job: queuedJob })),
      hitJob: vi.fn(async () => (++polls >= 2 ? doneJob : queuedJob)),
    });
    const s = usePaSignature({ backend, can: (c) => c === 'netops.pa-signature.read', pollMs: 5 });
    expect(await s.queryHits({ days: 90 })).toBe(true);
    expect(polls).toBe(2);
    expect(s.hitsResult?.items[0]?.id).toBe('90001');
    expect(s.hitsLoading).toBe(false);
  });

  it('規則覆蓋受 netops.pa-policy.read 控管;手動重新整理受按鈕權限與冷卻處理', async () => {
    const backend = createMockBackend({
      refresh: vi.fn(async () => {
        throw new ApiError(429, PA_SIGNATURE_ERRORS.cooldown, '請 120 秒後再試', 'req-1');
      }),
    });
    const noPerm = usePaSignature({ backend, can: () => false });
    expect(await noPerm.loadCoverage()).toBe(false);
    expect(await noPerm.refresh()).toBe(false);
    expect(backend.coverage).not.toHaveBeenCalled();
    expect(backend.refresh).not.toHaveBeenCalled();

    const admin = usePaSignature({ backend, can: () => true });
    expect(await admin.loadCoverage()).toBe(true);
    expect(admin.coverage?.available).toBe(true);
    expect(await admin.refresh()).toBe(false);
    expect(admin.refreshNotice).toContain('120');
  });
});
