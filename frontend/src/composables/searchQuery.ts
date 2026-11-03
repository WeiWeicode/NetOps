/**
 * 明細查詢頁的網址條件(總覽頁點選帶進來,或重新整理後還原):
 *   from / to:YYYY-MM-DD(整天)或 YYYY-MM-DDTHH:mm(本地時間);舊版 YYYY/MM/DD HH:mm 也接受。
 *   其他條件只收白名單內的 key,字串去頭尾空白、最長 200 字;格式不符的直接略過(不送 API、不放進畫面以外的地方)。
 * 送 API 時轉成 ISO 8601 含時區(docs/API.md §1 時間參數)。
 */
import type { LocationQuery } from 'vue-router';

export const MAX_COND = 200;

const pad = (n: number) => String(n).padStart(2, '0');

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

/** datetime-local 的值 → ISO 8601 含本地時區(例 2026-11-02T08:30:00+08:00) */
export function localToIso(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${v.slice(0, 16)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
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

/** 事件 ID:數字以逗號分隔 */
export const isEventIds = (v: string) => /^\d{1,6}(\s*,\s*\d{1,6})*$/.test(v);
