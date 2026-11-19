/**
 * PA 威脅特徵碼核心(TS-2;docs/THREAT-SIGNATURE-PLAN.md §4.1、§4.2、§5.2、§5.4):
 * 快照解析、精簡索引與差異比對(D1)、清單篩選、規則覆蓋(TS-Q5)、威脅名稱擷取 ID。純函式,不依賴 Fastify。
 */
import { createHash } from 'node:crypto';
import type {
  CompactSigEntry,
  SigDiffChangedItem,
  SigDiffFieldChange,
  SigDiffSummaryItem,
  SigKind,
} from '../../infra/store/pa-signature.js';
import type { HitInfo, PolicyRule, Snapshot as PolicySnapshot } from '../pa-policy/core.js';

export const SIG_DAYS = [7, 30, 90] as const;
export type SigDays = (typeof SIG_DAYS)[number];
export const SIG_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type SigSeverity = (typeof SIG_SEVERITIES)[number];

export interface SigMeta {
  fetchedAt: string;
  checkedAt: string;
  threatVersion: string;
  threatReleaseDate: string | null;
  appVersion: string | null;
  appReleaseDate: string | null;
  avVersion: string | null;
  avReleaseDate: string | null;
  wildfireVersion: string | null;
  wildfireReleaseDate: string | null;
  urlFilteringVersion: string | null;
  counts: { vulnerability: number; spyware: number; total: number };
  hash: string;
}

export interface SigItem {
  id: string;
  kind: SigKind;
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
}

export interface SigProfiles {
  fetchedAt: string;
  vsys: string;
  profileGroups: Record<string, Record<string, string[]>>;
  vulnerabilityProfiles: string[];
  spywareProfiles: string[];
}

export interface LookupThreatResult {
  id: string;
  name: string;
  subtype: string | null;
  severity: string | null;
  description: string | null;
}

/* ───────── 威脅 ID 擷取 ───────── */

const PURE_ID_RE = /^\d{1,10}$/;
const PAREN_ID_RE = /\((\d{1,10})\)$/;

/** 從 pa_threat_logs / 戰情室威脅名稱擷取特徵 ID:支援「名稱(ID)」與純數字 ID */
export function extractThreatId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (PURE_ID_RE.test(t)) return t;
  const m = PAREN_ID_RE.exec(t);
  return m ? m[1]! : null;
}

/* ───────── Redis 快照驗證與解析 ───────── */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

export function parseMeta(raw: Record<string, unknown> | null): SigMeta | null {
  if (!raw || typeof raw.threatVersion !== 'string' || !raw.threatVersion.trim()) return null;
  if (typeof raw.hash !== 'string' || !/^[0-9a-f]{12,128}$/i.test(raw.hash)) return null;
  const c = raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts) ? (raw.counts as Record<string, unknown>) : {};
  const vuln = typeof c.vulnerability === 'number' && Number.isFinite(c.vulnerability) ? c.vulnerability : 0;
  const spy = typeof c.spyware === 'number' && Number.isFinite(c.spyware) ? c.spyware : 0;
  const total = typeof c.total === 'number' && Number.isFinite(c.total) ? c.total : vuln + spy;
  const fetchedAt = str(raw.fetchedAt);
  return {
    fetchedAt,
    checkedAt: str(raw.checkedAt) || fetchedAt,
    threatVersion: raw.threatVersion.trim(),
    threatReleaseDate: strOrNull(raw.threatReleaseDate),
    appVersion: strOrNull(raw.appVersion),
    appReleaseDate: strOrNull(raw.appReleaseDate),
    avVersion: strOrNull(raw.avVersion),
    avReleaseDate: strOrNull(raw.avReleaseDate),
    wildfireVersion: strOrNull(raw.wildfireVersion),
    wildfireReleaseDate: strOrNull(raw.wildfireReleaseDate),
    urlFilteringVersion: strOrNull(raw.urlFilteringVersion),
    counts: { vulnerability: vuln, spyware: spy, total },
    hash: raw.hash.toLowerCase(),
  };
}

export function parseItems(raw: unknown[] | null, kind: SigKind): SigItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SigItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const o = x as Record<string, unknown>;
    const id = str(o.id).trim();
    if (!PURE_ID_RE.test(id)) continue;
    let timeAttribute: Record<string, unknown> | string | null = null;
    if (typeof o.timeAttribute === 'string' && o.timeAttribute) timeAttribute = o.timeAttribute;
    else if (o.timeAttribute && typeof o.timeAttribute === 'object' && !Array.isArray(o.timeAttribute))
      timeAttribute = o.timeAttribute as Record<string, unknown>;
    out.push({
      id,
      kind,
      name: str(o.name),
      severity: str(o.severity),
      category: str(o.category),
      affectedHost: strOrNull(o.affectedHost),
      engineVersion: strOrNull(o.engineVersion),
      defaultAction: strOrNull(o.defaultAction),
      cves: strs(o.cves),
      vendorIds: strs(o.vendorIds),
      disabled: o.disabled === true,
      timeAttribute,
    });
  }
  return out;
}

export function parseProfiles(raw: Record<string, unknown> | null): SigProfiles | null {
  if (!raw) return null;
  const groups: Record<string, Record<string, string[]>> = {};
  if (raw.profileGroups && typeof raw.profileGroups === 'object' && !Array.isArray(raw.profileGroups)) {
    for (const [gName, gVal] of Object.entries(raw.profileGroups as Record<string, unknown>)) {
      if (!gVal || typeof gVal !== 'object' || Array.isArray(gVal)) continue;
      const fields: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(gVal as Record<string, unknown>)) {
        const list = strs(v);
        if (list.length) fields[k] = list;
      }
      groups[gName] = fields;
    }
  }
  return {
    fetchedAt: str(raw.fetchedAt),
    vsys: str(raw.vsys) || 'vsys1',
    profileGroups: groups,
    vulnerabilityProfiles: strs(raw.vulnerabilityProfiles),
    spywareProfiles: strs(raw.spywareProfiles),
  };
}

/* ───────── 精簡索引與版本差異(D1) ───────── */

export function hashCves(cves: readonly string[]): string {
  if (!cves.length) return '';
  const norm = [...new Set(cves)].sort().join(',');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

export function toCompactEntry(item: SigItem): CompactSigEntry {
  const cves = [...new Set(item.cves)].sort();
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    severity: item.severity,
    category: item.category,
    defaultAction: item.defaultAction,
    disabled: item.disabled,
    cves,
    cvesHash: hashCves(cves),
  };
}

const toSummary = (e: Pick<CompactSigEntry, 'id' | 'kind' | 'name' | 'severity' | 'category' | 'defaultAction' | 'disabled' | 'cves'>): SigDiffSummaryItem => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  severity: e.severity,
  category: e.category,
  defaultAction: e.defaultAction,
  disabled: e.disabled,
  cves: e.cves,
});

const SEV_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, informational: 1 };
const bySevAndId = (a: { severity: string; id: string }, b: { severity: string; id: string }) =>
  (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || Number(a.id) - Number(b.id);

/** 比對上一版精簡索引與最新清單 → added / changed(列出異動欄位) / removed */
export function diffSignatures(
  prevItems: Record<string, CompactSigEntry>,
  curList: readonly SigItem[],
): {
  added: SigDiffSummaryItem[];
  changed: SigDiffChangedItem[];
  removed: SigDiffSummaryItem[];
  nextItems: Record<string, CompactSigEntry>;
} {
  const nextItems: Record<string, CompactSigEntry> = {};
  const added: SigDiffSummaryItem[] = [];
  const changed: SigDiffChangedItem[] = [];
  const removed: SigDiffSummaryItem[] = [];

  for (const item of curList) {
    const cur = toCompactEntry(item);
    nextItems[cur.id] = cur;
    const prev = prevItems[cur.id];
    if (!prev) {
      added.push(toSummary(cur));
      continue;
    }
    const fields: SigDiffFieldChange[] = [];
    if (prev.name !== cur.name) fields.push({ field: 'name', before: prev.name, after: cur.name });
    if (prev.severity !== cur.severity) fields.push({ field: 'severity', before: prev.severity, after: cur.severity });
    if (prev.category !== cur.category) fields.push({ field: 'category', before: prev.category, after: cur.category });
    if (prev.defaultAction !== cur.defaultAction) fields.push({ field: 'defaultAction', before: prev.defaultAction, after: cur.defaultAction });
    if (prev.disabled !== cur.disabled) fields.push({ field: 'disabled', before: prev.disabled, after: cur.disabled });
    if (prev.cvesHash !== cur.cvesHash) fields.push({ field: 'cves', before: prev.cves, after: cur.cves });
    if (fields.length) {
      changed.push({ id: cur.id, kind: cur.kind, name: cur.name, severity: cur.severity, category: cur.category, fields });
    }
  }

  for (const [id, prev] of Object.entries(prevItems)) {
    if (!(id in nextItems)) removed.push(toSummary(prev));
  }

  added.sort(bySevAndId);
  changed.sort(bySevAndId);
  removed.sort(bySevAndId);
  return { added, changed, removed, nextItems };
}

/* ───────── 清單篩選 ───────── */

export interface SigListFilter {
  kind?: SigKind;
  severity?: string;
  q?: string;
  isNew?: boolean;
  hasHits?: boolean;
}

export interface SigListRow extends SigItem {
  firstVersion: string | null;
  isNew: boolean;
  hits30d?: number;
}

export function filterSignatures(rows: readonly SigListRow[], f: SigListFilter): SigListRow[] {
  const q = f.q?.trim().toLowerCase();
  const sev = f.severity?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind && r.kind !== f.kind) return false;
    if (sev && r.severity.toLowerCase() !== sev) return false;
    if (f.isNew !== undefined && r.isNew !== f.isNew) return false;
    if (f.hasHits !== undefined) {
      const has = (r.hits30d ?? 0) > 0;
      if (has !== f.hasHits) return false;
    }
    if (q) {
      const matched =
        r.id.includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.cves.some((c) => c.toLowerCase().includes(q)) ||
        r.vendorIds.some((v) => v.toLowerCase().includes(q));
      if (!matched) return false;
    }
    return true;
  });
}

/* ───────── 規則覆蓋(§5.2;TS-Q5 第一版只看有沒有掛 VP / AS profile) ───────── */

export interface CoverageGapItem {
  position: number;
  name: string;
  fromZones: string[];
  toZones: string[];
  applications: string[];
  profileGroup: string | null;
  hitCount: number | null;
  /** 缺少的防護類型;status === 'unknown' 時可能為空(因為群組無法判定) */
  missing: SigKind[];
  status: 'missing' | 'unknown';
  reason?: string;
}

export interface CoverageResult {
  summary: {
    totalAllowEnabled: number;
    covered: number;
    missingBoth: number;
    missingVulnerability: number;
    missingSpyware: number;
    unknown: number;
  };
  items: CoverageGapItem[];
  /** 未涵蓋規則名稱集合(供命中比對標註「此規則沒有防護,命中只是 log」) */
  unprotectedRules: Set<string>;
}

/** 評估單條啟用中的 allow 安全規則是否有掛弱點防護 / 間諜軟體 profile */
function evaluateRule(
  rule: PolicyRule,
  profiles: SigProfiles | null,
): { status: 'covered' | 'missing' | 'unknown'; missing: SigKind[]; reason?: string } {
  const directVp = (rule.profiles.vulnerability?.length ?? 0) > 0;
  const directAs = (rule.profiles.spyware?.length ?? 0) > 0;

  let hasVp = directVp;
  let hasAs = directAs;

  if (rule.profileGroup) {
    if (!profiles) {
      return {
        status: 'unknown',
        missing: [],
        reason: `無法讀取 vsys1 Profile Group「${rule.profileGroup}」內容,無法判定`,
      };
    }
    const group = profiles.profileGroups[rule.profileGroup];
    if (!group) {
      return {
        status: 'unknown',
        missing: [],
        reason: `在 vsys1 找不到 Profile Group「${rule.profileGroup}」,無法判定`,
      };
    }
    hasVp = hasVp || (group.vulnerability?.length ?? 0) > 0;
    hasAs = hasAs || (group.spyware?.length ?? 0) > 0;
  }

  const missing: SigKind[] = [];
  if (!hasVp) missing.push('vulnerability');
  if (!hasAs) missing.push('spyware');
  return missing.length ? { status: 'missing', missing } : { status: 'covered', missing: [] };
}

export function computeCoverage(
  policySnap: PolicySnapshot,
  policyHits: Record<string, HitInfo>,
  sigProfiles: SigProfiles | null,
): CoverageResult {
  let totalAllowEnabled = 0;
  let covered = 0;
  let missingBoth = 0;
  let missingVulnerability = 0;
  let missingSpyware = 0;
  let unknown = 0;
  const items: CoverageGapItem[] = [];
  const unprotectedRules = new Set<string>();

  for (const rule of policySnap.rules) {
    if (rule.disabled || rule.action.toLowerCase() !== 'allow') continue;
    totalAllowEnabled++;
    const ev = evaluateRule(rule, sigProfiles);
    if (ev.status === 'covered') {
      covered++;
      continue;
    }
    if (ev.status === 'unknown') {
      unknown++;
    } else {
      if (ev.missing.length === 2) missingBoth++;
      else if (ev.missing[0] === 'vulnerability') missingVulnerability++;
      else missingSpyware++;
      unprotectedRules.add(rule.name);
    }
    items.push({
      position: rule.position,
      name: rule.name,
      fromZones: rule.fromZones,
      toZones: rule.toZones,
      applications: rule.applications,
      profileGroup: rule.profileGroup,
      hitCount: policyHits[rule.name]?.hitCount ?? null,
      missing: ev.missing,
      status: ev.status,
      ...(ev.reason ? { reason: ev.reason } : {}),
    });
  }

  return {
    summary: { totalAllowEnabled, covered, missingBoth, missingVulnerability, missingSpyware, unknown },
    items,
    unprotectedRules,
  };
}
