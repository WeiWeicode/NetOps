/**
 * 網段設定的前端驗證(SG-2;規則同後端 checkWarroomConfig,畫面即時標出,後端仍會再驗一次)。純函式,不依賴 Vue。
 *   - CIDR:IPv4/0–32(沒有 /n 視為 /32);id:小寫英數與 -、1–40 字、不可為 unmatched、不可重複
 *   - 重疊:不同網段之間的 CIDR 重疊允許(對照時最精確的網段優先),只回報讓畫面標出
 */
import { SEGMENT_LIMITS, type FieldError, type SegmentConfig, type SegmentDef, type SegmentOverlap } from '@/api/segments';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ICON_RE = /^[a-z0-9-]{1,30}$/;
export const UNMATCHED_SEGMENT = 'unmatched';

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

export function parseCidr(c: string): { base: number; mask: number; bits: number } | null {
  const [ip, bitsRaw, extra] = c.trim().split('/');
  if (extra !== undefined) return null;
  const base = ipv4ToInt(ip ?? '');
  const bits = bitsRaw === undefined ? 32 : /^\d{1,2}$/.test(bitsRaw) ? Number(bitsRaw) : NaN;
  if (base === null || !(bits >= 0 && bits <= 32)) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, bits };
}

export const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** CIDR 正規化(主機位元改成網路位址):10.1.2.3/24 → 10.1.2.0/24;不合法回 null */
export function normalizeCidr(c: string): string | null {
  const p = parseCidr(c);
  return p ? `${intToIp(p.base)}/${p.bits}` : null;
}

/** IP 所在的 /24(搭配 A「依此 IP 建 /24 網段」) */
export function slash24Of(ip: string): string | null {
  const n = ipv4ToInt(ip);
  return n === null ? null : `${intToIp((n & 0xffffff00) >>> 0)}/24`;
}

/** 全部欄位錯誤(field 路徑與後端相同:segments[i].cidrs[k]) */
export function validateConfig(cfg: SegmentConfig): FieldError[] {
  const errors: FieldError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!pos(cfg.gauge?.throughputMaxBps)) err('gauge.throughputMaxBps', '吞吐量滿格值必須是正數');
  if (!pos(cfg.gauge?.sessionMax)) err('gauge.sessionMax', '連線數滿格值必須是正數');
  if (cfg.segments.length > SEGMENT_LIMITS.segments) err('segments', `最多 ${SEGMENT_LIMITS.segments} 個網段`);
  const seen = new Map<string, number>();
  cfg.segments.forEach((s, i) => {
    const at = `segments[${i}]`;
    if (!ID_RE.test(s.id) || s.id === UNMATCHED_SEGMENT) err(`${at}.id`, `代碼只能用小寫英數與 -(1–40 字),不可為 ${UNMATCHED_SEGMENT}`);
    else if (seen.has(s.id)) err(`${at}.id`, `代碼重複(與第 ${seen.get(s.id)! + 1} 個相同)`);
    else seen.set(s.id, i);
    if (!s.label.trim() || s.label.length > SEGMENT_LIMITS.label) err(`${at}.label`, `名稱必須是 1–${SEGMENT_LIMITS.label} 字`);
    if (s.kind !== 'vlan' && s.kind !== 'service') err(`${at}.kind`, '類型只能是 VLAN 或核心服務');
    if (!ICON_RE.test(s.icon)) err(`${at}.icon`, '圖示名稱格式錯誤');
    if (!s.cidrs.length || s.cidrs.length > SEGMENT_LIMITS.cidrs) err(`${at}.cidrs`, `CIDR 必須是 1–${SEGMENT_LIMITS.cidrs} 個`);
    s.cidrs.forEach((c, k) => {
      if (!parseCidr(c)) err(`${at}.cidrs[${k}]`, `CIDR 格式錯誤:${c.slice(0, 50)}`);
    });
  });
  return errors;
}

/** 不同網段之間重疊的 CIDR(不合法的 CIDR 略過) */
export function findOverlaps(segments: SegmentDef[]): SegmentOverlap[] {
  const rules = segments.flatMap((s) => s.cidrs.flatMap((cidr) => {
    const p = parseCidr(cidr);
    return p ? [{ id: s.id, cidr, ...p }] : [];
  }));
  const out: SegmentOverlap[] = [];
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const x = rules[i]!;
      const y = rules[j]!;
      if (x.id === y.id) continue;
      const m = (x.mask & y.mask) >>> 0;
      if (((x.base & m) >>> 0) === ((y.base & m) >>> 0)) out.push({ a: { id: x.id, cidr: x.cidr }, b: { id: y.id, cidr: y.cidr } });
    }
  return out;
}

/** 網段對照:最長前綴優先;沒有對到回 null(搭配 C:IP 對照表顯示所屬網段) */
export function createSegmentMatcher(segments: SegmentDef[]) {
  const rules = segments
    .flatMap((s) => s.cidrs.flatMap((c) => {
      const p = parseCidr(c);
      return p ? [{ id: s.id, label: s.label, ...p }] : [];
    }))
    .sort((a, b) => b.bits - a.bits);
  return (ipOrCidr: string): { id: string; label: string } | null => {
    const p = parseCidr(ipOrCidr);
    if (!p) return null;
    // 網段列:整個網段落在某條規則內才算(規則前綴不可比它長)
    const r = rules.find((x) => x.bits <= p.bits && ((p.base & x.mask) >>> 0) === x.base);
    return r ? { id: r.id, label: r.label } : null;
  };
}

/** 由名稱產生不重複的代碼(新增、匯入用);名稱沒有英數時用 seg-N */
export function suggestId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'seg';
  const ok = (id: string) => ID_RE.test(id) && id !== UNMATCHED_SEGMENT && !used.has(id);
  if (base !== 'seg' && ok(base)) return base;
  for (let n = 1; ; n++) if (ok(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * 匯入 JSON(與 warroom.json 同格式;匯出檔多出的 version 等欄位略過)。
 * 回傳正規化後的設定(只保留已知欄位、icon 補預設)或錯誤訊息;欄位內容的驗證交給 validateConfig(匯入後畫面標出)。
 */
export function parseImport(text: string): { cfg: SegmentConfig } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: '不是合法的 JSON 檔' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '檔案內容必須是 JSON 物件' };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.segments)) return { error: '缺少 segments 陣列' };
  if (o.segments.length > SEGMENT_LIMITS.segments) return { error: `最多 ${SEGMENT_LIMITS.segments} 個網段` };
  const g = (o.gauge && typeof o.gauge === 'object' ? o.gauge : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const segments = o.segments.map((s): SegmentDef => {
    const e = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const kind = e.kind === 'service' ? 'service' : e.kind === 'vlan' ? 'vlan' : (str(e.kind) as SegmentDef['kind']);
    return {
      id: str(e.id),
      label: str(e.label),
      kind,
      icon: typeof e.icon === 'string' ? e.icon : kind === 'service' ? 'server' : 'network',
      cidrs: Array.isArray(e.cidrs) ? e.cidrs.map((c) => String(c)) : [],
    };
  });
  return {
    cfg: {
      gauge: {
        throughputMaxBps: typeof g.throughputMaxBps === 'number' ? g.throughputMaxBps : DEFAULT_GAUGE.throughputMaxBps,
        sessionMax: typeof g.sessionMax === 'number' ? g.sessionMax : DEFAULT_GAUGE.sessionMax,
      },
      segments,
    },
  };
}

export const DEFAULT_GAUGE = { throughputMaxBps: 1_000_000_000, sessionMax: 64_000 } as const;

/** 匯出內容(同 warroom.json 格式,可在另一區匯入) */
export function exportJson(cfg: SegmentConfig): string {
  return `${JSON.stringify({ gauge: cfg.gauge, segments: cfg.segments }, null, 2)}\n`;
}
