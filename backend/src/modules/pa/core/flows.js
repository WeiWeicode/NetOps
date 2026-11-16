/**
 * 連線組合統計(由舊版 server/lib/flows.js 搬移,IMPL-PLAN B2;不存原始 log):
 *   分析每個 log 檔時,依「小時 × 來源 → 目的:協定/Port × 動作 × 規則 × App × 區域 × NAT × 目的國家」累計次數、流量、
 *   最早 / 最晚時間、結束原因次數(一列一個組合,沒有逐筆明細)。
 * 只搬匯入的部分(IMPL-PLAN B2):累計邏輯與輸出格式與舊版相同;寫檔改由 infra/store(saveFlows)負責,
 * 查詢(queryFlows)給 AI 問答用(IMPL-PLAN A1 搬移,讀檔由呼叫端注入)。
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

/** 一次查詢最多回傳幾個組合（collector 只保留 5000 種，但要累計次數；20 萬列約 100 MB 以內） */
const QUERY_LIMIT = 200000

/* ───────── 查詢(AI 問答用,由舊版 queryFlows 搬移,IMPL-PLAN A1;讀檔改由呼叫端注入 readFlows) ───────── */

/** 一列 → 組合物件（欄位名稱與 log 紀錄相同，方便沿用 buildCondition 的 IP 判斷） */
function parseLine(line) {
  const p = line.split('\t')
  const r = { hour: p[0] }
  KEY_FIELDS.forEach((k, i) => (r[k] = p[i + 1]))
  const o = KEY_FIELDS.length + 1
  r.dport = r.dport ? Number(r.dport) || r.dport : ''
  r.n = Number(p[o]) || 0
  r.bytes = Number(p[o + 1]) || 0
  r.first = p[o + 2]
  r.last = p[o + 3]
  r.end = (p[o + 4] || '').split(';').filter(Boolean).map((x) => {
    const i = x.lastIndexOf(':')
    return [x.slice(0, i), Number(x.slice(i + 1)) || 0]
  })
  r.srcUser = p[o + 5] || ''
  r.category = p[o + 6] || ''
  return r
}

/**
 * 查詢多個檔案的組合統計：prefilter(line) 先用文字排除，test(flow) 判斷；from / to 為 'yyyy/MM/dd HH:mm'
 * 時間以組合的最早 / 最晚時間判斷是否與 [from, to] 重疊（同一小時內的組合可能稍微超出範圍）
 * 回傳 { flows: [...], files }
 */
export async function queryFlows(names, { from, to, prefilter, test, parallel = 4, readFlows, limit = QUERY_LIMIT }) {
  const out = []
  let truncated = false
  const failed = [] // 讀不到的統計檔（呼叫端改掃 FTP）
  const queue = [...names]
  const end = `${to}:59`
  async function worker() {
    while (queue.length) {
      const name = queue.shift()
      const found = []
      try {
        // 每個統計檔壓縮後約 1MB，整檔讀進來比串流單純（讀檔 / 解壓失敗都會進 catch）
        // readFlows(name)：store.pa.readFlows（解壓後的文字；檔案不存在回 null，視同讀不到）
        const text = await readFlows(name)
        if (text === null) throw new Error('missing')
        if (truncated) continue
        for (const line of text.split('\n')) {
          if (!line || (prefilter && !prefilter(line))) continue
          const f = parseLine(line)
          if (f.last < from || f.first > end) continue
          if (!test(f)) continue
          // 與舊版不同（審查修正）：符合的組合超過 limit 就停止累積並標 truncated（寬網段一次可能數百萬列，避免記憶體耗盡）
          if (out.length + found.length >= limit) {
            truncated = true
            break
          }
          found.push(f)
        }
        // 逐一加入（舊版 out.push(...found) 在組合很多時會超過函式參數上限）
        for (const f of found) out.push(f)
      } catch {
        failed.push(name)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, names.length) }, worker))
  return { flows: out, files: names.length, failed, truncated }
}
