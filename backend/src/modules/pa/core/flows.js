/**
 * 連線組合統計(由舊版 server/lib/flows.js 搬移,IMPL-PLAN B2;不存原始 log):
 *   分析每個 log 檔時,依「小時 × 來源 → 目的:協定/Port × 動作 × 規則 × App × 區域 × NAT × 目的國家」累計次數、流量、
 *   最早 / 最晚時間、結束原因次數(一列一個組合,沒有逐筆明細)。
 * 只搬匯入的部分(IMPL-PLAN B2):累計邏輯與輸出格式與舊版相同;寫檔改由 infra/store(saveFlows)負責,
 * 查詢(queryFlows)只給 AI 問答用,留在舊版(ARCHITECTURE D17)。
 */

// 一個檔案最多記幾種組合;超過時不存(問答改掃 FTP),避免異常檔案(例如被掃描)產生超大統計
const MAX_FLOWS = 400000
const KEY_FIELDS = ['src', 'dst', 'proto', 'dport', 'action', 'rule', 'app', 'fromZone', 'toZone', 'natSrc', 'natDst', 'dstCountry']
const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')

export function createFlowStats() {
  const map = new Map()
  let overflow = false
  function add(r) {
    if (overflow || !r.time) return
    const key = `${r.time.slice(0, 13)}\t${KEY_FIELDS.map((k) => clean(r[k])).join('\t')}`
    let f = map.get(key)
    if (!f) {
      if (map.size >= MAX_FLOWS) {
        overflow = true
        map.clear()
        return
      }
      map.set(key, (f = { n: 0, bytes: 0, first: r.time, last: r.time, end: new Map(), user: '', category: '' }))
    }
    f.n++
    f.bytes += r.bytes || 0
    if (r.time < f.first) f.first = r.time
    if (r.time > f.last) f.last = r.time
    const e = clean(r.endReason) || '-'
    f.end.set(e, (f.end.get(e) ?? 0) + 1)
    if (!f.user && r.srcUser) f.user = clean(r.srcUser)
    if (!f.category && r.category && r.category !== 'any') f.category = clean(r.category)
  }
  /** 統計檔內容(TSV,與舊版相同);組合太多時回 { overflow: true, flows: 0, text: '' },不存檔 */
  function serialize() {
    if (overflow) return { overflow: true, flows: 0, text: '' }
    const lines = []
    for (const [key, f] of map) lines.push(`${key}\t${f.n}\t${f.bytes}\t${f.first}\t${f.last}\t${[...f.end].map(([e, c]) => `${e.replace(/[:;]/g, ' ')}:${c}`).join(';')}\t${f.user}\t${f.category}`)
    return { overflow: false, flows: map.size, text: lines.join('\n') }
  }
  return { add, serialize }
}

export const flowFileName = (summaryName) => summaryName.replace(/\.json$/, '.tsv.gz')
