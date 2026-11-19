/**
 * PA 安全規則核心(PR-2;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3):快照驗證、物件展開、篩選、版本差異。純函式,不依賴 Fastify。
 * 快照格式由 pa-collector/netops_pa/policies.py 產生(rules 依 PA 順序含 position;objects 各類物件)。
 * 物件展開只支援 IPv4(同 AC3);FQDN、動態位址群組、地區、wildcard、IPv6 標為無法展開(unresolved):IP 篩選列為 ipMatch maybe,排序檢查標無法判定,都不把它當成「沒有」。
 */

export interface PolicyRule {
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
}

export interface AddressObj { name: string; type: string; value: string | null; description?: string | null; tags?: string[] }
export interface AddressGroupObj { name: string; static: string[]; dynamic: string | null; description?: string | null; tags?: string[] }
export interface ServiceObj { name: string; protocol: string | null; destinationPort: string | null; sourcePort: string | null; description?: string | null }
export interface MemberGroupObj { name: string; members: string[] }

export interface PolicyObjects {
  addresses: AddressObj[];
  addressGroups: AddressGroupObj[];
  services: ServiceObj[];
  serviceGroups: MemberGroupObj[];
  applicationGroups: MemberGroupObj[];
  tags: { name: string; color: string | null; comments: string | null }[];
}

export interface HitInfo {
  hitCount: number | null;
  lastHit: string | null;
  firstHit: string | null;
  lastReset: string | null;
  created: string | null;
  modified: string | null;
}

export interface Snapshot {
  fetchedAt: string;
  hash: string;
  rules: PolicyRule[];
  objects: PolicyObjects;
}

/* ───────── 快照驗證 ───────── */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : []);

export function toRule(r: Record<string, unknown>, i: number): PolicyRule {
  const profiles: Record<string, string[]> = {};
  if (r.profiles && typeof r.profiles === 'object' && !Array.isArray(r.profiles))
    for (const [k, v] of Object.entries(r.profiles as Record<string, unknown>)) profiles[k] = strs(v);
  return {
    position: Number.isSafeInteger(r.position) ? (r.position as number) : i + 1,
    name: str(r.name),
    uuid: strOrNull(r.uuid),
    type: str(r.type) || 'universal',
    tags: strs(r.tags),
    groupTag: strOrNull(r.groupTag),
    fromZones: strs(r.fromZones),
    toZones: strs(r.toZones),
    sources: strs(r.sources),
    sourceUsers: strs(r.sourceUsers),
    sourceDevices: strs(r.sourceDevices),
    negateSource: r.negateSource === true,
    destinations: strs(r.destinations),
    destinationDevices: strs(r.destinationDevices),
    negateDestination: r.negateDestination === true,
    applications: strs(r.applications),
    services: strs(r.services),
    categories: strs(r.categories),
    action: str(r.action),
    profileGroup: strOrNull(r.profileGroup),
    profiles,
    logStart: r.logStart === true,
    logEnd: r.logEnd === true,
    logSetting: strOrNull(r.logSetting),
    schedule: strOrNull(r.schedule),
    disabled: r.disabled === true,
    description: strOrNull(r.description),
  };
}

export function toObjects(v: unknown): PolicyObjects {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    addresses: objs(o.addresses).map((a) => ({ name: str(a.name), type: str(a.type) || 'ip-netmask', value: strOrNull(a.value), description: strOrNull(a.description), tags: strs(a.tags) })),
    addressGroups: objs(o.addressGroups).map((a) => ({ name: str(a.name), static: strs(a.static), dynamic: strOrNull(a.dynamic), description: strOrNull(a.description), tags: strs(a.tags) })),
    services: objs(o.services).map((a) => ({ name: str(a.name), protocol: strOrNull(a.protocol), destinationPort: strOrNull(a.destinationPort), sourcePort: strOrNull(a.sourcePort), description: strOrNull(a.description) })),
    serviceGroups: objs(o.serviceGroups).map((a) => ({ name: str(a.name), members: strs(a.members) })),
    applicationGroups: objs(o.applicationGroups).map((a) => ({ name: str(a.name), members: strs(a.members) })),
    tags: objs(o.tags).map((a) => ({ name: str(a.name), color: strOrNull(a.color), comments: strOrNull(a.comments) })),
  };
}

/** Redis 快照 → Snapshot;格式不符回 null(呼叫端當成沒有快照) */
export function parseSnapshot(raw: Record<string, unknown> | null): Snapshot | null {
  if (!raw || typeof raw.hash !== 'string' || !/^[0-9a-f]{12,128}$/i.test(raw.hash) || !Array.isArray(raw.rules)) return null;
  const rules = objs(raw.rules).map(toRule).sort((a, b) => a.position - b.position);
  return { fetchedAt: str(raw.fetchedAt), hash: raw.hash.toLowerCase(), rules, objects: toObjects(raw.objects) };
}

export function parseHits(raw: Record<string, unknown> | null): { fetchedAt: string | null; items: Record<string, HitInfo> } {
  const items: Record<string, HitInfo> = {};
  const src = raw?.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? (raw.items as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const h = v as Record<string, unknown>;
    items[name] = {
      hitCount: typeof h.hitCount === 'number' && Number.isFinite(h.hitCount) ? h.hitCount : null,
      lastHit: strOrNull(h.lastHit),
      firstHit: strOrNull(h.firstHit),
      lastReset: strOrNull(h.lastReset),
      created: strOrNull(h.created),
      modified: strOrNull(h.modified),
    };
  }
  return { fetchedAt: raw ? strOrNull(raw.fetchedAt) : null, items };
}

/* ───────── IPv4 範圍 ───────── */

export type Range = [number, number];
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ipInt = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
export const intIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/** IPv4、CIDR 或 a-b 範圍 → [起, 迄];不是 IPv4 回 null */
export function parseRange(raw: string): Range | null {
  const s = raw.trim();
  const dash = s.indexOf('-');
  if (dash > 0) {
    const a = s.slice(0, dash).trim();
    const b = s.slice(dash + 1).trim();
    if (!IPV4.test(a) || !IPV4.test(b)) return null;
    const x = ipInt(a);
    const y = ipInt(b);
    return x <= y ? [x, y] : null;
  }
  const [addr = '', bits, extra] = s.split('/');
  if (extra !== undefined || !IPV4.test(addr)) return null;
  const n = bits === undefined ? 32 : /^\d{1,2}$/.test(bits) ? Number(bits) : -1;
  if (n < 0 || n > 32) return null;
  const size = 2 ** (32 - n);
  const base = Math.floor(ipInt(addr) / size) * size;
  return [base, base + size - 1];
}

export const overlaps = (a: Range, b: Range) => a[0] <= b[1] && b[0] <= a[1];
export const containsRange = (outer: Range, inner: Range) => outer[0] <= inner[0] && inner[1] <= outer[1];

/** 多個區間是否完全涵蓋 inner(區間已合併時正確;這裡先合併) */
export function coveredBy(inner: Range[], outer: Range[]): boolean {
  const merged = mergeRanges(outer);
  return inner.every((r) => merged.some((o) => containsRange(o, r)));
}

export function mergeRanges(rs: Range[]): Range[] {
  const sorted = rs.slice().sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/* ───────── 物件展開 ───────── */

export type AddressKind = 'any' | 'address' | 'group' | 'literal' | 'dynamic-group' | 'region' | 'unknown';
export interface ExpandedAddress {
  /** 規則上寫的名稱 */
  name: string;
  kind: AddressKind;
  /** 展開後的值(ip-netmask / ip-range 的文字、fqdn 加前綴 fqdn:、wildcard 加 wildcard:),依出現順序、不重複 */
  values: string[];
  /** 有無法換成 IPv4 範圍的成員(FQDN、動態群組、地區、wildcard、IPv6、找不到的物件、群組太深) */
  unresolved: boolean;
}
export interface ExpandedService { name: string; kind: 'any' | 'application-default' | 'service' | 'predefined' | 'group' | 'unknown'; values: string[] }
export interface ExpandedApplication { name: string; kind: 'any' | 'application' | 'group'; values: string[] }

/** PAN-OS 預設服務(沒有物件定義) */
const PREDEFINED_SERVICES: Record<string, string[]> = { 'service-http': ['tcp/80', 'tcp/8080'], 'service-https': ['tcp/443'] };
const MAX_DEPTH = 10;
const REGION = /^[A-Z]{2}$/;

export interface ObjectIndex {
  address: Map<string, AddressObj>;
  addressGroup: Map<string, AddressGroupObj>;
  service: Map<string, ServiceObj>;
  serviceGroup: Map<string, MemberGroupObj>;
  applicationGroup: Map<string, MemberGroupObj>;
}

export function indexObjects(o: PolicyObjects): ObjectIndex {
  const m = <T extends { name: string }>(xs: T[]) => new Map(xs.map((x) => [x.name, x]));
  return { address: m(o.addresses), addressGroup: m(o.addressGroups), service: m(o.services), serviceGroup: m(o.serviceGroups), applicationGroup: m(o.applicationGroups) };
}

interface Leaves { values: string[]; ranges: Range[]; unresolved: boolean }

function addressLeaves(name: string, idx: ObjectIndex, depth: number, seen: Set<string>, out: Leaves): AddressKind {
  const a = idx.address.get(name);
  if (a) {
    const v = a.value ?? '';
    if (a.type === 'ip-netmask' || a.type === 'ip-range') {
      out.values.push(v);
      const r = parseRange(v);
      if (r) out.ranges.push(r);
      else out.unresolved = true;
    } else {
      out.values.push(`${a.type === 'fqdn' ? 'fqdn' : a.type}:${v}`);
      out.unresolved = true;
    }
    return 'address';
  }
  const g = idx.addressGroup.get(name);
  if (g) {
    if (depth >= MAX_DEPTH || seen.has(name)) {
      out.unresolved = true;
      return 'group';
    }
    seen.add(name);
    if (g.dynamic) {
      out.values.push(`dynamic:${g.dynamic}`);
      out.unresolved = true;
      seen.delete(name);
      return 'dynamic-group';
    }
    for (const m of g.static) addressLeaves(m, idx, depth + 1, seen, out);
    seen.delete(name);
    return 'group';
  }
  const r = parseRange(name);
  if (r) {
    out.values.push(name);
    out.ranges.push(r);
    return 'literal';
  }
  out.values.push(name);
  out.unresolved = true;
  return REGION.test(name) ? 'region' : 'unknown';
}

export interface AddressSide {
  items: ExpandedAddress[];
  any: boolean;
  /** 所有可換成 IPv4 的範圍(已合併) */
  ranges: Range[];
  unresolved: boolean;
}

export function expandAddresses(names: string[], idx: ObjectIndex): AddressSide {
  if (!names.length || names.includes('any')) return { items: [{ name: 'any', kind: 'any', values: [], unresolved: false }], any: true, ranges: [[0, 0xffffffff]], unresolved: false };
  const items: ExpandedAddress[] = [];
  const all: Range[] = [];
  let unresolved = false;
  for (const name of names) {
    const out: Leaves = { values: [], ranges: [], unresolved: false };
    const kind = addressLeaves(name, idx, 0, new Set(), out);
    items.push({ name, kind, values: [...new Set(out.values)], unresolved: out.unresolved });
    all.push(...out.ranges);
    unresolved ||= out.unresolved;
  }
  return { items, any: false, ranges: mergeRanges(all), unresolved };
}

function serviceLeaves(name: string, idx: ObjectIndex, depth: number, seen: Set<string>, out: string[]): ExpandedService['kind'] {
  const s = idx.service.get(name);
  if (s) {
    for (const p of (s.destinationPort ?? '').split(',').map((x) => x.trim()).filter(Boolean)) out.push(`${s.protocol ?? '?'}/${p}`);
    return 'service';
  }
  if (PREDEFINED_SERVICES[name]) {
    out.push(...PREDEFINED_SERVICES[name]!);
    return 'predefined';
  }
  const g = idx.serviceGroup.get(name);
  if (g && depth < MAX_DEPTH && !seen.has(name)) {
    seen.add(name);
    for (const m of g.members) serviceLeaves(m, idx, depth + 1, seen, out);
    seen.delete(name);
    return 'group';
  }
  out.push(name);
  return 'unknown';
}

export function expandServices(names: string[], idx: ObjectIndex): ExpandedService[] {
  if (!names.length || names.includes('any')) return [{ name: 'any', kind: 'any', values: [] }];
  return names.map((name) => {
    if (name === 'application-default') return { name, kind: 'application-default' as const, values: [] };
    const out: string[] = [];
    const kind = serviceLeaves(name, idx, 0, new Set(), out);
    return { name, kind, values: [...new Set(out)] };
  });
}

function appLeaves(name: string, idx: ObjectIndex, depth: number, seen: Set<string>, out: string[]): boolean {
  const g = idx.applicationGroup.get(name);
  if (!g || depth >= MAX_DEPTH || seen.has(name)) {
    out.push(name);
    return false;
  }
  seen.add(name);
  for (const m of g.members) appLeaves(m, idx, depth + 1, seen, out);
  seen.delete(name);
  return true;
}

export function expandApplications(names: string[], idx: ObjectIndex): ExpandedApplication[] {
  if (!names.length || names.includes('any')) return [{ name: 'any', kind: 'any', values: [] }];
  return names.map((name) => {
    const out: string[] = [];
    const group = appLeaves(name, idx, 0, new Set(), out);
    return { name, kind: group ? ('group' as const) : ('application' as const), values: group ? [...new Set(out)] : [] };
  });
}

/** 清單與詳細的一條規則:快照欄位 + 命中數 + 展開結果 */
export interface ExpandedRule extends PolicyRule {
  hits: HitInfo | null;
  expanded: { sources: ExpandedAddress[]; destinations: ExpandedAddress[]; services: ExpandedService[]; applications: ExpandedApplication[] };
}

/** 規則 + 篩選與檢查用的內部欄位(不回給 API) */
export interface RuleView {
  rule: ExpandedRule;
  src: AddressSide;
  dst: AddressSide;
}

export function buildViews(snap: Snapshot, hits: Record<string, HitInfo>): RuleView[] {
  const idx = indexObjects(snap.objects);
  return snap.rules.map((r) => {
    const src = expandAddresses(r.sources, idx);
    const dst = expandAddresses(r.destinations, idx);
    return {
      src,
      dst,
      rule: {
        ...r,
        hits: hits[r.name] ?? null,
        expanded: { sources: src.items, destinations: dst.items, services: expandServices(r.services, idx), applications: expandApplications(r.applications, idx) },
      },
    };
  });
}

/** 命中數裡有、規則裡沒有的(intrazone-default / interzone-default;PR-0) */
export function defaultRules(snap: Snapshot, hits: Record<string, HitInfo>): ({ name: string } & HitInfo)[] {
  const names = new Set(snap.rules.map((r) => r.name));
  return Object.entries(hits)
    .filter(([n]) => !names.has(n))
    .map(([name, h]) => ({ name, ...h }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ───────── 篩選 ───────── */

export interface RuleFilter {
  /** 名稱、說明、標籤(部分比對,不分大小寫) */
  q?: string;
  /** 來源或目的 zone(完全比對,不分大小寫;規則 zone 為 any 也算) */
  zone?: string;
  /** IPv4 / CIDR / a-b,最多 50 個:展開後的來源或目的範圍有重疊的規則 */
  ips?: Range[];
  /** IP 篩選也包含來源 / 目的為 any 的規則(預設不含,否則幾乎每條都符合) */
  includeAny?: boolean;
  /** 應用(部分比對;含應用群組展開後的成員) */
  application?: string;
  action?: string;
  /** 長期未命中:命中數 0 / 沒有命中數,或最後命中早於 N 天前 */
  unusedDays?: number;
  disabled?: boolean;
}

/** 長期未命中(PR-5 的同一條規則):沒有命中數資料時回 null(無法判定) */
export function isUnused(h: HitInfo | null, days: number, now: number): boolean | null {
  if (!h || h.hitCount === null) return null;
  if (h.hitCount === 0) return true;
  if (!h.lastHit) return null;
  const t = Date.parse(h.lastHit);
  return Number.isNaN(t) ? null : now - t > days * 86400_000;
}

/**
 * IP 篩選比對一條規則:yes 確定有重疊;maybe 無法確定(該側含無法展開的物件,或是 negate:反向條件不能用重疊判斷);no 確定沒有。
 * any 只有 includeAny 時算 yes。maybe 的規則一樣列出(清單 items 帶 ipMatch: "maybe"),不當成沒有。
 */
export function ipMatch(v: RuleView, ips: Range[], includeAny: boolean): 'yes' | 'maybe' | 'no' {
  const side = (s: AddressSide, negate: boolean): 'yes' | 'maybe' | 'no' => {
    if (negate) return 'maybe';
    if (s.any) return includeAny ? 'yes' : 'no';
    if (ips.some((q) => s.ranges.some((r) => overlaps(q, r)))) return 'yes';
    return s.unresolved ? 'maybe' : 'no';
  };
  const a = side(v.src, v.rule.negateSource);
  const b = side(v.dst, v.rule.negateDestination);
  return a === 'yes' || b === 'yes' ? 'yes' : a === 'maybe' || b === 'maybe' ? 'maybe' : 'no';
}

export function filterRules(views: RuleView[], f: RuleFilter, now = Date.now()): RuleView[] {
  const q = f.q?.trim().toLowerCase();
  const zone = f.zone?.trim().toLowerCase();
  const app = f.application?.trim().toLowerCase();
  const action = f.action?.trim().toLowerCase();
  return views.filter(({ rule: r, src, dst }) => {
    if (q && ![r.name, r.description ?? '', ...r.tags].some((v) => v.toLowerCase().includes(q))) return false;
    if (zone && ![...r.fromZones, ...r.toZones].some((z) => z.toLowerCase() === zone || z === 'any')) return false;
    if (action && r.action.toLowerCase() !== action) return false;
    if (f.disabled !== undefined && r.disabled !== f.disabled) return false;
    if (app) {
      const names = r.applications.length ? r.applications : ['any'];
      const members = r.expanded.applications.flatMap((a) => [a.name, ...a.values]);
      if (!names.includes('any') && !members.some((a) => a.toLowerCase().includes(app))) return false;
    }
    if (f.ips?.length && ipMatch({ rule: r, src, dst }, f.ips, f.includeAny === true) === 'no') return false;
    if (f.unusedDays !== undefined && isUnused(r.hits, f.unusedDays, now) !== true) return false;
    return true;
  });
}

/* ───────── 版本差異 ───────── */

/** 比對的欄位(position 另以「移動」呈現) */
export const DIFF_FIELDS = [
  'name', 'type', 'tags', 'groupTag', 'fromZones', 'toZones', 'sources', 'sourceUsers', 'sourceDevices', 'negateSource',
  'destinations', 'destinationDevices', 'negateDestination', 'applications', 'services', 'categories', 'action',
  'profileGroup', 'profiles', 'logStart', 'logEnd', 'logSetting', 'schedule', 'disabled', 'description',
] as const;

export interface RuleChange {
  kind: 'added' | 'removed' | 'moved' | 'changed';
  name: string;
  /** 新版本的位置(removed 為 null) */
  position: number | null;
  /** 舊版本的位置(added 為 null) */
  basePosition: number | null;
  /** changed:各欄位前後值;moved 但內容也改了時一併列出 */
  fields?: { field: string; before: unknown; after: unknown }[];
}

export interface ObjectChange { kind: keyof PolicyObjects; added: string[]; removed: string[]; changed: string[] }

const keyOf = (r: PolicyRule) => (r.uuid ? `u:${r.uuid}` : `n:${r.name}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 最長遞增子序列的索引(相對順序沒變的規則;其他的才算「移動」) */
function lisIndexes(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Set<number>();
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    out.add(k);
    k = prev[k]!;
  }
  return out;
}

/** base(舊)→ cur(新)的規則差異,依新版本位置排序(刪除的依舊位置排在最後) */
export function diffRules(base: PolicyRule[], cur: PolicyRule[]): RuleChange[] {
  const old = new Map(base.map((r) => [keyOf(r), r]));
  const now = new Map(cur.map((r) => [keyOf(r), r]));
  const common = cur.filter((r) => old.has(keyOf(r)));
  const stay = lisIndexes(common.map((r) => old.get(keyOf(r))!.position));
  const moved = new Set(common.filter((_, i) => !stay.has(i)).map(keyOf));
  const out: RuleChange[] = [];
  for (const r of cur) {
    const o = old.get(keyOf(r));
    if (!o) {
      out.push({ kind: 'added', name: r.name, position: r.position, basePosition: null });
      continue;
    }
    const fields = DIFF_FIELDS.filter((f) => !same(o[f], r[f])).map((f) => ({ field: f, before: o[f], after: r[f] }));
    if (moved.has(keyOf(r))) out.push({ kind: 'moved', name: r.name, position: r.position, basePosition: o.position, ...(fields.length ? { fields } : {}) });
    else if (fields.length) out.push({ kind: 'changed', name: r.name, position: r.position, basePosition: o.position, fields });
  }
  for (const o of base) if (!now.has(keyOf(o))) out.push({ kind: 'removed', name: o.name, position: null, basePosition: o.position });
  return out;
}

export function diffObjects(base: PolicyObjects, cur: PolicyObjects): ObjectChange[] {
  const kinds = Object.keys(cur) as (keyof PolicyObjects)[];
  return kinds
    .map((kind) => {
      const a = new Map<string, unknown>(base[kind].map((x) => [x.name, x]));
      const b = new Map<string, unknown>(cur[kind].map((x) => [x.name, x]));
      return {
        kind,
        added: [...b.keys()].filter((n) => !a.has(n)),
        removed: [...a.keys()].filter((n) => !b.has(n)),
        changed: [...b.keys()].filter((n) => a.has(n) && !same(a.get(n), b.get(n))),
      };
    })
    .filter((c) => c.added.length || c.removed.length || c.changed.length);
}

/** IP 篩選參數:逗號分隔的 IPv4 / CIDR / a-b;格式不符回 null */
export function parseIpFilter(text: string, max = 50): Range[] | null {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > max) return null;
  const out: Range[] = [];
  for (const p of parts) {
    const r = parseRange(p);
    if (!r) return null;
    out.push(r);
  }
  return out;
}
