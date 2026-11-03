/**
 * 時間格式轉換(docs/API.md §1;BACKEND-GUIDE §5.2:ISO 8601 含時區)
 *   核心沿用舊版的本地時間字串('yyyy/MM/dd HH:mm:ss',摘要格式不變,SUMMARY_VERSION 不動),只在 API 邊界轉換。
 *   PA、AD 的 log 時間都是設備當地時間(台灣,沒有日光節約),固定 +08:00。
 */
import { AppError } from '../errors.js';

export const LOG_OFFSET = '+08:00';
const OFFSET_MS = 8 * 3600_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** 'yyyy/MM/dd'(核心)→ 'YYYY-MM-DD';不符合格式時原樣回傳 */
export const dayOut = (d: string): string => (/^\d{4}\/\d{2}\/\d{2}$/.test(d) ? d.replace(/\//g, '-') : d);

/**
 * 核心的本地時間字串 → ISO 8601 +08:00
 *   'yyyy/MM/dd HH:mm:ss' / 'yyyy/MM/dd HH:mm' / 'yyyy/MM/dd HH'(每小時統計)/ 'yyyy/MM/dd'
 *   空字串回 '';無法辨識時原樣回傳(log 內容異常時不丟掉資料)
 */
export function logTimeOut(t: string): string {
  if (!t) return '';
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/.exec(t);
  if (!m) return t;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${LOG_OFFSET}`;
}

/** 'YYYY-MM-DD'(請求)→ 'yyyy/MM/dd'(核心);格式錯誤回 400 */
export function dayIn(v: string, field: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw validation(field, '日期格式必須是 YYYY-MM-DD');
  return `${m[1]}/${m[2]}/${m[3]}`;
}

/** ISO 8601 含時區(請求)→ 台灣時間 'yyyy/MM/dd HH:mm'(核心);沒有時區或格式錯誤回 400 */
export function timeIn(v: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) throw validation(field, '時間格式必須是 ISO 8601 且含時區,例如 2026-11-03T08:30:00+08:00');
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw validation(field, '時間不正確');
  const d = new Date(ms + OFFSET_MS);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 期間(日期):to 省略時等於 from;to 早於 from 回 400 */
export function dayRange(q: { from: string; to?: string }): { from: string; to: string } {
  const from = dayIn(q.from, 'from');
  const to = q.to ? dayIn(q.to, 'to') : from;
  if (to < from) throw validation('to', '結束日期不可早於開始日期');
  return { from, to };
}

export const validation = (field: string, message: string) => new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field, message }]);
