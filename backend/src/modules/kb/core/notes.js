/**
 * 知識庫筆記的格式與匯整(由舊版 server/lib/kb.js 搬移,IMPL-PLAN B2;內容、格式與排序不變):
 *   一則一個 .md:檔案開頭是 --- 包住的欄位(title / ips / tags / author / created / updated / updatedBy / source),下面是 Markdown 內容
 *   匯整檔:全部筆記整理成一份(目錄 + 各則內容)
 * 只搬純函式;讀寫檔案改由 infra/store(kb),AI 用的 notesForAi 與向量同步事件不搬移(ARCHITECTURE D17)。
 */

const pad = (n) => String(n).padStart(2, '0')
/** Date → 'yyyy/MM/dd HH:mm:ss'(舊版 utils.nowText;本地時間,容器 TZ=Asia/Taipei) */
export const nowText = (d = new Date()) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

export const ID_RE = /^[\w-]{6,64}$/

/** 逗號 / 頓號分隔的清單；spaces = true 時空白也算分隔（IP 用；標籤可能含空白，例如「Port 5517」） */
export const listText = (v, spaces = true) =>
  (Array.isArray(v) ? v : String(v ?? '').split(spaces ? /[,，、;\s]+/ : /[,，、;]+/))
    .map((x) => String(x).trim())
    .filter(Boolean)
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()

/** .md 文字 → 筆記物件 */
export function parse(id, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const meta = {}
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return {
    id,
    title: meta.title || id,
    ips: listText(meta.ips),
    tags: listText(meta.tags, false),
    author: meta.author || '',
    created: meta.created || '',
    updated: meta.updated || meta.created || '',
    updatedBy: meta.updatedBy || '',
    source: meta.source || '',
    content: (m ? m[2] : text).trim(),
  }
}

/** 筆記物件 → .md 文字 */
export function serialize(n) {
  return [
    '---',
    `title: ${oneLine(n.title)}`,
    `ips: ${n.ips.join(', ')}`,
    `tags: ${n.tags.join(', ')}`,
    `author: ${oneLine(n.author)}`,
    `created: ${n.created}`,
    `updated: ${n.updated}`,
    `updatedBy: ${oneLine(n.updatedBy)}`,
    `source: ${oneLine(n.source).slice(0, 300)}`,
    '---',
    '',
    n.content.trim(),
    '',
  ].join('\n')
}

/**
 * 新增或修改後的筆記物件(舊版 saveNote 的欄位整理,不含寫檔)
 *   old:修改時的原筆記;newId:新增時的代號產生方式
 */
export function buildNote({ title, ips, tags, content, source }, author, old, newId) {
  const text = String(content ?? '').trim()
  const now = nowText().slice(0, 16)
  return {
    id: old?.id ?? newId(now),
    title: oneLine(title).slice(0, 120) || text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60),
    ips: listText(ips).filter((x) => /^[\d.:a-f/*]+$/i.test(x)).slice(0, 30),
    tags: listText(tags, false).slice(0, 10),
    author: old?.author || author,
    created: old?.created || now,
    updated: now,
    updatedBy: author,
    source: source ?? old?.source ?? '',
    content: text.slice(0, 20000),
  }
}

/* ───────── 匯整檔 ───────── */

const ipKey = (n) => {
  const ip = n.ips[0]
  if (!ip) return '~' // 沒有 IP 的一般說明排最後
  const p = ip.replace(/\/.*$/, '').split('.')
  return p.length === 4 ? p.map((x) => String(Number(x) || 0).padStart(3, '0')).join('.') : ip
}
/** 筆記內容的標題降級，避免跟匯整檔的章節混在一起 */
const demote = (md) => md.replace(/^(#{1,6})\s/gm, (m, h) => `${'#'.repeat(Math.min(h.length + 3, 6))} `)

export function buildAll(notes) {
  const sorted = [...notes].sort((a, b) => ipKey(a).localeCompare(ipKey(b)) || a.title.localeCompare(b.title, 'zh-Hant'))
  const now = nowText().slice(0, 16)
  const cell = (s) => String(s || '－').replace(/\|/g, '／')
  const lines = [
    '# 網通知識庫匯整',
    '',
    `> 系統自動產生（新增、修改、刪除筆記時更新），請勿直接編輯；要修改請到「知識庫」頁。共 ${sorted.length} 則，更新於 ${now}`,
    '',
    '## 目錄',
    '',
    '| # | 標題 | 相關 IP / 網段 | 標籤 | 更新 |',
    '|---|---|---|---|---|',
    ...sorted.map((n, i) => `| ${i + 1} | ${cell(n.title)} | ${cell(n.ips.join('、'))} | ${cell(n.tags.join('、'))} | ${n.updated} |`),
  ]
  sorted.forEach((n, i) => {
    lines.push(
      '',
      `## ${i + 1}. ${n.title}`,
      '',
      `- 相關 IP / 網段：${n.ips.join('、') || '（一般說明，不限 IP）'}`,
      `- 標籤：${n.tags.join('、') || '－'}`,
      `- 記錄：${n.author || '管理者'} ${n.created}${n.updated !== n.created ? `；修改：${n.updatedBy || n.author} ${n.updated}` : ''}`,
      '',
      demote(n.content)
    )
  })
  return { text: lines.join('\n') + '\n', order: sorted.map((n) => n.id), updated: now }
}

/** 查詢：標題、內容、IP、標籤、記錄人包含關鍵字（多個關鍵字以空白分隔，全部符合） */
export function searchNotes(notes, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return notes
  return notes.filter((n) => {
    const hay = `${n.title}\n${n.content}\n${n.ips.join(' ')}\n${n.tags.join(' ')}\n${n.author}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
