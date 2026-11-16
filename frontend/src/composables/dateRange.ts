/**
 * 日期區間欄位的邏輯(components/DateRangeField.vue 與測試共用;畫面不放邏輯,FRONTEND-GUIDE)。
 *   mode 'date':YYYY-MM-DD(流量總覽、安全事件);'datetime':YYYY-MM-DDTHH:mm(Log 明細,本地時間)
 *   快捷選項依「現在」算;整個在資料範圍(coverage)之前的選項停用(超過保留期限查不到)
 */
import { daysBetween, ymd } from './dates';

export type RangeMode = 'date' | 'datetime';
export interface DateRange {
  from: string;
  to: string;
}
export interface RangePreset extends DateRange {
  key: string;
  label: string;
  /** 整個在資料範圍之前(超過保留期限) */
  disabled: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Date → YYYY-MM-DDTHH:mm(本地時區) */
export const ymdhm = (d: Date): string => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** 快捷選項:日期模式 今天 / 昨天 / 最近 7 天 / 最近 30 天(不超過 maxDays);時間模式 最近 1 小時 / 最近 24 小時 / 今天 / 昨天 */
export function rangePresets(now: Date, mode: RangeMode, maxDays: number, coverage?: DateRange | null): RangePreset[] {
  const today = addDays(now, 0);
  const list: Omit<RangePreset, 'disabled'>[] =
    mode === 'date'
      ? [
          { key: 'today', label: '今天', from: ymd(today), to: ymd(today) },
          { key: 'yesterday', label: '昨天', from: ymd(addDays(today, -1)), to: ymd(addDays(today, -1)) },
          { key: 'last7', label: '最近 7 天', from: ymd(addDays(today, -6)), to: ymd(today) },
          { key: 'last30', label: '最近 30 天', from: ymd(addDays(today, -29)), to: ymd(today) },
        ].filter((p) => daysBetween(p.from, p.to) <= maxDays)
      : [
          { key: 'last1h', label: '最近 1 小時', from: ymdhm(new Date(now.getTime() - 3600_000)), to: ymdhm(now) },
          { key: 'last24h', label: '最近 24 小時', from: ymdhm(new Date(now.getTime() - 86_400_000)), to: ymdhm(now) },
          { key: 'today', label: '今天', from: `${ymd(today)}T00:00`, to: ymdhm(now) },
          { key: 'yesterday', label: '昨天', from: `${ymd(addDays(today, -1))}T00:00`, to: `${ymd(addDays(today, -1))}T23:59` },
        ];
  return list.map((p) => ({ ...p, disabled: !!coverage?.from && p.to.slice(0, 10) < coverage.from }));
}

/** 欄位顯示的文字:同一天只顯示一次;時間模式同一天時結束只顯示時分 */
export function rangeLabel(r: DateRange, mode: RangeMode): string {
  if (!r.from || !r.to) return '';
  const f = r.from.replace('T', ' ');
  const t = r.to.replace('T', ' ');
  if (mode === 'date') return r.from === r.to ? f : `${f} ~ ${t}`;
  return f.slice(0, 10) === t.slice(0, 10) ? `${f} ~ ${t.slice(11)}` : `${f} ~ ${t}`;
}

/** 區間檢查:開始晚於結束、超過天數上限;回錯誤訊息(空字串 = 可以套用) */
export function rangeError(r: DateRange, maxDays: number): string {
  if (!r.from || !r.to) return '請選擇開始與結束';
  if (r.from > r.to) return '開始不可晚於結束';
  // 日期模式:含兩端的天數;時間模式:實際經過的時間(和明細頁、後端同一個算法;程式碼審查 #3)
  const tooLong = r.from.length > 10 ? new Date(r.to).getTime() - new Date(r.from).getTime() > maxDays * 86_400_000 : daysBetween(r.from, r.to) > maxDays;
  if (tooLong) return `期間最長 ${maxDays} 天`;
  return '';
}

/** 資料範圍的說明(取代舊的「已分析 … 天」):ClickHouse 實際有資料的日期 */
export function coverageText(c: DateRange | null | undefined): string {
  if (!c?.from) return '目前沒有資料';
  return c.from === c.to ? `可查 ${c.from}` : `可查 ${c.from} ~ ${c.to}`;
}
