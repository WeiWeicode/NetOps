/**
 * 假 Gateway:PA 安全規則(docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3、§3.6;後端 backend/src/modules/pa-policy)。
 *   - GET  /api/netops/pa-policies、/pa-policies/:name、/pa-policy-checks、/pa-policy-versions、/pa-policy-versions/:id/diffs
 *   - POST /api/netops/pa-policy-refreshes(冷卻 5 分鐘)
 *   - POST /api/netops/ip-name-lookups、/ip-name-range-lookups(§3.6 規則位址對照;netops.ip-name.read)
 * 位址只用文件保留網段(192.0.2.0/24、198.51.100.0/24、203.0.113.0/24),名稱都是假的。
 * MOCK_PA_POLICY=empty 時模擬「尚未取得快照」(available false)。
 */
import type { MockCtx } from './types.ts';

type Kind = 'any' | 'address' | 'group' | 'literal' | 'dynamic-group' | 'region' | 'unknown';
interface Addr { name: string; kind: Kind; values: string[]; unresolved: boolean }

const OBJECTS: Record<string, Addr> = {
  any: { name: 'any', kind: 'any', values: [], unresolved: false },
  'LAN-Office': { name: 'LAN-Office', kind: 'address', values: ['192.0.2.0/24'], unresolved: false },
  'Srv-Web': { name: 'Srv-Web', kind: 'address', values: ['198.51.100.10'], unresolved: false },
  'Srv-DB': { name: 'Srv-DB', kind: 'address', values: ['198.51.100.20'], unresolved: false },
  'Grp-Servers': { name: 'Grp-Servers', kind: 'group', values: ['198.51.100.10', '198.51.100.20', '198.51.100.30-198.51.100.39'], unresolved: false },
  'Partner-Net': { name: 'Partner-Net', kind: 'address', values: ['203.0.113.0/25'], unresolved: false },
  'Update-FQDN': { name: 'Update-FQDN', kind: 'address', values: ['fqdn:updates.example.com'], unresolved: true },
  'DAG-Quarantine': { name: 'DAG-Quarantine', kind: 'dynamic-group', values: ["dynamic:'quarantine'"], unresolved: true },
  '192.0.2.50': { name: '192.0.2.50', kind: 'literal', values: ['192.0.2.50'], unresolved: false },
};
const at = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const hits = (count: number | null, lastDays: number | null) => ({
  hitCount: count,
  lastHit: lastDays === null ? null : at(lastDays),
  firstHit: count ? at(200) : null,
  lastReset: null,
  created: at(400),
  modified: at(30),
});

interface Spec {
  name: string;
  from: string[];
  to: string[];
  src: string[];
  dst: string[];
  app: string[];
  svc: string[];
  action: string;
  hits: ReturnType<typeof hits>;
  disabled?: boolean;
  profile?: string | null;
  logEnd?: boolean;
  tags?: string[];
  description?: string;
}
const SPECS: Spec[] = [
  { name: 'Block-Quarantine', from: ['trust'], to: ['any'], src: ['DAG-Quarantine'], dst: ['any'], app: ['any'], svc: ['any'], action: 'deny', hits: hits(42, 1), tags: ['security'], description: '隔離名單一律阻擋' },
  { name: 'Office-to-Web', from: ['trust'], to: ['dmz'], src: ['LAN-Office'], dst: ['Srv-Web'], app: ['web-browsing', 'ssl'], svc: ['application-default'], action: 'allow', hits: hits(128_340, 0) },
  { name: 'Office-to-Servers', from: ['trust'], to: ['dmz'], src: ['LAN-Office'], dst: ['Grp-Servers'], app: ['any'], svc: ['service-https', 'tcp/1433'], action: 'allow', hits: hits(56_002, 0), profile: null, description: '舊規則,範圍過寬' },
  { name: 'Office-to-DB-Deny', from: ['trust'], to: ['dmz'], src: ['LAN-Office'], dst: ['Srv-DB'], app: ['any'], svc: ['tcp/1433'], action: 'deny', hits: hits(0, null), description: '被上一條遮蔽' },
  { name: 'Partner-API', from: ['untrust'], to: ['dmz'], src: ['Partner-Net'], dst: ['Srv-Web'], app: ['ssl'], svc: ['application-default'], action: 'allow', hits: hits(3_210, 2), logEnd: false, tags: ['partner'] },
  { name: 'Admin-Host-SSH', from: ['trust'], to: ['dmz'], src: ['192.0.2.50'], dst: ['Grp-Servers'], app: ['ssh'], svc: ['application-default'], action: 'allow', hits: hits(12, 120) },
  { name: 'Updates-Out', from: ['dmz'], to: ['untrust'], src: ['Grp-Servers'], dst: ['Update-FQDN'], app: ['any'], svc: ['service-https'], action: 'allow', hits: hits(890, 1) },
  { name: 'Legacy-FTP', from: ['trust'], to: ['untrust'], src: ['LAN-Office'], dst: ['any'], app: ['ftp'], svc: ['application-default'], action: 'allow', hits: hits(0, null), disabled: true, description: '停用待刪' },
  { name: 'Default-Deny-Log', from: ['any'], to: ['any'], src: ['any'], dst: ['any'], app: ['any'], svc: ['any'], action: 'drop', hits: hits(9_876, 0) },
];
const svcValues = (s: string) => (s === 'service-https' ? ['tcp/443'] : s.includes('/') ? [s] : []);
const RULES = SPECS.map((s, i) => ({
  position: i + 1,
  name: s.name,
  uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  type: 'universal',
  tags: s.tags ?? [],
  groupTag: null,
  fromZones: s.from,
  toZones: s.to,
  sources: s.src,
  sourceUsers: [],
  sourceDevices: [],
  negateSource: false,
  destinations: s.dst,
  destinationDevices: [],
  negateDestination: false,
  applications: s.app,
  services: s.svc,
  categories: [],
  action: s.action,
  profileGroup: s.profile === undefined ? (s.action === 'allow' ? 'default' : null) : s.profile,
  profiles: {},
  logStart: false,
  logEnd: s.logEnd ?? true,
  logSetting: 'default-forwarding',
  schedule: null,
  disabled: s.disabled ?? false,
  description: s.description ?? null,
  hits: s.hits,
  expanded: {
    sources: s.src.map((n) => OBJECTS[n]!),
    destinations: s.dst.map((n) => OBJECTS[n]!),
    services: s.svc.map((n) => ({ name: n, kind: n === 'any' ? 'any' : n === 'application-default' ? 'application-default' : n.includes('/') ? 'service' : 'predefined', values: svcValues(n) })),
    applications: s.app.map((n) => ({ name: n, kind: n === 'any' ? 'any' : 'application', values: [] })),
  },
}));
type Rule = (typeof RULES)[number];
const DEFAULTS = [
  { name: 'intrazone-default', ...hits(1_024, 0) },
  { name: 'interzone-default', ...hits(77, 3) },
];

const COOLDOWN = 300;
let lastRefresh = 0;
const fetchedAt = at(0.01);
const status = () => ({
  collectorEnabled: true,
  state: 'ok',
  message: null,
  lastRunAt: fetchedAt,
  lastOkAt: fetchedAt,
  trigger: lastRefresh ? 'manual' : 'schedule',
  mgmtCpu: 12,
  durationMs: 4_300,
  refreshCooldownSec: Math.max(0, COOLDOWN - Math.floor((Date.now() - lastRefresh) / 1000)),
});
const empty = () => process.env.MOCK_PA_POLICY === 'empty';
const snapshot = () =>
  empty()
    ? { available: false, reason: 'no-snapshot', message: '收集器尚未取得規則快照(測試區預設未開啟 PA_POLICY_ENABLED)', status: { ...status(), collectorEnabled: false, state: null } }
    : { available: true, fetchedAt, hash: 'mock-hash-3', versionId: '20261119T000000000Z-000000000003', stale: false, hitsFetchedAt: fetchedAt, ruleCount: RULES.length, status: status() };

const VERSIONS = [
  { id: '20261119T000000000Z-000000000003', hash: 'mock-hash-3', fetchedAt, savedAt: fetchedAt, ruleCount: RULES.length },
  { id: '20261116T000000000Z-000000000002', hash: 'mock-hash-2', fetchedAt: at(3), savedAt: at(3), ruleCount: RULES.length - 1 },
  { id: '20261109T000000000Z-000000000001', hash: 'mock-hash-1', fetchedAt: at(10), savedAt: at(10), ruleCount: RULES.length - 1 },
];

/* IP 對照(只含文件保留網段;姓名為假) */
const LABELS: Record<string, { name: string; department: string; device: string; deviceType: string }> = {
  '192.0.2.50': { name: '測試使用者甲', department: '資訊處', device: 'ADMIN-NB-01', deviceType: '筆電' },
  '192.0.2.21': { name: '測試使用者乙', department: '財務部', device: 'FIN-PC-21', deviceType: '桌機' },
  '192.0.2.88': { name: '', department: '業務部', device: 'SA-PRN-01', deviceType: '印表機' },
  '198.51.100.10': { name: '', department: '資訊處', device: 'WEB-01', deviceType: '伺服器' },
  '198.51.100.20': { name: '', department: '資訊處', device: 'DB-01', deviceType: '伺服器' },
  '198.51.100.31': { name: '', department: '資訊處', device: 'APP-31', deviceType: '伺服器' },
};
const num = (ip: string) => ip.split('.').reduce((x, p) => x * 256 + Number(p), 0);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function bounds(v: string): [number, number] | null {
  const s = v.trim();
  if (IPV4.test(s)) return [num(s), num(s)];
  const [base = '', bits] = s.split('/');
  if (bits !== undefined && IPV4.test(base) && /^\d{1,2}$/.test(bits) && Number(bits) <= 32) {
    const size = 2 ** (32 - Number(bits));
    const lo = Math.floor(num(base) / size) * size;
    return [lo, lo + size - 1];
  }
  const d = s.split('-');
  if (d.length === 2 && IPV4.test(d[0]!.trim()) && IPV4.test(d[1]!.trim())) return [num(d[0]!.trim()), num(d[1]!.trim())];
  return null;
}
const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

function ipMatch(r: Rule, filters: [number, number][], includeAny: boolean): 'yes' | 'maybe' | null {
  const addrs = [...r.expanded.sources, ...r.expanded.destinations];
  if (addrs.some((a) => a.kind === 'any')) return includeAny ? 'yes' : null;
  if (addrs.some((a) => a.values.some((v) => { const b = bounds(v); return b && filters.some((f) => overlaps(b, f)); }))) return 'yes';
  return addrs.some((a) => a.unresolved) ? 'maybe' : null;
}

function filtered(url: URL): Rule[] | string {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const zone = url.searchParams.get('zone');
  const app = url.searchParams.get('application');
  const action = url.searchParams.get('action');
  const disabled = url.searchParams.get('disabled');
  const unusedDays = Number(url.searchParams.get('unusedDays')) || 0;
  const ipText = url.searchParams.get('ip') ?? '';
  const ips = ipText.split(',').map((s) => s.trim()).filter(Boolean);
  const ranges = ips.map(bounds);
  if (ips.length > 50 || ranges.some((b) => !b)) return 'ip 篩選只接受 IPv4、CIDR 或 a-b 範圍(最多 50 個)';
  const includeAny = url.searchParams.get('includeAny') === 'true';
  const out: Rule[] = [];
  for (const r of RULES) {
    if (q && ![r.name, r.description ?? '', ...r.tags].some((v) => v.toLowerCase().includes(q))) continue;
    if (zone && ![...r.fromZones, ...r.toZones].includes(zone)) continue;
    if (app && !r.applications.includes(app)) continue;
    if (action && r.action !== action) continue;
    if (disabled !== null && disabled !== '' && String(r.disabled) !== disabled) continue;
    if (unusedDays && r.hits.lastHit && Date.now() - Date.parse(r.hits.lastHit) < unusedDays * 86_400_000) continue;
    if (ranges.length) {
      const m = ipMatch(r, ranges as [number, number][], includeAny);
      if (!m) continue;
      out.push({ ...r, ipMatch: m } as Rule);
      continue;
    }
    out.push(r);
  }
  return out;
}

const CHECKS = [
  { code: 'shadowed', severity: 'high', position: 4, name: 'Office-to-DB-Deny', related: [{ position: 3, name: 'Office-to-Servers' }], message: '第 3 條已涵蓋相同來源、目的與服務且動作不同,本條永遠不會命中' },
  { code: 'broad-early', severity: 'medium', position: 3, name: 'Office-to-Servers', related: [], message: '目的為整個伺服器群組、應用程式 any,位置偏前' },
  { code: 'no-profile', severity: 'low', position: 3, name: 'Office-to-Servers', related: [], message: '允許規則沒有 Security Profile' },
  { code: 'no-log-end', severity: 'low', position: 5, name: 'Partner-API', related: [], message: '沒有勾選 Log at Session End' },
  { code: 'disabled', severity: 'info', position: 8, name: 'Legacy-FTP', related: [], message: '規則已停用' },
  { code: 'undeterminable', severity: 'info', position: 7, name: 'Updates-Out', related: [], message: '目的含 FQDN,無法精準比對', reasons: ['fqdn:updates.example.com'] },
] as const;
/** 長期未命中:Admin-Host-SSH 最後命中 120 天前,依 unusedDays 重算 */
const unusedItem = (days: number) => (days <= 120 ? [{ code: 'unused', severity: 'info', position: 6, name: 'Admin-Host-SSH', related: [], message: `超過 ${days} 天未命中` }] : []);

export function handlePaPolicy({ method, path, url, body, need, send, fail }: MockCtx): boolean {
  if (path === '/api/netops/ip-name-lookups' && method === 'POST') {
    if (!need('netops.ip-name.read')) return true;
    const ips = ((body as { ips?: unknown })?.ips ?? []) as string[];
    if (!Array.isArray(ips) || ips.length > 200) return (fail(400, 'VALIDATION_FAILED', 'ips 最多 200 個'), true);
    send(200, { names: Object.fromEntries(ips.filter((ip) => LABELS[ip]).map((ip) => [ip, LABELS[ip]])) });
    return true;
  }
  if (path === '/api/netops/ip-name-range-lookups' && method === 'POST') {
    if (!need('netops.ip-name.read')) return true;
    const ranges = ((body as { ranges?: unknown })?.ranges ?? []) as string[];
    if (!Array.isArray(ranges) || ranges.length > 200) return (fail(400, 'VALIDATION_FAILED', 'ranges 最多 200 個'), true);
    const results: Record<string, unknown> = {};
    for (const r of ranges) {
      const b = bounds(r);
      if (!b) {
        results[r] = { invalid: true };
        continue;
      }
      const items = Object.entries(LABELS).filter(([ip]) => num(ip) >= b[0] && num(ip) <= b[1]).map(([ip, l]) => ({ ip, ...l }));
      results[r] = { items: items.slice(0, 50), total: items.length, truncated: items.length > 50 };
    }
    send(200, { results });
    return true;
  }
  if (!/^\/api\/netops\/pa-polic/.test(path)) return false;

  if (path === '/api/netops/pa-policy-refreshes' && method === 'POST') {
    if (!need('netops.pa-policy.refresh')) return true;
    if (empty()) return (fail(409, 'NETOPS_PA_POLICY_DISABLED', '規則收集器未啟用(PA_POLICY_ENABLED=0)'), true);
    const left = status().refreshCooldownSec;
    if (lastRefresh && left > 0) return (fail(429, 'NETOPS_PA_POLICY_REFRESH_COOLDOWN', `剛重新整理過,請 ${left} 秒後再試`), true);
    lastRefresh = Date.now();
    send(202, { requestedAt: new Date().toISOString(), cooldownSec: COOLDOWN });
    return true;
  }
  if (method !== 'GET' || !need('netops.pa-policy.read')) return true;

  if (path === '/api/netops/pa-policies') {
    const r = filtered(url);
    if (typeof r === 'string') return (fail(400, 'VALIDATION_FAILED', r), true);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Number(url.searchParams.get('pageSize')) || 100);
    const snap = snapshot();
    const items = snap.available ? r : [];
    send(200, { ...snap, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, defaults: snap.available ? DEFAULTS : [] });
    return true;
  }
  const one = path.match(/^\/api\/netops\/pa-policies\/([^/]+)$/);
  if (one) {
    if (empty()) return (fail(404, 'NETOPS_PA_POLICY_UNAVAILABLE', '收集器尚未取得規則快照'), true);
    const name = decodeURIComponent(one[1]!);
    const rule = RULES.find((r) => r.name === name);
    if (!rule) return (fail(404, 'NETOPS_PA_POLICY_NOT_FOUND', `找不到規則 ${name}`), true);
    send(200, { ...snapshot(), rule });
    return true;
  }
  if (path === '/api/netops/pa-policy-checks') {
    const unusedDays = Number(url.searchParams.get('unusedDays')) || 90;
    const snap = snapshot();
    if (!snap.available) return (send(200, { ...snap, items: [], summary: null, imprecise: 0, unusedDays }), true);
    const items = [...CHECKS, ...unusedItem(unusedDays)];
    const summary = Object.fromEntries(['conflict', 'shadowed', 'redundant', 'broad-early', 'unused', 'disabled', 'no-profile', 'no-log-end', 'undeterminable'].map((c) => [c, items.filter((i) => i.code === c).length]));
    send(200, { ...snap, items, summary, imprecise: 1, unusedDays });
    return true;
  }
  if (path === '/api/netops/pa-policy-versions') {
    send(200, { items: empty() ? [] : VERSIONS, total: empty() ? 0 : VERSIONS.length });
    return true;
  }
  const diff = path.match(/^\/api\/netops\/pa-policy-versions\/([^/]+)\/diffs$/);
  if (diff) {
    const i = VERSIONS.findIndex((v) => v.id === decodeURIComponent(diff[1]!));
    if (i < 0 || empty()) return (fail(404, 'NETOPS_PA_POLICY_VERSION_NOT_FOUND', '找不到這個版本'), true);
    const baseId = url.searchParams.get('base') ?? VERSIONS[i + 1]?.id ?? null;
    const base = VERSIONS.find((v) => v.id === baseId) ?? null;
    if (baseId && !base) return (fail(404, 'NETOPS_PA_POLICY_VERSION_NOT_FOUND', '找不到比較的版本'), true);
    const rules = !base
      ? []
      : i === 0
        ? [
            { kind: 'added', name: 'Block-Quarantine', position: 1, basePosition: null },
            { kind: 'moved', name: 'Office-to-DB-Deny', position: 4, basePosition: 2 },
            { kind: 'changed', name: 'Partner-API', position: 5, basePosition: 5, fields: [{ field: 'logEnd', before: true, after: false }, { field: 'sources', before: ['203.0.113.0/26'], after: ['Partner-Net'] }] },
          ]
        : [{ kind: 'removed', name: 'Temp-Allow-Vendor', position: null, basePosition: 6 }];
    const objects = !base ? [] : [{ kind: 'addresses', added: i === 0 ? ['Partner-Net'] : [], removed: [], changed: i === 0 ? [] : ['Srv-Web'] }];
    send(200, { id: VERSIONS[i]!.id, baseId: base?.id ?? null, version: VERSIONS[i], base, rules, objects });
    return true;
  }
  return false;
}
