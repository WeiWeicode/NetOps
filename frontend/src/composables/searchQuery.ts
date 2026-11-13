/**
 * 明細查詢頁的網址條件(總覽頁點選帶進來,或重新整理後還原):
 *   from / to:YYYY-MM-DD(整天)或 YYYY-MM-DDTHH:mm(本地時間);舊版 YYYY/MM/DD HH:mm 也接受。
 *   其他條件只收白名單內的 key,字串去頭尾空白、最長 200 字;格式不符的直接略過(不送 API、不放進畫面以外的地方)。
 * 送 API 時轉成 ISO 8601 並固定 +08:00:PA、AD 的 log 時間都是設備當地(台灣)時間(docs/API.md §1),與瀏覽器時區無關。
 */
import type { LocationQuery } from 'vue-router';

export const MAX_COND = 200;

/** 「2026-11-02」「2026-11-02T08:30」「2026/11/02 08:30」→ datetime-local 的值(YYYY-MM-DDTHH:mm);end 時整天補 23:59 */
export function toLocalInput(v: unknown, end = false): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return '';
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? (end ? 23 : 0)), Number(mi ?? (end ? 59 : 0)));
  if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(mo) - 1) return '';
  return `${y}-${mo}-${d}T${h ?? (end ? '23' : '00')}:${mi ?? (end ? '59' : '00')}`;
}

/** datetime-local 的值 → ISO 8601(固定 +08:00,例 2026-11-02T08:30:00+08:00);格式錯誤回空字串 */
export function localToIso(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(0, 16)}:00+08:00` : '';
}

/** 依白名單取出網址條件;check 回 false 的值略過 */
export function pickQuery<K extends string>(
  q: LocationQuery,
  keys: readonly K[],
  check: Partial<Record<K, (v: string) => boolean>> = {},
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const raw = q[k];
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || v.length > MAX_COND) continue;
    if (check[k] && !check[k]!(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 是否由本系統其他頁點選進來(vue-router 的 history.state.back 有值):是才自動查詢;
 * 外部連結或直接開網址只填入條件,由使用者按「查詢」,避免一個連結就以使用者身分送出大範圍查詢(稽核也會記在他名下)。
 */
export const cameFromApp = (): boolean => typeof window !== 'undefined' && !!(window.history.state as { back?: unknown } | null)?.back;

/** Port:數字以逗號分隔(docs/API.md §4.3) */
export const isPorts = (v: string) => /^\d{1,5}(\s*,\s*\d{1,5})*$/.test(v);

/** 事件 ID:數字以逗號分隔 */
export const isEventIds = (v: string) => /^\d{1,6}(\s*,\s*\d{1,6})*$/.test(v);

/** 查詢類型(TRAFFIC 預設;THREAT 查威脅 log,需求方 2026-11-13 決定) */
export const SEARCH_TYPES = ['TRAFFIC', 'THREAT'] as const;
/** 嚴重度(畫面與網址用 info) */
export const SEARCH_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const isSearchType = (v: string) => (SEARCH_TYPES as readonly string[]).includes(v);
export const isSeverity = (v: string) => (SEARCH_SEVERITIES as readonly string[]).includes(v);

/**
 * 網址帶了 Log 明細查詢頁無法套用的條件:不認得的類型、不認得的嚴重度、
 * 不是 THREAT 卻帶了威脅名稱或嚴重度(只有威脅 log 有這兩欄)。回傳要提示「未套用」的文字,沒有則空字串(AGENT §5:不靜默忽略)。
 * 頁面要在進頁時算一次:自動查詢會用 router.replace 改寫網址(只留本頁條件),跟著網址算提示會馬上消失(C7 第二輪)
 */
export function ignoredThreatCond(q: LocationQuery): string {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const type = str(q.type);
  const parts: string[] = [];
  if (type && !isSearchType(type)) parts.push(`類型 ${type}`);
  const threat = type === 'THREAT';
  if (!threat && str(q.threat)) parts.push(`威脅名稱「${str(q.threat)}」`);
  const sev = str(q.severity);
  if (sev && (!threat || !isSeverity(sev))) parts.push(`嚴重度 ${sev}`);
  return parts.join('、');
}

/** IPv4「a.b.c.d」→ 整數;格式不符回 null */
function ipv4Int(v: string): number | null {
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((x) => x > 255)) return null;
  return parts.reduce((acc, x) => acc * 256 + x, 0);
}

/**
 * PA 的國家欄位(Source / Destination Country):私有與保留位址填的是網段範圍(例「10.0.0.0-10.255.255.255」),不是國家(C7b)。
 * 範圍 → { label: 「內部網路 10.0.0.0/8」, cidr };剛好是一個 CIDR 時給 cidr(可改用 IP 條件查),否則 cidr 為 null、label 為「網段 原字串」。
 * 不是範圍(一般國家名稱)回 null。
 */
export function countryRange(key: string): { label: string; cidr: string | null } | null {
  const m = key.trim().match(/^([0-9a-fA-F.:]+)-([0-9a-fA-F.:]+)$/);
  if (!m) return null;
  const [, from = '', to = ''] = m;
  const a = ipv4Int(from);
  const b = ipv4Int(to);
  let cidr: string | null = null;
  if (a !== null && b !== null && b >= a) {
    const size = b - a + 1;
    const bits = Math.log2(size);
    if (Number.isInteger(bits) && a % size === 0) cidr = `${from}/${32 - bits}`;
  }
  return { label: cidr ? `內部網路 ${cidr}` : `網段 ${key.trim()}`, cidr };
}
