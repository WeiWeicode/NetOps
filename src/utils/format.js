/** 位元組 → 1.2 GB */
export function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`
}

/** 數字加千分位 */
export const fmtNum = (n) => (Number(n) || 0).toLocaleString()

/** 大數字縮寫：12.3 萬、1.2 億 */
export function fmtShort(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 億`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 萬`
  return v.toLocaleString()
}

export const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')

const pad = (x) => String(x).padStart(2, '0')
/** Date → 'yyyy/MM/dd' */
export const ymdSlash = (d = new Date()) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`

/** PA 的動作 → 中文與顏色 */
const ACTIONS = {
  allow: { label: '允許', cls: 'status-run' },
  deny: { label: '拒絕', cls: 'status-danger' },
  drop: { label: '丟棄', cls: 'status-danger' },
  'drop-icmp': { label: '丟棄 ICMP', cls: 'status-danger' },
  'reset-both': { label: '重置雙方', cls: 'status-wait' },
  'reset-client': { label: '重置用戶端', cls: 'status-wait' },
  'reset-server': { label: '重置伺服器', cls: 'status-wait' },
}
export const actionLabel = (a) => ACTIONS[a]?.label ?? a
export const actionPill = (a) => ACTIONS[a]?.cls ?? 'status-done'

/** 欄位名稱（明細查詢表格、匯出） */
export const FIELD_LABELS = {
  time: '時間',
  subtype: '類型',
  action: '動作',
  src: '來源 IP',
  sport: '來源 Port',
  dst: '目的 IP',
  dport: '目的 Port',
  proto: '協定',
  app: '應用程式',
  rule: '規則',
  fromZone: '來源區域',
  toZone: '目的區域',
  srcUser: '使用者',
  natSrc: 'NAT 來源',
  natDst: 'NAT 目的',
  bytes: '位元組',
  sent: '送出',
  recv: '接收',
  packets: '封包',
  elapsed: '持續(秒)',
  endReason: '結束原因',
  category: 'URL 類別',
  srcCountry: '來源國家',
  dstCountry: '目的國家',
  appRisk: 'App 風險',
  threat: '威脅名稱',
  severity: '嚴重性',
  url: 'URL / 檔名',
}

/** 下載 CSV（Excel 開啟中文不亂碼：加 BOM） */
export function downloadCsv(filename, header, rows) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const text = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
