/** 日期工具(YYYY-MM-DD,本地日期;總覽期間、帶條件到明細查詢共用) */

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → YYYY-MM-DD(本地時區) */
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** from ~ to 的天數(含兩端);格式錯誤回 0 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * 總覽期間檢查:ok = 可以送出查詢;error = 要顯示的訊息(沒有已分析資料時不顯示,畫面另有空狀態)。
 * 沒有已分析資料時 from / to 是空的,不可送出(後端 from 必填,會回 400)。
 */
export function checkDayRange(from: string, to: string, hasDays: boolean, maxDays: number): { ok: boolean; error: string } {
  if (!from || !to) return { ok: false, error: hasDays ? '請選擇開始與結束日期' : '' };
  if (from > to) return { ok: false, error: '開始日期不可晚於結束日期' };
  if (daysBetween(from, to) > maxDays) return { ok: false, error: `期間最長 ${maxDays} 天` };
  return { ok: true, error: '' };
}
