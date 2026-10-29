import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { config } from '../config.js'

/**
 * 連線組合統計（AI 問答用，不存原始 log）：
 *   分析每個 log 檔時，依「小時 × 來源 → 目的:協定/Port × 動作 × 規則 × App × 區域 × NAT × 目的國家」累計次數、流量、
 *   最早 / 最晚時間、結束原因次數，存成 {PA_DATA_DIR}/flows/{摘要檔名}.tsv.gz（一列一個組合，沒有逐筆明細）
 * AI 問答有 IP / Port 時直接查這份（幾秒內），不必再從 FTP 重讀原始 CSV；還沒有統計的檔案才掃 FTP
 */
export const flowDir = path.join(config.dataDir, 'flows')
fs.mkdirSync(flowDir, { recursive: true })

// 一個檔案最多記幾種組合；超過時不存（問答改掃 FTP），避免異常檔案（例如被掃描）產生超大統計
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
  /** 寫檔；回傳 { flows } 或 { overflow: true } */
  function save(name) {
    const file = path.join(flowDir, name)
    if (overflow) {
      fs.rmSync(file, { force: true })
      return { overflow: true, flows: 0 }
    }
    const lines = []
    for (const [key, f] of map) lines.push(`${key}\t${f.n}\t${f.bytes}\t${f.first}\t${f.last}\t${[...f.end].map(([e, c]) => `${e.replace(/[:;]/g, ' ')}:${c}`).join(';')}\t${f.user}\t${f.category}`)
    fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(lines.join('\n'), { level: 6 }))
    fs.renameSync(`${file}.tmp`, file)
    return { flows: map.size }
  }
  return { add, save }
}

export const flowFileName = (summaryName) => summaryName.replace(/\.json$/, '.tsv.gz')
export const removeFlows = (name) => name && fs.rmSync(path.join(flowDir, name), { force: true })

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
export async function queryFlows(names, { from, to, prefilter, test, parallel = 4 }) {
  const out = []
  const failed = [] // 讀不到的統計檔（呼叫端改掃 FTP）
  const queue = [...names]
  const end = `${to}:59`
  async function worker() {
    while (queue.length) {
      const name = queue.shift()
      const found = []
      try {
        // 每個統計檔壓縮後約 1MB，整檔讀進來比串流單純（讀檔 / 解壓失敗都會進 catch）
        const text = zlib.gunzipSync(await fs.promises.readFile(path.join(flowDir, name))).toString('utf8')
        for (const line of text.split('\n')) {
          if (!line || (prefilter && !prefilter(line))) continue
          const f = parseLine(line)
          if (f.last < from || f.first > end) continue
          if (test(f)) found.push(f)
        }
        out.push(...found)
      } catch {
        failed.push(name)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, names.length) }, worker))
  return { flows: out, files: names.length, failed }
}
