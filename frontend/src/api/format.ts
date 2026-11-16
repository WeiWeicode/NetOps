/** 顯示用格式(頁面共用,避免各頁各寫一套;同 GigaItApp api/format.ts) */

/** 系統時間(UTC `Z`)與 log 時間(`+08:00`)都以瀏覽器時區顯示到秒 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** log 時間只取「時:分:秒」(資料時間範圍的結尾,與開頭同一天時用) */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('zh-TW', { hour12: false });
}

/** 檔案大小(1024 進位) */
export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 數字加千分位;null 顯示空字串(尚未分析) */
export const fmtNum = (n: number | null | undefined): string => (n == null ? '' : n.toLocaleString('zh-TW'));

/** 大數字縮寫:12.3 萬、1.2 億 */
export function fmtShort(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 億`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 萬`;
  return v.toLocaleString('zh-TW');
}

/** 百分比(分母 0 顯示 —) */
export const fmtPct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
