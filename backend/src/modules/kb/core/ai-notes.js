import { ipMatcher } from '../../pa/core/palog.js'

/**
 * AI 分析 / 問答要帶的知識庫筆記(由舊版 server/lib/kb.js 的 notesForAi 搬移,IMPL-PLAN A1;挑選與排序規則不變)
 * 與舊版不同:筆記、匯整檔與字數上限由呼叫端傳入(舊版直接呼叫 listNotes / readAll、讀 config.kbMaxChars)。
 */

/** 筆記的 IP 是否與查詢的 IP 相關（含網段：筆記寫 10.10.130.0/24 也算 10.10.130.154 相關，反之亦然） */
function ipRelated(noteIp, ip) {
  const a = ipMatcher(noteIp)
  const b = ipMatcher(ip)
  const base = (x) => x.replace(/\/\d+$/, '').replace(/\*.*$/, '0')
  return (a && a(base(ip))) || (b && b(base(noteIp))) || noteIp === ip
}

const TEXT_IP_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g

/**
 * 知識庫筆記全部帶給 AI（最多 KB_MAX_CHARS 字），相關的排前面：
 *   問題中的 IP 與筆記的 IP / 網段相符 → 最優先
 *   問題或查到的資料中出現筆記的 IP / 網段、標籤或標題 → 其次
 *   其餘依更新時間（新的在前）
 * 匯整檔在 KB_MAX_CHARS 字以內時直接送匯整檔；超過時才逐則挑選，放不下的筆記只列標題，並告訴 AI 有哪些沒附上
 *   ips：問題中的 IP；text：問題與資料文字
 *   vector：向量資料庫語意搜尋的結果 [{ id, score }]（lib/vector.js searchVectors），最相近的（≥ 0.68）也算相關
 * 回傳 { text, used: [{ id, title, related }], omitted: [{ id, title }] }
 * @param {any[]} notes
 * @param {{ text: string, order: string[], count: number }} whole
 * @param {number} maxChars
 * @param {{ ips?: string[], text?: string, vector?: { id: string, score: number }[] }} opts
 */
export function notesForAi(notes, whole, maxChars, { ips = [], text = '', vector = [] }) {
  const sim = new Map(vector.map((v) => [v.id, v.score]))
  // 這個 embedding 模型不相關的筆記也有 0.6 左右，所以只取最高分（≥ 0.68）與跟它差 0.02 以內的
  const simCut = Math.max(0.68, (vector[0]?.score ?? 1) - 0.02)
  const lower = String(text).toLowerCase()
  const textIps = [...new Set(String(text).match(TEXT_IP_RE) ?? [])].slice(0, 2000)
  const scored = notes.map((n) => {
    let score = 0
    if (n.ips.some((nip) => ips.some((ip) => ipRelated(nip, ip)))) score += 100
    if (n.ips.some((nip) => textIps.some((ip) => ipRelated(nip, ip)))) score += 50
    if (n.tags.some((t) => lower.includes(t.toLowerCase())) || lower.includes(n.title.toLowerCase())) score += 20
    // 語意相近（向量庫）：達門檻視為相關（+50），其餘依相近度微調排序
    const s = sim.get(n.id) ?? 0
    score += s >= simCut ? 50 + Math.round(s * 10) : Math.round(s * 20)
    return { n, score }
  })
  scored.sort((a, b) => b.score - a.score || b.n.updated.localeCompare(a.n.updated))

  // 一般情況：直接送匯整檔，前面標出這次判斷相關的筆記編號
  // whole:匯整檔 { text, order, count }(呼叫端傳入)
  if (whole.text.length <= maxChars) {
    const no = new Map(whole.order.map((id, i) => [id, i + 1]))
    const related = scored.filter((x) => x.score >= 50).map((x) => `第 ${no.get(x.n.id)} 則「${x.n.title}」`)
    const head = related.length ? `本次問題中的 IP 與以下筆記相關，請優先參考：${related.join('、')}\n\n` : ''
    return {
      text: whole.count ? `${head}${whole.text}` : '',
      used: scored.map(({ n, score }) => ({ id: n.id, title: n.title, related: score >= 50 })),
      omitted: [],
      source: 'all',
    }
  }

  // 匯整檔超過字數上限：改成逐則挑選，相關的優先，放不下的只列標題
  const used = []
  const omitted = []
  const parts = []
  let len = 0
  for (const { n, score } of scored) {
    const block = `### ${n.title}${n.ips.length ? `（相關 IP：${n.ips.join('、')}）` : ''}\n（${n.author || '管理者'} 記錄於 ${n.updated}）\n${n.content}`
    if (len + block.length > maxChars) {
      omitted.push({ id: n.id, title: n.title })
      continue
    }
    parts.push(block)
    used.push({ id: n.id, title: n.title, related: score >= 50 })
    len += block.length
  }
  if (omitted.length) parts.push(`（另有 ${omitted.length} 則筆記因長度上限未附內容：${omitted.map((x) => x.title).join('、')}）`)
  return { text: parts.join('\n\n'), used, omitted, source: 'notes' }
}
