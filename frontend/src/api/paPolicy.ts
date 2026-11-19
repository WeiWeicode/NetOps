/**
 * PA 安全規則(PR-3;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3、§3.6,後端 PR-2)。
 *   清單 / 單條 / 版本:netops.pa-policy.read;手動重新整理:netops.pa-policy.refresh(按鈕 netops.pa-policy-page.refresh,只給網管)
 *   網段反查 IP 對照表:netops.ip-name.read(個資,只給網管;沒有權限不呼叫)
 * 頁面不直接呼叫,一律經 composables/usePaPolicy.ts、usePaPolicyViz.ts。
 */
import { http } from './gateway';
import type { IpNameLabel } from './ipNames';

export interface PolicyHits {
  hitCount: number | null;
  lastHit: string | null;
  firstHit: string | null;
  lastReset: string | null;
  created: string | null;
  modified: string | null;
}

export interface ExpandedAddress {
  name: string;
  kind: 'any' | 'address' | 'group' | 'literal' | 'dynamic-group' | 'region' | 'unknown';
  /** 展開後的值:10.1.1.0/24、10.1.1.1-10.1.1.9、fqdn:xxx、dynamic:'tag' 等 */
  values: string[];
  /** 有無法展開成 IPv4 的成員(畫面標「無法展開 / 無法對照」) */
  unresolved: boolean;
}
export interface ExpandedService {
  name: string;
  kind: 'any' | 'application-default' | 'service' | 'predefined' | 'group' | 'unknown';
  /** tcp/443 等 */
  values: string[];
}
export interface ExpandedApplication {
  name: string;
  kind: 'any' | 'application' | 'group';
  /** 應用群組的成員 */
  values: string[];
}

export interface PolicyRule {
  /** PA 比對順序(1 起算,同 PA GUI 編號;篩選後不變) */
  position: number;
  name: string;
  uuid: string | null;
  type: string;
  tags: string[];
  groupTag: string | null;
  fromZones: string[];
  toZones: string[];
  sources: string[];
  sourceUsers: string[];
  sourceDevices: string[];
  negateSource: boolean;
  destinations: string[];
  destinationDevices: string[];
  negateDestination: boolean;
  applications: string[];
  services: string[];
  categories: string[];
  action: string;
  profileGroup: string | null;
  profiles: Record<string, string[]>;
  logStart: boolean;
  logEnd: boolean;
  logSetting: string | null;
  schedule: string | null;
  disabled: boolean;
  description: string | null;
  hits: PolicyHits | null;
  /** 有 ip 篩選時:yes 確定重疊;maybe 含無法展開的物件或 negate,需人工確認 */
  ipMatch?: 'yes' | 'maybe';
  expanded: { sources: ExpandedAddress[]; destinations: ExpandedAddress[]; services: ExpandedService[]; applications: ExpandedApplication[] };
}

export interface PolicyStatus {
  collectorEnabled: boolean;
  /** ok / failed / rejected(管理平面 CPU 過高)/ paused(測試區暫停) */
  state: string | null;
  message: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  trigger: string | null;
  mgmtCpu: number | null;
  durationMs: number | null;
  refreshCooldownSec: number;
}

export interface DefaultRuleHits extends PolicyHits {
  /** intrazone-default / interzone-default:只有命中數、沒有規則內容 */
  name: string;
}

interface Available {
  available: true;
  fetchedAt: string;
  hash: string;
  versionId: string | null;
  /** 超過 2 小時沒更新(畫面要標示) */
  stale: boolean;
  hitsFetchedAt: string | null;
  ruleCount: number;
  status: PolicyStatus;
}
interface Unavailable {
  available: false;
  reason: 'no-redis' | 'redis-down' | 'no-snapshot';
  message: string;
  status: PolicyStatus | null;
}

export type PolicyList = (Available | Unavailable) & { items: PolicyRule[]; total: number; page: number; pageSize: number; defaults: DefaultRuleHits[] };
export type PolicyDetail = Available & { rule: PolicyRule };

export interface PolicyFilter {
  q?: string;
  zone?: string;
  /** 逗號分隔 IPv4 / CIDR / a-b,最多 50 個 */
  ip?: string;
  includeAny?: boolean;
  application?: string;
  action?: string;
  unusedDays?: number;
  disabled?: boolean;
}

export interface PolicyVersion {
  id: string;
  hash: string;
  fetchedAt: string;
  savedAt: string;
  ruleCount: number;
}
export interface RuleChange {
  kind: 'added' | 'removed' | 'moved' | 'changed';
  name: string;
  position: number | null;
  basePosition: number | null;
  fields?: { field: string; before: unknown; after: unknown }[];
}
export interface ObjectChange {
  kind: 'addresses' | 'addressGroups' | 'services' | 'serviceGroups' | 'applicationGroups' | 'tags';
  added: string[];
  removed: string[];
  changed: string[];
}
export interface PolicyDiff {
  id: string;
  baseId: string | null;
  version: PolicyVersion;
  base: PolicyVersion | null;
  rules: RuleChange[];
  objects: ObjectChange[];
}

export type RangeLookup = { items: (IpNameLabel & { ip: string })[]; total: number; truncated: boolean } | { invalid: true };

/** 錯誤代碼 */
export const PA_POLICY_ERRORS = {
  notFound: 'NETOPS_PA_POLICY_NOT_FOUND',
  unavailable: 'NETOPS_PA_POLICY_UNAVAILABLE',
  cooldown: 'NETOPS_PA_POLICY_REFRESH_COOLDOWN',
  disabled: 'NETOPS_PA_POLICY_DISABLED',
  versionNotFound: 'NETOPS_PA_POLICY_VERSION_NOT_FOUND',
} as const;
/** 後端上限 */
export const PA_POLICY_LIMITS = { pageSize: 100, ipFilters: 50, lookups: 200 } as const;

export const paPolicyApi = {
  list: (f: PolicyFilter, page: number, pageSize: number) => http.get<PolicyList>('/api/netops/pa-policies', { query: { ...f, page, pageSize } }),
  get: (name: string) => http.get<PolicyDetail>(`/api/netops/pa-policies/${encodeURIComponent(name)}`),
  refresh: () => http.post<{ requestedAt: string; cooldownSec: number }>('/api/netops/pa-policy-refreshes'),
  versions: () => http.get<{ items: PolicyVersion[]; total: number }>('/api/netops/pa-policy-versions'),
  diff: (id: string, base?: string) => http.get<PolicyDiff>(`/api/netops/pa-policy-versions/${encodeURIComponent(id)}/diffs`, { query: { base } }),
  /** §3.6:單一 IP 的名稱(既有 ip-name-lookups) */
  lookupIps: (ips: string[]) => http.post<{ names: Record<string, IpNameLabel> }>('/api/netops/ip-name-lookups', { ips }),
  /** §3.6:網段 / 範圍內的對照表項目 */
  lookupRanges: (ranges: string[]) => http.post<{ results: Record<string, RangeLookup> }>('/api/netops/ip-name-range-lookups', { ranges }),
};
