/**
 * IP 對照表的核心(IMPL-PLAN AC3,ARCHITECTURE D45;純函式,不依賴 Fastify 與 store):
 *   - 一筆 = IPv4 或 IPv4 CIDR → 使用者姓名、部門、設備名稱、設備類型、備註;以最新為準,不記歷史
 *   - 網段重疊時範圍最小的優先(/32 > /24 > /16 …)
 *   - 匯入檔欄位依序:IP或網段、使用者姓名、部門、設備名稱、設備類型、備註;第一列欄名,範例列(TEMPLATE_SAMPLES)略過
 * 姓名、部門是個資:這裡的錯誤訊息只帶列號與 IP,不帶姓名與部門(服務日誌、稽核內容不可出現,AGENT.md、IMPL-PLAN AC 共通規則)。
 */

export const DEVICE_TYPES = ['筆電', '桌機', '伺服器', '印表機', '網路設備', '其他'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number] | '';

/** 匯入 / 匯出 / 範本的欄名(順序固定) */
export const COLUMNS = ['IP或網段', '使用者姓名', '部門', '設備名稱', '設備類型', '備註'] as const;

/** 範本的 2 列填寫範例(文件用位址 RFC 5737,匯入時整列相同就略過) */
export const TEMPLATE_SAMPLES: string[][] = [
  ['192.0.2.10', '王小明(範例)', '資訊處', 'IT-NB-001', '筆電', '範例列,匯入時會略過'],
  ['198.51.100.0/24', '', '機房', '伺服器網段', '伺服器', '範例列,匯入時會略過'],
];

/** 欄位長度上限 */
export const LIMITS = { name: 50, department: 50, device: 100, note: 200 } as const;
/** 對照表筆數上限(記憶體與回應大小;超過請分網段) */
export const MAX_ENTRIES = 20_000;

export interface IpNameInput {
  ip: string;
  name?: string;
  department?: string;
  device?: string;
  deviceType?: string;
  note?: string;
}

export interface IpNameEntry {
  id: string;
  /** 正規化後的 IPv4 或 CIDR(網路位址;/32 寫成單一 IP) */
  ip: string;
  name: string;
  department: string;
  device: string;
  deviceType: DeviceType;
  note: string;
  updatedAt: string;
  updatedBy: string;
}

/** PA 回應附帶的名稱(不含備註與修改人) */
export interface IpNameLabel {
  name: string;
  department: string;
  device: string;
  deviceType: DeviceType;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const ipToInt = (ip: string): number => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
export const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

export interface ParsedIp {
  /** 正規化文字 */
  key: string;
  base: number;
  bits: number;
}

/**
 * IP / CIDR 正規化:去空白、全形斜線;主機位元不為 0 時改成網路位址(10.1.2.3/24 → 10.1.2.0/24);/32 寫成單一 IP。
 * 不合法回 null(第一版只支援 IPv4,IPv6 回 null)
 */
export function parseIp(raw: string): ParsedIp | null {
  const s = String(raw ?? '').trim().replace(/／/g, '/');
  const [addr = '', bitsText, extra] = s.split('/');
  if (extra !== undefined || !IPV4.test(addr)) return null;
  // 前導 0(010.1.1.1)有八進位歧義,不接受
  if (addr.split('.').some((p) => p.length > 1 && p.startsWith('0'))) return null;
  let bits = 32;
  if (bitsText !== undefined) {
    if (!/^\d{1,2}$/.test(bitsText)) return null;
    bits = Number(bitsText);
    if (bits > 32) return null;
  }
  const base = (ipToInt(addr) & maskOf(bits)) >>> 0;
  return { key: bits === 32 ? intToIp(base) : `${intToIp(base)}/${bits}`, base, bits };
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export type FieldError = { field: string; message: string };

/** 單筆驗證與整理(畫面單筆編輯、匯入共用);錯誤訊息不含姓名與部門 */
export function normalizeInput(input: IpNameInput): { value?: Omit<IpNameEntry, 'id' | 'updatedAt' | 'updatedBy'>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const p = parseIp(input.ip);
  if (!p) errors.push({ field: 'ip', message: '不是合法的 IPv4 或網段(例 10.10.1.5、10.10.1.0/24)' });
  const deviceType = clean(input.deviceType, 10);
  if (deviceType && !(DEVICE_TYPES as readonly string[]).includes(deviceType)) errors.push({ field: 'deviceType', message: `設備類型只能是 ${DEVICE_TYPES.join('、')}` });
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = String((input as unknown as Record<string, unknown>)[k] ?? '').trim();
    if (v.length > max) errors.push({ field: k, message: `最多 ${max} 字` });
  }
  const value = {
    ip: p?.key ?? '',
    name: clean(input.name, LIMITS.name),
    department: clean(input.department, LIMITS.department),
    device: clean(input.device, LIMITS.device),
    deviceType: deviceType as DeviceType,
    note: clean(input.note, LIMITS.note),
  };
  if (!errors.length && !value.name && !value.department && !value.device) errors.push({ field: 'name', message: '使用者姓名、部門、設備名稱至少填一項' });
  return errors.length ? { errors } : { value, errors };
}

/* ───────── 匯入檔 ───────── */

export interface ImportRowError {
  /** 檔案中的列號(第 1 列是欄名) */
  row: number;
  ip: string;
  message: string;
}

/** CSV 轉出時為防公式加的 ' 前綴,匯入時拿掉 */
const unquoteFormula = (s: string) => (/^'[=+\-@＝＋－＠\t\r]/.test(s) ? s.slice(1) : s);

/**
 * 匯入檔的列(含欄名列)→ 對照表輸入:第一列必須是欄名(前 2 欄名稱相符);空白列、範例列略過;
 * 同一 IP 出現多次以最後一列為準並列為錯誤提醒
 */
export function rowsToInputs(rows: string[][]): { inputs: (Omit<IpNameEntry, 'id' | 'updatedAt' | 'updatedBy'>)[]; errors: ImportRowError[]; skipped: number } {
  const errors: ImportRowError[] = [];
  const head = (rows[0] ?? []).map((c) => String(c ?? '').replace(/^﻿/, '').replace(/\s+/g, ''));
  if (head[0] !== COLUMNS[0] || head[1] !== COLUMNS[1]) {
    return { inputs: [], errors: [{ row: 1, ip: '', message: `第一列必須是欄名:${COLUMNS.join('、')}(請用頁面提供的範本)` }], skipped: 0 };
  }
  const byIp = new Map<string, { value: Omit<IpNameEntry, 'id' | 'updatedAt' | 'updatedBy'>; row: number }>();
  let skipped = 0;
  const samples = new Set(TEMPLATE_SAMPLES.map((r) => `${r[0]}\u0000${r[1]}`));
  for (let i = 1; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => unquoteFormula(String(c ?? '').trim()));
    if (!cells.some(Boolean)) continue;
    if (samples.has(`${cells[0]}\u0000${cells[1]}`)) {
      skipped++;
      continue;
    }
    const [ip = '', name, department, device, deviceType, note] = cells;
    const r = normalizeInput({ ip, name, department, device, deviceType, note });
    if (!r.value) {
      errors.push({ row: i + 1, ip: ip.slice(0, 64), message: r.errors.map((e) => e.message).join(';') });
      continue;
    }
    const prev = byIp.get(r.value.ip);
    if (prev) errors.push({ row: i + 1, ip: r.value.ip, message: `和第 ${prev.row} 列是同一個 IP / 網段,以這一列為準` });
    byIp.set(r.value.ip, { value: r.value, row: i + 1 });
  }
  return { inputs: [...byIp.values()].map((v) => v.value), errors, skipped };
}

export interface ImportDiff {
  added: IpNameEntry[];
  changed: { before: IpNameEntry; after: IpNameEntry }[];
  removed: IpNameEntry[];
  unchanged: number;
}

const SAME_KEYS = ['name', 'department', 'device', 'deviceType', 'note'] as const;

/** 匯入 = 整份取代:檔案沒有的 IP 視為刪除;內容相同的保留原 id 與修改紀錄 */
export function diffImport(
  current: IpNameEntry[],
  inputs: Omit<IpNameEntry, 'id' | 'updatedAt' | 'updatedBy'>[],
  stamp: { at: string; by: string; newId: () => string },
): { diff: ImportDiff; next: IpNameEntry[] } {
  const cur = new Map(current.map((e) => [e.ip, e]));
  const diff: ImportDiff = { added: [], changed: [], removed: [], unchanged: 0 };
  const next: IpNameEntry[] = [];
  const seen = new Set<string>();
  for (const v of inputs) {
    seen.add(v.ip);
    const old = cur.get(v.ip);
    if (!old) {
      const e = { ...v, id: stamp.newId(), updatedAt: stamp.at, updatedBy: stamp.by };
      diff.added.push(e);
      next.push(e);
    } else if (SAME_KEYS.every((k) => old[k] === v[k])) {
      diff.unchanged++;
      next.push(old);
    } else {
      const e = { ...old, ...v, updatedAt: stamp.at, updatedBy: stamp.by };
      diff.changed.push({ before: old, after: e });
      next.push(e);
    }
  }
  for (const e of current) if (!seen.has(e.ip)) diff.removed.push(e);
  return { diff, next };
}

/* ───────── 查名稱 ───────── */

export interface IpNameIndex {
  /** 查單一 IPv4(不是 IPv4 回 undefined);網段重疊時範圍最小的優先 */
  lookup(ip: string): IpNameEntry | undefined;
  /** 只回 ips 中查得到的(PA 回應的 names) */
  labels(ips: Iterable<string>): Record<string, IpNameLabel>;
  /**
   * 名稱 / 部門 / 設備名稱搜尋 → Log 明細的 IP 條件(AQ3:API 端換成 IP 範圍清單):
   *   符合的對照的範圍,扣掉包在裡面、更小範圍且名稱不符合的對照(範圍小的優先,結果才會和用 IP 查一致);相鄰範圍合併
   */
  match(keyword: string): NameMatch;
  size: number;
}

export interface NameMatch {
  /** IPv4 範圍 [起, 迄](含),已排序合併 */
  ranges: [string, string][];
  /** 符合的對照表筆數 */
  entries: number;
}

type Range = [number, number];
const rangeOf = (p: ParsedIp): Range => [p.base, p.base + 2 ** (32 - p.bits) - 1];

/** 區間減去多個區間 */
function subtract(r: Range, cuts: Range[]): Range[] {
  let out: Range[] = [r];
  for (const [a, b] of cuts) {
    const next: Range[] = [];
    for (const [x, y] of out) {
      if (b < x || a > y) next.push([x, y]);
      else {
        if (a > x) next.push([x, a - 1]);
        if (b < y) next.push([b + 1, y]);
      }
    }
    out = next;
  }
  return out;
}

/** 排序並合併重疊或相鄰的區間 */
function mergeRanges(rs: Range[]): Range[] {
  const sorted = rs.slice().sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export const labelOf = (e: IpNameEntry): IpNameLabel => ({ name: e.name, department: e.department, device: e.device, deviceType: e.deviceType });

export function buildIndex(entries: IpNameEntry[]): IpNameIndex {
  // 依前綴長度分組:長的(範圍小)先查
  const byBits = new Map<number, Map<number, IpNameEntry>>();
  const parsed: (ParsedIp & { e: IpNameEntry })[] = [];
  for (const e of entries) {
    const p = parseIp(e.ip);
    if (!p) continue;
    parsed.push({ ...p, e });
    let m = byBits.get(p.bits);
    if (!m) byBits.set(p.bits, (m = new Map()));
    m.set(p.base, e);
  }
  const bitsDesc = [...byBits.keys()].sort((a, b) => b - a);
  const lookup = (ip: string): IpNameEntry | undefined => {
    if (!IPV4.test(ip)) return undefined;
    const n = ipToInt(ip);
    for (const bits of bitsDesc) {
      const e = byBits.get(bits)!.get((n & maskOf(bits)) >>> 0);
      if (e) return e;
    }
    return undefined;
  };
  const contains = (outer: ParsedIp, inner: ParsedIp) => inner.bits > outer.bits && ((inner.base & maskOf(outer.bits)) >>> 0) === outer.base;
  return {
    size: parsed.length,
    lookup,
    labels(ips) {
      const out: Record<string, IpNameLabel> = {};
      for (const ip of ips) {
        if (ip in out) continue;
        const e = lookup(ip);
        if (e) out[ip] = labelOf(e);
      }
      return out;
    },
    match(keyword) {
      const k = keyword.trim().toLowerCase();
      if (!k) return { ranges: [], entries: 0 };
      const hit = (e: IpNameEntry) => [e.name, e.department, e.device].some((v) => v.toLowerCase().includes(k));
      const yes = parsed.filter((p) => hit(p.e));
      const no = parsed.filter((p) => !hit(p.e));
      // 每筆符合的對照:自己的範圍扣掉裡面更小、不符合的對照;更裡面又符合的會由它自己那一筆加回來
      const rs = yes.flatMap((p) => subtract(rangeOf(p), no.filter((q) => contains(p, q)).map(rangeOf)));
      return { ranges: mergeRanges(rs).map(([a, b]) => [intToIp(a), intToIp(b)]), entries: yes.length };
    },
  };
}

/* ───────── 回應中的 IP ───────── */

const IP_TEXT = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * 收集回應物件中所有「整個字串就是 IPv4」的值(PA 各 API 的 names 只含本回應出現的 IP);
 * 走訪上限 200,000 個值、IP 上限 5,000 個(回應很大時只附前面的)
 */
export function collectIps(value: unknown, max = 5000): Set<string> {
  const out = new Set<string>();
  let budget = 200_000;
  const walk = (v: unknown, depth: number) => {
    if (budget-- <= 0 || out.size >= max || depth > 12) return;
    if (typeof v === 'string') {
      if (v.length >= 7 && v.length <= 15 && IP_TEXT.test(v)) out.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/** 文字中出現的 IPv4(AI 提示詞附對照用) */
export function ipsInText(text: string, max = 300): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d|\.\d)/g)) {
    out.add(m[0]);
    if (out.size >= max) break;
  }
  return [...out];
}
