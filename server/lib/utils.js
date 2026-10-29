export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 讓 async route 的錯誤進到 express 錯誤處理 */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export const fail = (message, status = 400) => {
  throw new HttpError(status, message)
}

const pad = (n) => String(n).padStart(2, '0')

/** Date → 'yyyy/MM/dd' */
export const fmtDate = (d = new Date()) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
/** Date → 'HH:mm' */
export const fmtTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
export const ymd = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`

/** 'yyyy/MM/dd' 或 'yyyy-MM-dd' → 'yyyy/MM/dd'；不合法回傳 '' */
export const normDate = (s) => {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  return m ? `${m[1]}/${pad(m[2])}/${pad(m[3])}` : ''
}

/** 'yyyy/MM/dd HH:mm' 或 'yyyy-MM-dd HH:mm' → 'yyyy/MM/dd HH:mm'；只有日期時保留日期；不合法回傳 '' */
export const normDateTime = (s) => {
  const d = normDate(s)
  if (!d) return ''
  const m = String(s).match(/[ T](\d{1,2}):(\d{2})/)
  return m ? `${d} ${m[1].padStart(2, '0')}:${m[2]}` : d
}

/** 'HH:mm' 或 'HHmm' → 'HH:mm'；不合法回傳 '' */
export const normTime = (s) => {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{1,2}):?(\d{2})$/)
  return m ? `${pad(m[1])}:${m[2]}` : ''
}

export const toDateTime = (date, time = '00:00') => {
  const d = normDate(date)
  const t = normTime(time) || '00:00'
  if (!d) return null
  const [y, mo, da] = d.split('/').map(Number)
  const [h, mi] = t.split(':').map(Number)
  return new Date(y, mo - 1, da, h, mi)
}

export const addDays = (d, n) => {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
export const weekName = (date) => `星期${WEEK[toDateTime(date).getDay()]}`
export const isWeekend = (date) => [0, 6].includes(toDateTime(date).getDay())

/** 舊系統以 IndexOf 判斷工號是否在逗號清單中，這裡改成逐項比對（不分大小寫） */
export const inList = (list, id) => {
  if (!list || !id) return false
  const target = String(id).trim().toUpperCase()
  return String(list)
    .split(/[,;，\s]+/)
    .some((x) => x.trim().toUpperCase() === target)
}

export const str = (v) => (v === undefined || v === null ? '' : String(v).trim())

/** 字串數字（LearnDB 的時數、名額多是 nvarchar）→ number，不合法回傳 0 */
export const num = (v) => {
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

/** Date → 'yyyy/MM/dd HH:mm:ss'（舊系統寫入字串時間的格式） */
export const nowText = (d = new Date()) => `${fmtDate(d)} ${fmtTime(d)}:${pad(d.getSeconds())}`

/** SQL 片段：nvarchar 數字欄位轉 float（相容性層級 100 沒有 TRY_CONVERT） */
export const sqlNum = (col) => `CASE WHEN ISNUMERIC(${col}) = 1 THEN CONVERT(float, ${col}) ELSE 0 END`
