/**
 * PA 即時監控戰情室(WR-1、WR-2,docs/WARROOM-PLAN.md §3):讀 netops-redis(只經 infra/redis 具名函式),不依賴 Fastify。
 *
 * WR-1 GET /v1/pa-live/warroom:最近 minutes 分鐘的「外部來源 → 防火牆 → 內部網段」聚合。
 *   - 來源與網段的配對、每個來源的阻擋比例,Redis 統計(每分鐘 Hash / 排行)沒有,只能從明細 Stream 算:
 *     由新到舊讀到期間開頭為止,最多 TRAFFIC_SCAN_MAX 筆;讀到上限仍沒到開頭時,以已涵蓋的秒數換算速率並按比例放大次數(sample 標示)。
 *   - 外部 / 內部:私有位址(RFC 1918、CGNAT、loopback、link-local、ULA)算內部,其他算外部;外部 IP 以離線 GeoIP 查國家(Q2),
 *     內部 IP 以設定檔 CIDR 對照網段(Q3)。兩端都是內部 → 來源 "lan";兩端都是外部 → 網段 "unmatched"。
 *   - 速率(links 每秒)= 次數 / 涵蓋秒數;前端用來決定粒子密度與顏色。
 * WR-2 GET /v1/pa-live/risk:近一小時威脅 / 阻擋統計,主要用每分鐘統計(精確),嚴重度與阻擋比例由威脅明細抽樣補上。
 *
 * 失敗要明確(AGENT.md §5):Redis 不可用 → 200 + partial: true、陣列為空、message 說明,不回假資料;
 * 網段設定檔不存在 → 用內建範例並標示 segmentsSource "example";GeoIP 不可用 → geo.available false、國家併入「未知」。
 */
import { isIP } from 'node:net';
import { GEOIP_ATTRIBUTION, type GeoIp } from '../../infra/geoip/index.js';
import { RedisReplyError, RedisUnavailableError, type PaLiveRedis, type StreamEntry } from '../../infra/redis/index.js';
import type { WarroomStore } from '../../infra/store/index.js';
import { bucketsOf } from './service.js';

// ---------- 設定(Q3、Q5) ----------

export type SegmentKind = 'vlan' | 'service';

export interface SegmentDef {
  id: string;
  label: string;
  kind: SegmentKind;
  icon: string;
  cidrs: string[];
}

export interface WarroomConfig {
  /** 儀表滿格值(Q5;預設 1 Gbps / 64K,依 PA-560 規格調整) */
  gauge: { throughputMaxBps: number; sessionMax: number };
  segments: SegmentDef[];
}

export const DEFAULT_GAUGE = { throughputMaxBps: 1_000_000_000, sessionMax: 64_000 } as const;

/**
 * 範例網段(網通清單還沒來,WARROOM-PLAN §6 待辦):只給畫面開發與測試區驗證用,回應標示 segmentsSource "example"。
 * 正式清單放資料目錄 warroom/warroom.json(格式同 parseWarroomConfig)後自動改用。
 */
export const EXAMPLE_CONFIG: WarroomConfig = {
  gauge: { ...DEFAULT_GAUGE },
  segments: [
    { id: 'office', label: '辦公網段(範例)', kind: 'vlan', icon: 'office', cidrs: ['10.10.112.0/22'] },
    { id: 'server', label: '伺服器區(範例)', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] },
    { id: 'factory', label: '廠區網段(範例)', kind: 'vlan', icon: 'factory', cidrs: ['10.20.0.0/16'] },
    { id: 'wifi', label: '無線網路(範例)', kind: 'vlan', icon: 'wifi', cidrs: ['192.168.0.0/16'] },
    { id: 'dmz', label: 'DMZ(範例)', kind: 'service', icon: 'globe', cidrs: ['172.16.0.0/12'] },
  ],
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ICON_RE = /^[a-z0-9-]{1,30}$/;
/** 保留 id:未對照到設定的內部 IP / 外部對外部 */
export const UNMATCHED_SEGMENT = 'unmatched';

export interface ConfigError {
  /** 欄位路徑,例如 segments[2].cidrs[0] */
  field: string;
  message: string;
}

/**
 * 設定檔驗證(SG-1):收集全部欄位錯誤(網段設定頁一次標出);沒有錯誤時 cfg 為正規化後的設定。
 * 未知欄位(version、updatedAt 等)略過,不算錯誤。
 */
export function checkWarroomConfig(raw: unknown): { cfg: WarroomConfig | null; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { cfg: null, errors: [{ field: '', message: '設定檔必須是 JSON 物件' }] };
  const o = raw as Record<string, unknown>;
  const g = (o.gauge ?? {}) as Record<string, unknown>;
  if (o.gauge !== undefined && (typeof o.gauge !== 'object' || o.gauge === null || Array.isArray(o.gauge))) err('gauge', 'gauge 必須是物件');
  const num = (v: unknown, def: number, name: string) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      err(`gauge.${name}`, `gauge.${name} 必須是正數`);
      return def;
    }
    return v;
  };
  const gauge = { throughputMaxBps: num(g.throughputMaxBps, DEFAULT_GAUGE.throughputMaxBps, 'throughputMaxBps'), sessionMax: num(g.sessionMax, DEFAULT_GAUGE.sessionMax, 'sessionMax') };
  if (!Array.isArray(o.segments)) {
    err('segments', 'segments 必須是陣列');
    return { cfg: null, errors };
  }
  if (o.segments.length > 100) {
    err('segments', 'segments 最多 100 個');
    return { cfg: null, errors };
  }
  const ids = new Set<string>();
  const segments: SegmentDef[] = [];
  o.segments.forEach((s, i) => {
    const e = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const at = `segments[${i}]`;
    const before = errors.length;
    if (typeof e.id !== 'string' || !ID_RE.test(e.id) || e.id === UNMATCHED_SEGMENT) err(`${at}.id`, `${at}.id 格式錯誤(小寫英數與 -,不可為 ${UNMATCHED_SEGMENT})`);
    else if (ids.has(e.id)) err(`${at}.id`, `${at}.id 重複:${e.id}`);
    else ids.add(e.id);
    if (typeof e.label !== 'string' || !e.label.trim() || e.label.length > 40) err(`${at}.label`, `${at}.label 必須是 1–40 字`);
    if (e.kind !== 'vlan' && e.kind !== 'service') err(`${at}.kind`, `${at}.kind 只能是 vlan 或 service`);
    const icon = e.icon === undefined ? (e.kind === 'service' ? 'server' : 'network') : e.icon;
    if (typeof icon !== 'string' || !ICON_RE.test(icon)) err(`${at}.icon`, `${at}.icon 格式錯誤`);
    if (!Array.isArray(e.cidrs) || !e.cidrs.length || e.cidrs.length > 50) err(`${at}.cidrs`, `${at}.cidrs 必須是 1–50 個 IPv4 CIDR`);
    else
      e.cidrs.forEach((c, k) => {
        if (typeof c !== 'string' || !parseCidr(c)) err(`${at}.cidrs[${k}]`, `${at}.cidrs 格式錯誤:${String(c).slice(0, 50)}`);
      });
    if (errors.length === before) segments.push({ id: e.id as string, label: (e.label as string).trim(), kind: e.kind as SegmentKind, icon: icon as string, cidrs: e.cidrs as string[] });
  });
  return errors.length ? { cfg: null, errors } : { cfg: { gauge, segments }, errors };
}

/** 設定檔 → WarroomConfig;格式錯誤丟 Error(訊息為第一個錯誤,指出哪個欄位,不含檔案路徑) */
export function parseWarroomConfig(raw: unknown): WarroomConfig {
  const r = checkWarroomConfig(raw);
  if (!r.cfg) throw new Error(r.errors[0]?.message ?? '設定檔格式錯誤');
  return r.cfg;
}

export interface SegmentOverlap {
  a: { id: string; cidr: string };
  b: { id: string; cidr: string };
}

/** 不同網段之間重疊的 CIDR(允許重疊,對照時最長前綴優先;網段設定頁標出來讓網通確認) */
export function findOverlaps(segments: SegmentDef[]): SegmentOverlap[] {
  const rules = segments.flatMap((s) => s.cidrs.map((cidr) => ({ id: s.id, cidr, ...parseCidr(cidr)! })));
  const out: SegmentOverlap[] = [];
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const x = rules[i]!;
      const y = rules[j]!;
      if (x.id === y.id) continue;
      const m = (x.mask & y.mask) >>> 0;
      if (((x.base & m) >>> 0) === ((y.base & m) >>> 0)) out.push({ a: { id: x.id, cidr: x.cidr }, b: { id: y.id, cidr: y.cidr } });
      if (out.length >= 200) return out;
    }
  return out;
}

// ---------- IP 工具(純函式) ----------

/** IPv4 → 32 位元無號整數;不是 IPv4 回 null */
export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const p = Number(m[i]);
    if (p > 255) return null;
    n = n * 256 + p;
  }
  return n;
}

export function parseCidr(c: string): { base: number; mask: number } | null {
  const [ip, bitsRaw] = c.split('/');
  const base = ipv4ToInt(ip ?? '');
  const bits = bitsRaw === undefined ? 32 : /^\d{1,2}$/.test(bitsRaw) ? Number(bitsRaw) : NaN;
  if (base === null || !(bits >= 0 && bits <= 32)) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16'].map((c) => parseCidr(c)!);

/** 內部位址:私有 IPv4 / IPv6 ULA、link-local、loopback */
export function isPrivateIp(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n !== null) return PRIVATE_V4.some((r) => ((n & r.mask) >>> 0) === r.base);
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
}

/** 網段對照:最長前綴優先;沒有對到回 null */
export function createSegmentMatcher(segments: SegmentDef[]) {
  const rules = segments
    .flatMap((s) => s.cidrs.map((c) => ({ id: s.id, ...parseCidr(c)! })))
    .sort((a, b) => b.mask - a.mask);
  const cache = new Map<string, string | null>();
  return (ip: string): string | null => {
    const hit = cache.get(ip);
    if (hit !== undefined) return hit;
    const n = ipv4ToInt(ip);
    const id = n === null ? null : (rules.find((r) => ((n & r.mask) >>> 0) === r.base)?.id ?? null);
    if (cache.size >= 20_000) cache.clear();
    cache.set(ip, id);
    return id;
  };
}

// ---------- 動作分類 ----------

/** TRAFFIC / THREAT 的 action:allow 以外的封鎖動作(deny、drop、reset-*、block-*、sinkhole) */
export function isDenyAction(a: unknown): boolean {
  return typeof a === 'string' && /^(deny|drop|reset|block|sinkhole)/.test(a);
}

// ---------- 單筆 log 的方向判斷(SSE 衍生欄位也用) ----------

export interface Classified {
  /** 外部那一端的 IP(兩端都是內部為 null) */
  externalIp: string | null;
  /** 內部那一端的 IP(兩端都是外部為 null) */
  internalIp: string | null;
  country: string | null;
  /** 國家英文名(GeoIP) */
  countryName: string | null;
  /** 連入(來源是外部);Top 攻擊 IP 只計連入 */
  inbound: boolean;
  segment: string;
}

export type Classifier = (d: Record<string, unknown>) => Classified;

export function createClassifier(geo: GeoIp, matchSegment: (ip: string) => string | null): Classifier {
  return (d) => {
    // 只接受合法 IP(偽造的 log 欄位不進統計鍵)
    const src = typeof d.src === 'string' && isIP(d.src) ? d.src : '';
    const dst = typeof d.dst === 'string' && isIP(d.dst) ? d.dst : '';
    const srcIn = !!src && isPrivateIp(src);
    const dstIn = !!dst && isPrivateIp(dst);
    // 外部:優先來源(連入),來源是內部時取目的(連出的對象)
    const externalIp = src && !srcIn ? src : dst && !dstIn ? dst : null;
    // 內部:優先目的(被連的網段),目的是外部時取來源
    const internalIp = dst && dstIn ? dst : src && srcIn ? src : null;
    const g = externalIp ? geo.lookup(externalIp) : null;
    return {
      externalIp,
      internalIp,
      country: g?.code ?? null,
      countryName: g?.name ?? null,
      inbound: !!src && !srcIn,
      segment: (internalIp && matchSegment(internalIp)) || UNMATCHED_SEGMENT,
    };
  };
}

// ---------- WR-1 聚合(純函式) ----------

export interface TopItem {
  key: string;
  count: number;
}

export interface WarroomSource {
  id: string;
  kind: 'country' | 'ip' | 'other';
  label: string;
  /** 國家代碼(kind country);ip 為所屬國家;other 為 null */
  country: string | null;
  conn: number;
  deny: number;
  threat: number;
  topDst: TopItem[];
  topApp: TopItem[];
}

export interface WarroomSegment {
  id: string;
  kind: SegmentKind | 'other';
  label: string;
  icon: string;
  conn: number;
  bytes: number;
  threat: number;
}

export interface WarroomLink {
  source: string;
  segment: string;
  /** 每秒速率 */
  conn: number;
  allow: number;
  deny: number;
  threat: number;
}

export interface AggregateOptions {
  /** 國家前幾名(其餘併入 other) */
  topCountries: number;
  /** Top 攻擊 IP 最多幾個 */
  topIps: number;
  /** Top 攻擊 IP 的阻擋比例門檻 */
  ipDenyRatio: number;
  /** Top 攻擊 IP 至少幾次阻擋(樣本太少不算) */
  ipMinDeny: number;
}

export const DEFAULT_AGG: AggregateOptions = { topCountries: 8, topIps: 3, ipDenyRatio: 0.5, ipMinDeny: 10 };

interface Acc {
  conn: number;
  deny: number;
  threat: number;
  bytes: number;
  dst: Map<string, number>;
  app: Map<string, number>;
}
const newAcc = (): Acc => ({ conn: 0, deny: 0, threat: 0, bytes: 0, dst: new Map(), app: new Map() });
const inc = (m: Map<string, number>, k: unknown, by = 1) => {
  if (typeof k === 'string' && k) m.set(k, (m.get(k) ?? 0) + by);
};
const topOf = (m: Map<string, number>, n: number, scale: number): TopItem[] =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count: Math.round(count * scale) }));
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * TRAFFIC 與 THREAT 明細 → sources / segments / links。
 * windowSec:期間秒數;scale / threatScale:抽樣放大倍數(= 期間秒數 / 實際涵蓋秒數,完整讀到期間開頭為 1)。
 * 次數 = 樣本 × scale;每秒速率 = 次數 / windowSec。
 */
export function aggregateWarroom(
  traffic: Record<string, unknown>[],
  threats: Record<string, unknown>[],
  classify: Classifier,
  cfg: WarroomConfig,
  windowSec: number,
  opts: AggregateOptions = DEFAULT_AGG,
  scale = 1,
  threatScale = 1,
) {
  const names = new Map<string, string>();
  const countryName = (code: string) => names.get(code) ?? code;
  const byCountry = new Map<string, Acc>();
  const byIp = new Map<string, Acc & { country: string | null }>();
  const bySeg = new Map<string, Acc>();
  // 原始配對:來源先以「國家 / lan / 未知」記,最後依 Top IP 拆出
  type Pair = { conn: number; allow: number; deny: number; threat: number };
  const pairs = new Map<string, Pair>(); // key: `${ipOrNull}|${countryKey}|${segment}`
  const LAN = 'lan';
  const UNKNOWN = '??';

  const touch = (d: Record<string, unknown>, isThreat: boolean) => {
    const c = classify(d);
    if (c.country && c.countryName) names.set(c.country, c.countryName);
    const countryKey = c.externalIp ? (c.country ?? UNKNOWN) : LAN;
    const country = byCountry.get(countryKey) ?? byCountry.set(countryKey, newAcc()).get(countryKey)!;
    const seg = bySeg.get(c.segment) ?? bySeg.set(c.segment, newAcc()).get(c.segment)!;
    const ipAcc = c.externalIp && c.inbound ? (byIp.get(c.externalIp) ?? byIp.set(c.externalIp, { ...newAcc(), country: c.country }).get(c.externalIp)!) : null;
    const pk = JSON.stringify([c.inbound ? (c.externalIp ?? '') : '', countryKey, c.segment]);
    const pair = pairs.get(pk) ?? pairs.set(pk, { conn: 0, allow: 0, deny: 0, threat: 0 }).get(pk)!;
    if (isThreat) {
      country.threat++;
      seg.threat++;
      if (ipAcc) ipAcc.threat++;
      pair.threat++;
      return;
    }
    const deny = isDenyAction(d.action);
    const bytes = typeof d.bytes === 'number' ? d.bytes : 0;
    for (const a of [country, seg, ipAcc]) {
      if (!a) continue;
      a.conn++;
      if (deny) a.deny++;
      a.bytes += bytes;
      inc(a.dst, c.internalIp);
      inc(a.app, d.app);
    }
    pair.conn++;
    if (deny) pair.deny++;
    else pair.allow++;
  };
  for (const d of traffic) touch(d, false);
  for (const d of threats) touch(d, true);

  // Top 攻擊 IP:阻擋比例 ≥ 門檻且阻擋次數 ≥ 下限,依阻擋次數排序
  const attackIps = [...byIp.entries()]
    .filter(([, a]) => a.deny * scale >= opts.ipMinDeny && a.deny / Math.max(1, a.conn) >= opts.ipDenyRatio)
    .sort((a, b) => b[1].deny - a[1].deny || a[0].localeCompare(b[0]))
    .slice(0, opts.topIps);
  const ipSet = new Set(attackIps.map(([ip]) => ip));
  // 從國家扣掉拆出的 IP
  const sub = (from: Acc, a: Acc) => {
    from.conn -= a.conn;
    from.deny -= a.deny;
    from.threat -= a.threat;
    from.bytes -= a.bytes;
    for (const [k, v] of a.dst) from.dst.set(k, (from.dst.get(k) ?? 0) - v);
    for (const [k, v] of a.app) from.app.set(k, (from.app.get(k) ?? 0) - v);
  };
  for (const [ip, a] of attackIps) sub(byCountry.get(a.country ?? UNKNOWN)!, byIp.get(ip)!);

  const countries = [...byCountry.entries()].filter(([k, a]) => k !== LAN && k !== UNKNOWN && a.conn + a.threat > 0).sort((a, b) => b[1].conn + b[1].threat - (a[1].conn + a[1].threat) || a[0].localeCompare(b[0]));
  const shownCountries = new Set(countries.slice(0, opts.topCountries).map(([k]) => k));
  const sourceIdOf = (ip: string, countryKey: string) =>
    ipSet.has(ip) ? `ip:${ip}` : countryKey === LAN ? 'lan' : shownCountries.has(countryKey) ? `cc:${countryKey}` : 'other';

  const S = (n: number) => Math.round(n * scale);
  const T = (n: number) => Math.round(n * threatScale);
  const src = (id: string, kind: WarroomSource['kind'], label: string, country: string | null, a: Acc): WarroomSource => ({
    id,
    kind,
    label,
    country,
    conn: S(a.conn),
    deny: S(a.deny),
    threat: T(a.threat),
    topDst: topOf(a.dst, 3, scale).filter((t) => t.count > 0),
    topApp: topOf(a.app, 3, scale).filter((t) => t.count > 0),
  });
  const sources: WarroomSource[] = [];
  for (const [k] of countries.slice(0, opts.topCountries)) sources.push(src(`cc:${k}`, 'country', countryName(k), k, byCountry.get(k)!));
  for (const [ip, a] of attackIps) sources.push(src(`ip:${ip}`, 'ip', ip, a.country, a));
  const other = newAcc();
  for (const [k, a] of byCountry) {
    if (k === LAN || shownCountries.has(k)) continue;
    other.conn += a.conn;
    other.deny += a.deny;
    other.threat += a.threat;
    for (const [x, v] of a.dst) inc(other.dst, x, v);
    for (const [x, v] of a.app) inc(other.app, x, v);
  }
  if (other.conn + other.threat > 0) sources.push(src('other', 'other', '其他', null, other));
  const lan = byCountry.get(LAN);
  if (lan && lan.conn + lan.threat > 0) sources.push(src('lan', 'other', '內部互連', null, lan));

  const segments: WarroomSegment[] = cfg.segments.map((s) => {
    const a = bySeg.get(s.id) ?? newAcc();
    return { id: s.id, kind: s.kind, label: s.label, icon: s.icon, conn: S(a.conn), bytes: S(a.bytes), threat: T(a.threat) };
  });
  const um = bySeg.get(UNMATCHED_SEGMENT);
  if (um && um.conn + um.threat > 0)
    segments.push({ id: UNMATCHED_SEGMENT, kind: 'other', label: '未分類', icon: 'network', conn: S(um.conn), bytes: S(um.bytes), threat: T(um.threat) });

  const linkMap = new Map<string, WarroomLink>();
  const sec = Math.max(1, windowSec);
  for (const [pk, p] of pairs) {
    const [ip, countryKey, segment] = JSON.parse(pk) as [string, string, string];
    const source = sourceIdOf(ip, countryKey);
    const key = `${source}|${segment}`;
    const l = linkMap.get(key) ?? linkMap.set(key, { source, segment, conn: 0, allow: 0, deny: 0, threat: 0 }).get(key)!;
    l.conn += p.conn;
    l.allow += p.allow;
    l.deny += p.deny;
    l.threat += p.threat;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const links = [...linkMap.values()]
    .filter((l) => l.conn > 0 || l.threat > 0)
    .map((l) => ({
      ...l,
      conn: r3((l.conn * scale) / sec),
      allow: r3((l.allow * scale) / sec),
      deny: r3((l.deny * scale) / sec),
      threat: r3((l.threat * threatScale) / sec),
    }))
    .sort((a, b) => b.conn - a.conn || a.source.localeCompare(b.source) || a.segment.localeCompare(b.segment));

  return { sources, segments, links };
}

// ---------- 網段設定預覽(SG-1,純函式) ----------

/** 預覽:未分類內部 IP 列出幾個(SEGMENT-SETTINGS-PLAN §2.4) */
export const PREVIEW_TOP = 20;
export const PREVIEW_MINUTES = 5;

export interface SegmentPreview {
  segments: { id: string; label: string; conn: number }[];
  unmatched: { conn: number; top: { ip: string; count: number }[] };
}

/**
 * 用(未儲存的)設定把 TRAFFIC 明細的內部端 IP 分到網段:各網段連線數、未分類內部 IP Top N。
 * 內部端判斷同 createClassifier(目的是內部取目的,否則取來源);兩端都是外部的不算。scale:抽樣放大倍數。
 */
export function previewSegments(traffic: Record<string, unknown>[], cfg: WarroomConfig, scale = 1, topN = PREVIEW_TOP): SegmentPreview {
  const match = createSegmentMatcher(cfg.segments);
  const bySeg = new Map<string, number>();
  const um = new Map<string, number>();
  let umConn = 0;
  for (const d of traffic) {
    const src = typeof d.src === 'string' && isIP(d.src) ? d.src : '';
    const dst = typeof d.dst === 'string' && isIP(d.dst) ? d.dst : '';
    const ip = dst && isPrivateIp(dst) ? dst : src && isPrivateIp(src) ? src : '';
    if (!ip) continue;
    const id = match(ip);
    if (id) bySeg.set(id, (bySeg.get(id) ?? 0) + 1);
    else {
      umConn++;
      um.set(ip, (um.get(ip) ?? 0) + 1);
    }
  }
  const S = (n: number) => Math.round(n * scale);
  return {
    segments: cfg.segments.map((s) => ({ id: s.id, label: s.label, conn: S(bySeg.get(s.id) ?? 0) })),
    unmatched: { conn: S(umConn), top: topOf(um, topN, scale).map((t) => ({ ip: t.key, count: t.count })) },
  };
}

// ---------- 服務 ----------

/** 每次最多讀幾筆 TRAFFIC 明細(約 120 筆/秒時 ≈ 2.8 分鐘;超過以涵蓋秒數換算) */
export const TRAFFIC_SCAN_MAX = 20_000;
export const THREAT_SCAN_MAX = 5_000;
const SCAN_CHUNK = 2_000;
export const WARROOM_CACHE_MS = 3_000;
/** 設定檔修改時間檢查間隔 */
export const CONFIG_CHECK_MS = 5_000;
export const RISK_CACHE_MS = 60_000;
export const WARROOM_MINUTES = [1, 5, 15] as const;
export const RISK_MINUTES = [15, 60] as const;
const CRITICAL = 'critical';

type Log = { warn: (obj: object, msg: string) => void };

const isRedisError = (err: unknown) => err instanceof RedisUnavailableError || err instanceof RedisReplyError;
const REDIS_DOWN = '無法讀取即時資料(Redis):資料停止更新';

/** 由新到舊讀 sinceMs 之後的明細,最多 max 筆;reachedStart = 已讀到期間開頭(或 Stream 讀完) */
async function scanWindow(redis: PaLiveRedis, type: 'traffic' | 'threat', sinceMs: number, max: number) {
  const out: StreamEntry[] = [];
  let before: string | undefined;
  while (out.length < max) {
    const chunk = await redis.recentLogs(type, Math.min(SCAN_CHUNK, max - out.length), before);
    if (!chunk.length) return { entries: out, reachedStart: true };
    for (const e of chunk) {
      if (e.ms < sinceMs) return { entries: out, reachedStart: true };
      out.push(e);
    }
    before = chunk[chunk.length - 1]!.id;
    if (chunk.length < SCAN_CHUNK && out.length < max) return { entries: out, reachedStart: true };
  }
  return { entries: out, reachedStart: false };
}

/** 結果快取:同一個 key 在 ttl 內共用(多人同時開戰情室不重算),計算中的請求共用同一個 Promise */
function memo<T>(ttlMs: number, now: () => number) {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fn();
    cache.set(key, { at: now(), value });
    // 失敗與 partial(Redis 不可用)不快取:恢復後下一次就重算
    value.then(
      (v) => {
        if ((v as { partial?: unknown })?.partial === true && cache.get(key)?.value === value) cache.delete(key);
      },
      () => cache.delete(key),
    );
    return value;
  };
}

export function createWarroomService(
  redis: PaLiveRedis | null,
  deps: { geo: GeoIp; store: WarroomStore; now?: () => number; log?: Log; agg?: Partial<AggregateOptions> },
) {
  const now = deps.now ?? Date.now;
  const opts = { ...DEFAULT_AGG, ...deps.agg };

  // 設定檔依修改時間快取;格式錯誤時回 400 等級的錯誤不合適(是部署問題):記 warn 並改用範例,畫面標示 segmentsSource "invalid"
  let cfgCache: { mtime: number | null; cfg: WarroomConfig; source: 'file' | 'example' | 'invalid' } | null = null;
  // 修改時間最多每 CONFIG_CHECK_MS 檢查一次:SSE 每筆 log 都會呼叫(statSync 不可每筆執行)
  let checkedAt = -Infinity;
  const config = () => {
    if (cfgCache && now() - checkedAt < CONFIG_CHECK_MS) return cfgCache;
    checkedAt = now();
    const mtime = deps.store.mtime();
    if (cfgCache && cfgCache.mtime === mtime) return cfgCache;
    let next: NonNullable<typeof cfgCache>;
    if (mtime === null) next = { mtime, cfg: EXAMPLE_CONFIG, source: 'example' };
    else
      try {
        next = { mtime, cfg: parseWarroomConfig(deps.store.readConfig()), source: 'file' };
      } catch (err) {
        deps.log?.warn({ reason: (err as Error).message }, '戰情室設定檔格式錯誤,改用範例網段');
        next = { mtime, cfg: EXAMPLE_CONFIG, source: 'invalid' };
      }
    cfgCache = next;
    classifierCache = createClassifier(deps.geo, createSegmentMatcher(next.cfg.segments));
    return cfgCache;
  };
  let classifierCache: Classifier | null = null;
  /** 網段設定頁存檔後呼叫:下一次請求就重讀設定檔(不必等 CONFIG_CHECK_MS) */
  const invalidateConfig = () => {
    checkedAt = -Infinity;
    // 同一個 mtime(檔案系統精度不足)也要重讀
    cfgCache = null;
  };
  const classifier = (): Classifier => {
    config();
    return classifierCache!;
  };
  const geoInfo = () => ({ available: deps.geo.available, version: deps.geo.version, attribution: GEOIP_ATTRIBUTION });

  const warroomMemo = memo<Record<string, unknown>>(WARROOM_CACHE_MS, now);
  const riskMemo = memo<Record<string, unknown>>(RISK_CACHE_MS, now);

  /** WR-1 */
  function warroom(minutes: number) {
    return warroomMemo(String(minutes), async () => {
      const c = config();
      const base = {
        generatedAt: new Date(now()).toISOString(),
        minutes,
        segmentsSource: c.source,
        gauge: c.cfg.gauge,
        geo: geoInfo(),
      };
      const empty = { ...base, partial: true, sources: [], segments: [], links: [], kpis: { denyPerMin: null, threat5m: null }, sample: null };
      if (!redis) return { ...empty, message: '即時監控未設定(REDIS_URL)' };
      try {
        const t = now();
        const since = t - minutes * 60_000;
        const [tr, th, threatAggs] = await Promise.all([
          scanWindow(redis, 'traffic', since, TRAFFIC_SCAN_MAX),
          scanWindow(redis, 'threat', since, THREAT_SCAN_MAX),
          Promise.all(bucketsOf(5, t).map((b) => redis.minuteAgg('threat', b))),
        ]);
        const windowSec = minutes * 60;
        const covered = (r: { entries: StreamEntry[]; reachedStart: boolean }) =>
          r.reachedStart ? windowSec : Math.max(1, Math.min(windowSec, (t - r.entries[r.entries.length - 1]!.ms) / 1000));
        const trSec = covered(tr);
        const thSec = covered(th);
        const agg = aggregateWarroom(
          tr.entries.map((e) => e.data),
          th.entries.map((e) => e.data),
          classifier(),
          c.cfg,
          windowSec,
          opts,
          windowSec / trSec,
          windowSec / thSec,
        );
        // 阻擋/分:最近 60 秒(涵蓋不到 60 秒時按比例換算)
        const lastMinSec = Math.min(60, trSec);
        const denyLastMin = tr.entries.filter((e) => e.ms >= t - lastMinSec * 1000 && isDenyAction(e.data.action)).length;
        const threat5m = threatAggs.reduce((s, h) => s + (Number(h.count) || 0), 0);
        return {
          ...base,
          partial: false,
          ...agg,
          kpis: { denyPerMin: Math.round((denyLastMin * 60) / Math.max(1, lastMinSec)), threat5m },
          sample: { traffic: tr.entries.length, trafficSec: Math.round(trSec), threat: th.entries.length, threatSec: Math.round(thSec), complete: tr.reachedStart && th.reachedStart },
        };
      } catch (err) {
        if (!isRedisError(err)) throw err;
        deps.log?.warn({ code: (err as Error).name }, '戰情室:無法讀取 netops-redis');
        return { ...empty, message: REDIS_DOWN };
      }
    });
  }

  /** SG-1 網段設定預覽:近 PREVIEW_MINUTES 分鐘 TRAFFIC 明細依未儲存的設定分類(只讀 Redis,不寫入、不快取) */
  async function previewConfig(cfg: WarroomConfig) {
    const base = { generatedAt: new Date(now()).toISOString(), minutes: PREVIEW_MINUTES };
    const empty = { ...base, partial: true, segments: cfg.segments.map((s) => ({ id: s.id, label: s.label, conn: null })), unmatched: { conn: null, top: [] }, sample: null };
    if (!redis) return { ...empty, message: '即時監控未設定(REDIS_URL)' };
    try {
      const t = now();
      const windowSec = PREVIEW_MINUTES * 60;
      const tr = await scanWindow(redis, 'traffic', t - windowSec * 1000, TRAFFIC_SCAN_MAX);
      const sec = tr.reachedStart ? windowSec : Math.max(1, Math.min(windowSec, (t - tr.entries[tr.entries.length - 1]!.ms) / 1000));
      return {
        ...base,
        partial: false,
        ...previewSegments(
          tr.entries.map((e) => e.data),
          cfg,
          windowSec / sec,
        ),
        sample: { traffic: tr.entries.length, trafficSec: Math.round(sec), complete: tr.reachedStart },
      };
    } catch (err) {
      if (!isRedisError(err)) throw err;
      deps.log?.warn({ code: (err as Error).name }, '網段設定預覽:無法讀取 netops-redis');
      return { ...empty, message: REDIS_DOWN };
    }
  }

  /** WR-2 */
  function risk(minutes: number) {
    return riskMemo(String(minutes), async () => {
      const base = { generatedAt: new Date(now()).toISOString(), minutes };
      const empty = { ...base, partial: true, threats: null, denies: null, attackSources: null, critical: null, topThreats: [], topSources: [] };
      if (!redis) return { ...empty, message: '即時監控未設定(REDIS_URL)' };
      try {
        const t = now();
        const buckets = bucketsOf(minutes, t);
        const [threatAggs, trafficAggs, nameTops, srcTops, sample] = await Promise.all([
          Promise.all(buckets.map((b) => redis.minuteAgg('threat', b))),
          Promise.all(buckets.map((b) => redis.minuteAgg('traffic', b))),
          Promise.all(buckets.map((b) => redis.minuteTop('threat', 'name', b, 200))),
          Promise.all(buckets.map((b) => redis.minuteTop('threat', 'src', b, 200))),
          scanWindow(redis, 'threat', t - minutes * 60_000, THREAT_SCAN_MAX),
        ]);
        const sumField = (aggs: Record<string, string>[], pred: (f: string) => boolean) =>
          aggs.reduce((s, h) => s + Object.entries(h).reduce((x, [f, v]) => (pred(f) ? x + (Number(v) || 0) : x), 0), 0);
        const threats = sumField(threatAggs, (f) => f === 'count');
        const critical = sumField(threatAggs, (f) => f === `severity:${CRITICAL}`);
        const denies = sumField(trafficAggs, (f) => f.startsWith('action:') && isDenyAction(f.slice(7)));
        const merge = (lists: [string, number][][]) => {
          const m = new Map<string, number>();
          for (const l of lists) for (const [k, v] of l) m.set(k, (m.get(k) ?? 0) + v);
          return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        };
        // 嚴重度與阻擋比例由明細抽樣補上(每分鐘統計沒有 name × severity、src × action)
        const sev = new Map<string, string>();
        const RANK = new Map<string, number>([['critical', 5], ['high', 4], ['medium', 3], ['low', 2], ['informational', 1]]);
        const bySrc = new Map<string, { n: number; deny: number }>();
        for (const e of sample.entries) {
          const name = typeof e.data.name === 'string' ? e.data.name : '';
          const s = typeof e.data.severity === 'string' ? e.data.severity : '';
          if (name && (RANK.get(s) ?? 0) > (RANK.get(sev.get(name) ?? '') ?? 0)) sev.set(name, s);
          if (typeof e.data.src === 'string') {
            const a = bySrc.get(e.data.src) ?? bySrc.set(e.data.src, { n: 0, deny: 0 }).get(e.data.src)!;
            a.n++;
            if (isDenyAction(e.data.action)) a.deny++;
          }
        }
        const srcAll = merge(srcTops);
        const topSources = srcAll.slice(0, 10).map(([key, count]) => {
          const g = isPrivateIp(key) ? null : deps.geo.lookup(key);
          const a = bySrc.get(key);
          return { key, label: g ? g.name : isPrivateIp(key) ? '內部' : '未知', country: g?.code ?? null, count, denyRatio: a ? round2(a.deny / a.n) : null };
        });
        return {
          ...base,
          partial: false,
          threats,
          denies,
          attackSources: srcAll.length,
          // 每分鐘排行只留前 200 名:任一分鐘滿 200 名時為下限(畫面標示 ≥)
          attackSourcesLowerBound: srcTops.some((l) => l.length >= 200),
          critical,
          topThreats: merge(nameTops)
            .slice(0, 10)
            .map(([name, count]) => ({ name, severity: sev.get(name) ?? null, count })),
          topSources,
          // attackSources 為合併每分鐘前 200 名的不重複數(下限);嚴重度與阻擋比例來自威脅明細樣本
          sample: { threat: sample.entries.length, complete: sample.reachedStart },
        };
      } catch (err) {
        if (!isRedisError(err)) throw err;
        deps.log?.warn({ code: (err as Error).name }, '高風險統計:無法讀取 netops-redis');
        return { ...empty, message: REDIS_DOWN };
      }
    });
  }

  /** SSE logs 事件的衍生欄位(D28:不改收集器欄位,只在送出前加 country、segment) */
  function enrich<T extends Record<string, unknown>>(item: T): T & { country: string | null; segment: string } {
    const c = classifier()(item);
    return { ...item, country: c.country, segment: c.segment };
  }

  return { warroom, risk, enrich, config, invalidateConfig, previewConfig };
}

export type WarroomService = ReturnType<typeof createWarroomService>;
