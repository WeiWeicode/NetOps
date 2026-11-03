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
