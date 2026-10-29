import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { config } from '../config.js'
import { ipMatcher } from './palog.js'
import { HttpError, nowText } from './utils.js'

/**
 * 知識庫：管理者請 AI 記錄的筆記，一則一個 .md（{KB_DIR}/{id}.md）
 * 檔案開頭是 --- 包住的欄位（title / ips / tags / author / created / updated / updatedBy / source），下面是 Markdown 內容
 * 匯整檔 {KB_DIR}/_knowledge-all.md：全部筆記整理成一份（目錄 + 各則內容），新增 / 修改 / 刪除時重新產生；
 * 筆記檔被手動修改時，下次讀取也會自動重新產生。AI 問答 / 分析直接送這份匯整檔（相關的筆記另外標出）
 */
fs.mkdirSync(config.kbDir, { recursive: true })
const ALL_FILE = path.join(config.kbDir, '_knowledge-all.md')
/** 筆記新增 / 修改 / 刪除時發出 'change'（向量資料庫同步用，lib/vector.js） */
export const kbEvents = new EventEmitter()

const ID_RE = /^[\w-]{6,64}$/
const fileOf = (id) => {
  if (!ID_RE.test(String(id))) throw new HttpError(400, '筆記代號不正確')
  return path.join(config.kbDir, `${id}.md`)
}
/** 逗號 / 頓號分隔的清單；spaces = true 時空白也算分隔（IP 用；標籤可能含空白，例如「Port 5517」） */
const listText = (v, spaces = true) =>
  (Array.isArray(v) ? v : String(v ?? '').split(spaces ? /[,，、;\s]+/ : /[,，、;]+/))
    .map((x) => String(x).trim())
    .filter(Boolean)
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()

/** .md 文字 → 筆記物件 */
function parse(id, text) {
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
function serialize(n) {
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

let cache = null
/** 全部筆記（新的在前）；檔案有變動才重新讀 */
export function listNotes() {
  // _ 開頭是系統產生的檔案（匯整檔），不是筆記
  const files = fs.readdirSync(config.kbDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  const sig = files.map((f) => `${f}:${fs.statSync(path.join(config.kbDir, f)).mtimeMs}`).join('|')
  if (cache?.sig !== sig) {
    const notes = files.map((f) => parse(f.slice(0, -3), fs.readFileSync(path.join(config.kbDir, f), 'utf8')))
    notes.sort((a, b) => b.updated.localeCompare(a.updated))
    cache = { sig, notes }
  }
  return cache.notes
}

export function getNote(id) {
  const file = fileOf(id)
  if (!fs.existsSync(file)) throw new HttpError(404, '找不到這則筆記')
  return parse(id, fs.readFileSync(file, 'utf8'))
}

/** 新增或修改；回傳筆記 */
export function saveNote({ id, title, ips, tags, content, source }, author) {
  const text = String(content ?? '').trim()
  if (!text) throw new HttpError(400, '筆記內容不可空白')
  const now = nowText().slice(0, 16)
  const old = id ? getNote(id) : null
  const note = {
    id: old?.id ?? `${now.replace(/\D/g, '').slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}`,
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
  const file = fileOf(note.id)
  fs.writeFileSync(`${file}.tmp`, serialize(note), 'utf8')
  fs.renameSync(`${file}.tmp`, file)
  cache = null
  readAll() // 重新產生匯整檔
  kbEvents.emit('change')
  return note
}

export function deleteNote(id) {
  const file = fileOf(id)
  if (!fs.existsSync(file)) throw new HttpError(404, '找不到這則筆記')
  fs.rmSync(file)
  cache = null
  readAll() // 重新產生匯整檔
  kbEvents.emit('change')
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

function buildAll(notes) {
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

let all = null
/** 匯整檔（筆記有變動或檔案不存在時重新產生）：{ text, order: [id], updated, count } */
export function readAll() {
  const notes = listNotes()
  if (all?.sig !== cache.sig || !fs.existsSync(ALL_FILE)) {
    const b = buildAll(notes)
    fs.writeFileSync(`${ALL_FILE}.tmp`, b.text, 'utf8')
    fs.renameSync(`${ALL_FILE}.tmp`, ALL_FILE)
    all = { sig: cache.sig, ...b, count: notes.length }
  }
  return all
}

export const allFile = () => {
  readAll()
  return ALL_FILE
}

/** 查詢：標題、內容、IP、標籤、記錄人包含關鍵字（多個關鍵字以空白分隔，全部符合） */
export function searchNotes(q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const notes = listNotes()
  if (!words.length) return notes
  return notes.filter((n) => {
    const hay = `${n.title}\n${n.content}\n${n.ips.join(' ')}\n${n.tags.join(' ')}\n${n.author}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

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
 */
export function notesForAi({ ips = [], text = '', vector = [] }) {
  const sim = new Map(vector.map((v) => [v.id, v.score]))
  // 這個 embedding 模型不相關的筆記也有 0.6 左右，所以只取最高分（≥ 0.68）與跟它差 0.02 以內的
  const simCut = Math.max(0.68, (vector[0]?.score ?? 1) - 0.02)
  const lower = String(text).toLowerCase()
  const textIps = [...new Set(String(text).match(TEXT_IP_RE) ?? [])].slice(0, 2000)
  const scored = listNotes().map((n) => {
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
  const whole = readAll()
  if (whole.text.length <= config.kbMaxChars) {
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
    if (len + block.length > config.kbMaxChars) {
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
