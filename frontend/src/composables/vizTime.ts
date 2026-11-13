/**
 * 熱力圖、儀表板用的台灣時間(V-b1):log 與彙總的時間都是台灣時間(+08:00,沒有日光節約;docs/API.md §1),
 * 和瀏覽器時區無關,所以日期加減一律以 +08:00 計算。
 */
const OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** UTC 毫秒 → 台灣日期 'YYYY-MM-DD' */
export function taipeiDay(ms: number): string {
  const d = new Date(ms + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** 'YYYY-MM-DD' → 台灣 00:00 的 UTC 毫秒 */
export const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00+08:00`);
/** 日期加 n 天 */
export const addDays = (day: string, n: number): string => taipeiDay(dayStartMs(day) + n * DAY_MS);
/** 日期加 n 個月(日數超過該月時取月底) */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}
/** 含兩端的天數 */
export const spanDays = (from: string, to: string): number => Math.round((dayStartMs(to) - dayStartMs(from)) / DAY_MS) + 1;
/** ISO 時間 → 台灣 'YYYY-MM-DDTHH:mm'(Log 明細查詢頁的網址條件格式,composables/searchQuery.ts) */
export function taipeiLocal(iso: string): string {
  const d = new Date(Date.parse(iso) + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** 格子的結束時間(ISO +08:00) */
export const plusSeconds = (iso: string, sec: number): string => {
  const d = new Date(Date.parse(iso) + sec * 1000 + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
};
/** 時段文字:同一天「2026-11-11 08:00–09:00」,跨天「2026-11-10 23:00 – 2026-11-11 01:00」;整天「2026-11-11」 */
export function formatRange(start: string, end: string): string {
  const a = taipeiLocal(start).replace('T', ' ');
  const b = taipeiLocal(end).replace('T', ' ');
  if (a.endsWith('00:00') && b.endsWith('00:00') && Date.parse(end) - Date.parse(start) === DAY_MS) return a.slice(0, 10);
  if (a.slice(0, 10) === b.slice(0, 10)) return `${a}–${b.slice(11)}`;
  // 結束在隔天 00:00:顯示 24:00
  if (b.endsWith('00:00') && addDays(a.slice(0, 10), 1) === b.slice(0, 10)) return `${a}–24:00`;
  return `${a} – ${b}`;
}
