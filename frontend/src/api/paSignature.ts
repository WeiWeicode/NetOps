/**
 * PA 威脅特徵碼 API 客戶端(TS-2;docs/THREAT-SIGNATURE-PLAN.md §7):
 *   清單 / 單筆 / 版本 / 差異 / 命中比對(無 IP)/ 狀態:netops.pa-signature.read
 *   命中比對(含前 10 IP):netops.pa-log.read(TS-Q8,後端依路由直接強制)
 *   規則覆蓋:netops.pa-policy.read
 *   手動重新整理:netops.pa-signature.refresh(按鈕 netops.pa-signature-page.refresh,只給網管)
 *   IP 名稱對照:netops.ip-name.read(無權限不呼叫)
 * 頁面(TS-4)不直接呼叫,一律經 composables/usePaSignature.ts、usePaSignatureDrawer.ts。
 */
import { http } from './gateway';
import type { IpNameLabel } from './ipNames';
import type { Job } from './jobs';
import type { DistributiveOmit } from './paPolicy';

export const PA_SIGNATURE_DAYS = [7, 30, 90] as const;
export type SignatureDays = (typeof PA_SIGNATURE_DAYS)[number];
export type SignatureKind = 'vulnerability' | 'spyware';
export type SignatureSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export interface SignatureCounts {
  vulnerability: number;
  spyware: number;
  total: number;
}

export interface SignatureContentVersions {
  appVersion: string | null;
  appReleaseDate: string | null;
  avVersion: string | null;
  avReleaseDate: string | null;
  wildfireVersion: string | null;
  wildfireReleaseDate: string | null;
  urlFilteringVersion: string | null;
}

export interface SignatureStatus {
  collectorEnabled: boolean;
  /** ok / failed / rejected(管理平面 CPU 過高)/ paused(測試區暫停) */
  state: string | null;
  message: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  trigger: string | null;
  mgmtCpu: number | null;
  durationMs: number | null;
  count: number | null;
  threatVersion: string | null;
  fullFetch: boolean | null;
  refreshCooldownSec: number;
  lookupCooldownSec: number;
}

export interface SignatureRow {
  id: string;
  kind: SignatureKind;
  name: string;
  severity: string;
  category: string;
  affectedHost: string | null;
  engineVersion: string | null;
  defaultAction: string | null;
  cves: string[];
  vendorIds: string[];
  disabled: boolean;
  timeAttribute: Record<string, unknown> | string | null;
  firstVersion: string | null;
  isNew: boolean;
  hits30d?: number;
}

interface SignatureListAvailable {
  available: true;
  threatVersion: string;
  threatReleaseDate: string | null;
  fetchedAt: string;
  checkedAt: string;
  stale: boolean;
  baselineAt: string | null;
  /** 基準日晚於「今天 − days」時回 YYYY-MM-DD,畫面標示「自 YYYY-MM-DD 起統計」 */
  since: string | null;
  days: SignatureDays;
  counts: SignatureCounts;
  versions: SignatureContentVersions;
  hitsAvailable: boolean;
  status: SignatureStatus;
}

interface SignatureListUnavailable {
  available: false;
  reason: 'no-redis' | 'redis-down' | 'no-snapshot';
  message: string;
  status: SignatureStatus | null;
  days: SignatureDays;
  baselineAt: string | null;
  since: string | null;
  hitsAvailable: false;
}

export type SignatureList = (SignatureListAvailable | SignatureListUnavailable) & {
  items: SignatureRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type SignatureInfo = DistributiveOmit<SignatureList, 'items' | 'total' | 'page' | 'pageSize'>;

export interface SignatureFilter {
  kind?: SignatureKind;
  severity?: SignatureSeverity;
  q?: string;
  isNew?: boolean;
  hasHits?: boolean;
  days?: SignatureDays;
}

export interface SignatureDiffFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface SignatureChangeEntry {
  threatVersion: string;
  releaseDate: string | null;
  savedAt: string;
  kind: 'added' | 'changed' | 'removed';
  fields?: SignatureDiffFieldChange[];
}

export interface SignatureSnapshotDetail extends Omit<SignatureRow, 'hits30d'> {
  changes: SignatureChangeEntry[];
  hits30d: number | null;
  vault: Record<string, unknown> | null;
}

export interface SignatureLookupItem {
  id: string;
  name: string;
  subtype: string | null;
  severity: string | null;
  description: string | null;
  firstVersion: null;
  isNew: false;
  changes: SignatureChangeEntry[];
  hits30d: number | null;
  vault: Record<string, unknown> | null;
}

export type SignatureDetailFound =
  | {
      found: true;
      source: 'snapshot';
      threatVersion: string;
      fetchedAt: string;
      baselineAt: string | null;
      item: SignatureSnapshotDetail;
    }
  | {
      found: true;
      source: 'lookup';
      checkedAt: string | null;
      item: SignatureLookupItem;
    };

export interface SignatureDetailNotFound {
  found: false;
  source: 'snapshot' | 'lookup';
  checkedAt?: string | null;
  message: string;
}

export interface SignatureLookupQueued {
  lookupId: string;
  id: string;
  status: 'queued';
}

export type SignatureGetResponse = SignatureDetailFound | SignatureDetailNotFound | SignatureLookupQueued;

export type SignatureLookupStatus = 'queued' | 'running' | 'done' | 'not_found' | 'rejected' | 'failed';

export interface SignatureLookupJob {
  lookupId: string;
  threatId: string;
  status: SignatureLookupStatus;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cached: boolean;
  mgmtCpu: number | null;
  result: { id: string; name: string; subtype: string | null; severity: string | null; description: string | null } | null;
  error: string | null;
  message: string | null;
}

export interface SignatureVersionMeta {
  threatVersion: string;
  releaseDate: string | null;
  fetchedAt: string;
  savedAt: string;
  isBaseline: boolean;
  counts: SignatureCounts;
  added: number;
  changed: number;
  removed: number;
  hash: string;
}

export interface SignatureVersionList {
  baselineAt: string | null;
  baselineVersion: string | null;
  items: SignatureVersionMeta[];
  total: number;
}

export type SignatureDiffRow =
  | {
      diffKind: 'added' | 'removed';
      id: string;
      kind: SignatureKind;
      name: string;
      severity: string;
      category: string;
      defaultAction: string | null;
      disabled: boolean;
      cves: string[];
    }
  | {
      diffKind: 'changed';
      id: string;
      kind: SignatureKind;
      name: string;
      severity: string;
      category: string;
      fields: SignatureDiffFieldChange[];
    };

export interface SignatureDiffFilter {
  kind?: 'added' | 'changed' | 'removed';
  sigKind?: SignatureKind;
  severity?: SignatureSeverity;
  q?: string;
}

export interface SignatureVersionDiffs {
  threatVersion: string;
  baseVersion: string | null;
  releaseDate: string | null;
  fetchedAt: string;
  savedAt: string;
  isBaseline: boolean;
  counts: SignatureCounts;
  summary: { added: number; changed: number; removed: number };
  items: SignatureDiffRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HitQueryInput {
  days?: SignatureDays;
  scope?: 'new' | 'ids';
  ids?: string[];
}

export interface HitIpCount {
  ip: string;
  count: number;
}

export interface HitQueryItem {
  id: string;
  name: string;
  kind: SignatureKind | null;
  severity: string | null;
  hits: number;
  repeats: number;
  firstSeen: string;
  lastSeen: string;
  blocked: number;
  alerted: number;
  actions: Record<string, number>;
  rules: string[];
  ruleDetails: { name: string; unprotected: boolean }[];
  /** 只有 netops.pa-log.read 呼叫 hit-ip-queries 時才存在(TS-Q8) */
  topSrc?: HitIpCount[];
  topDst?: HitIpCount[];
}

export interface HitQueryResult {
  days: SignatureDays;
  since: string | null;
  from: string;
  to: string;
  scope: 'new' | 'ids';
  includeIps: boolean;
  queriedIds: number;
  truncatedIds: boolean;
  items: HitQueryItem[];
}

export type HitQueryJob = Job<HitQueryResult, Record<string, unknown>> & { jobId?: string };

export interface CoverageRuleItem {
  position: number;
  name: string;
  fromZones: string[];
  toZones: string[];
  applications: string[];
  hitCount: number | null;
  profileGroup: string | null;
  status: 'missing' | 'unknown';
  missing: ('vulnerability' | 'spyware')[];
  reason?: string;
}

export interface CoverageSummary {
  totalAllowEnabled: number;
  covered: number;
  missingBoth: number;
  missingVulnerability: number;
  missingSpyware: number;
  unknown: number;
}

export type SignatureCoverage =
  | {
      available: true;
      policyFetchedAt: string;
      profilesFetchedAt: string | null;
      profilesAvailable: boolean;
      message?: string;
      summary: CoverageSummary;
      items: CoverageRuleItem[];
    }
  | {
      available: false;
      reason: 'no-policy' | 'no-policy-snapshot';
      message: string;
      summary: null;
      items: [];
    };

export type SignatureStatusResponse =
  | ({ available: true; baselineAt: string | null; versionCount: number } & SignatureStatus)
  | { available: false; reason: 'no-redis' | 'redis-down'; message: string; baselineAt: string | null; versionCount: number };

export const PA_SIGNATURE_ERRORS = {
  unavailable: 'NETOPS_PA_SIGNATURE_UNAVAILABLE',
  chUnavailable: 'NETOPS_PA_SIGNATURE_CH_UNAVAILABLE',
  cooldown: 'NETOPS_PA_SIGNATURE_COOLDOWN',
  disabled: 'NETOPS_PA_SIGNATURE_DISABLED',
  queryInvalid: 'NETOPS_PA_SIGNATURE_QUERY_INVALID',
  versionNotFound: 'NETOPS_PA_SIGNATURE_VERSION_NOT_FOUND',
  lookupNotFound: 'NETOPS_PA_SIGNATURE_LOOKUP_NOT_FOUND',
} as const;

export const PA_SIGNATURE_LIMITS = { pageSize: 100, hitIds: 500, ipLookups: 200 } as const;

export const isSignatureLookupQueued = (r: SignatureGetResponse): r is SignatureLookupQueued => 'lookupId' in r;

export const isHitQueryJob = (r: HitQueryResult | HitQueryJob): r is HitQueryJob =>
  'jobId' in r || (r as HitQueryJob).kind === 'pa-sig-hits' || (r as HitQueryJob).kind === 'pa-sig-hit-ips';

export const paSignatureApi = {
  list: (f: SignatureFilter, page: number, pageSize: number) =>
    http.get<SignatureList>('/api/netops/pa-signatures', { query: { ...f, page, pageSize } }),
  get: (id: string) => http.get<SignatureGetResponse>(`/api/netops/pa-signatures/${encodeURIComponent(id)}`),
  lookup: (lookupId: string) => http.get<SignatureLookupJob>(`/api/netops/pa-signature-lookups/${encodeURIComponent(lookupId)}`),
  versions: () => http.get<SignatureVersionList>('/api/netops/pa-signature-versions'),
  versionDiffs: (version: string, f: SignatureDiffFilter, page: number, pageSize: number) =>
    http.get<SignatureVersionDiffs>(`/api/netops/pa-signature-versions/${encodeURIComponent(version)}/diffs`, { query: { ...f, page, pageSize } }),
  /** 命中比對(不含 IP,netops.pa-signature.read) */
  queryHits: async (input: HitQueryInput): Promise<{ kind: 'result'; result: HitQueryResult } | { kind: 'job'; job: HitQueryJob }> => {
    const r = await http.post<HitQueryResult | HitQueryJob>('/api/netops/pa-signature-hit-queries', input);
    return isHitQueryJob(r) ? { kind: 'job', job: r } : { kind: 'result', result: r };
  },
  hitJob: (id: string) => http.get<HitQueryJob>(`/api/netops/pa-signature-hit-queries/${encodeURIComponent(id)}`),
  cancelHitJob: (id: string) => http.delete<void>(`/api/netops/pa-signature-hit-queries/${encodeURIComponent(id)}`),
  /** 命中比對含 IP(netops.pa-log.read,TS-Q8) */
  queryHitIps: async (input: HitQueryInput): Promise<{ kind: 'result'; result: HitQueryResult } | { kind: 'job'; job: HitQueryJob }> => {
    const r = await http.post<HitQueryResult | HitQueryJob>('/api/netops/pa-signature-hit-ip-queries', input);
    return isHitQueryJob(r) ? { kind: 'job', job: r } : { kind: 'result', result: r };
  },
  hitIpJob: (id: string) => http.get<HitQueryJob>(`/api/netops/pa-signature-hit-ip-queries/${encodeURIComponent(id)}`),
  cancelHitIpJob: (id: string) => http.delete<void>(`/api/netops/pa-signature-hit-ip-queries/${encodeURIComponent(id)}`),
  coverage: () => http.get<SignatureCoverage>('/api/netops/pa-signature-coverage'),
  refresh: () => http.post<{ requestedAt: string; cooldownSec: number }>('/api/netops/pa-signature-refreshes'),
  status: () => http.get<SignatureStatusResponse>('/api/netops/pa-signature-status'),
  lookupIps: (ips: string[]) => http.post<{ names: Record<string, IpNameLabel> }>('/api/netops/ip-name-lookups', { ips }),
};
