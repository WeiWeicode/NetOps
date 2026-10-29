import crypto from 'node:crypto'
import { config } from '../config.js'
import { kbEvents, listNotes } from './kb.js'
import { nowText } from './utils.js'

/**
 * 知識庫向量資料庫：每則筆記一個 point 寫進 Qdrant（10.10.130.46，collection NetOpsKb）
 *   向量：10.10.130.45:8081 Qwen3-Embedding-8B（4096 維，Cosine）
 *   point id = 筆記代號的 md5（UUID 格式）；payload：noteId / title / ips / tags / author / updated / hash
 * 筆記新增 / 修改 / 刪除後自動同步（內容 hash 沒變的不重算向量），啟動時與每 30 分鐘也全部比對一次
 * Qdrant 或 embedding 連不到時只記錄錯誤，問答照常用關鍵字 / IP 比對
 */
const q = config.qdrant
export const vectorEnabled = () => Boolean(q.url)

const state = { ok: null, points: 0, lastSync: null, error: '', syncing: false, upserted: 0, deleted: 0 }
export const vectorStatus = () => ({ enabled: vectorEnabled(), collection: q.collection, ...state })

const pointId = (noteId) => {
  const h = crypto.createHash('md5').update(String(noteId)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

async function qdrant(method, path, body) {
  const res = await fetch(`${q.url}/collections/${encodeURIComponent(q.collection)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(q.apiKey ? { 'api-key': q.apiKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Qdrant 回應 ${res.status}：${(await res.text()).slice(0, 200)}`)
  return (await res.json()).result
}

/** 文字 → 向量（Qwen3-Embedding 的 context 2048 token，太長的截斷） */
async function embed(text) {
  const res = await fetch(`${q.embedUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: String(text).slice(0, 1500) }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Embedding 服務回應 ${res.status}：${(await res.text()).slice(0, 200)}`)
  const v = (await res.json()).data?.[0]?.embedding
  if (!Array.isArray(v)) throw new Error('Embedding 服務沒有回傳向量')
  return v
}

/**
 * 實測（scripts/vec-probe.mjs）：.45 的 embedding 服務加 Qwen3 官方的「Instruct: … Query:」前綴反而變差，查詢直接用原文；
 * 筆記也不放 IP / 網段清單（一長串數字會讓每則筆記都很像）與共通標籤、註記，只放標題、標籤、內容。IP 比對另由 kb.js 處理
 */
// 問題裡的 IP / 網段 / Port 數字會讓向量偏掉（IP 由 kb.js 的 IP 比對處理），算向量前拿掉
const embedQuery = (text) => embed(String(text).replace(/(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?::\d+)?/g, ' ').replace(/\s+/g, ' ').trim())
const COMMON_TAGS = new Set(['自動學習', '外部 IP'])
const noteText = (n) => [n.title, n.tags.filter((t) => !COMMON_TAGS.has(t)).join('、'), n.content.replace(/（AI 依[^）]*）/, '')].filter(Boolean).join('\n')
const hashOf = (text) => crypto.createHash('md5').update(text).digest('hex')

/** Qdrant 裡現有的 point：Map(noteId → hash) */
async function existing() {
  const out = new Map()
  let offset = null
  do {
    const r = await qdrant('POST', '/points/scroll', { limit: 256, offset, with_payload: ['noteId', 'hash'], with_vector: false })
    for (const p of r.points ?? []) out.set(p.payload?.noteId, { id: p.id, hash: p.payload?.hash })
    offset = r.next_page_offset ?? null
  } while (offset)
  return out
}

/** 全部比對一次：新增 / 內容變了的重算向量寫入，筆記已刪除的移除 */
export async function syncVectors() {
  if (!vectorEnabled()) return { skipped: true }
  if (state.syncing) return { busy: true }
  state.syncing = true
  try {
    const notes = listNotes()
    const have = await existing()
    let upserted = 0
    const batch = []
    const flush = async () => {
      if (batch.length) await qdrant('PUT', '/points?wait=true', { points: batch.splice(0) })
    }
    for (const n of notes) {
      const text = noteText(n)
      const hash = hashOf(text)
      if (have.get(n.id)?.hash === hash) continue
      batch.push({
        id: pointId(n.id),
        vector: await embed(text),
        payload: { noteId: n.id, title: n.title, ips: n.ips, tags: n.tags, author: n.author, updated: n.updated, hash, syncedAt: nowText() },
      })
      upserted++
      if (batch.length >= 16) await flush()
    }
    await flush()
    const ids = new Set(notes.map((n) => n.id))
    const gone = [...have.entries()].filter(([id]) => !ids.has(id)).map(([, v]) => v.id)
    if (gone.length) await qdrant('POST', '/points/delete?wait=true', { points: gone })
    const info = await qdrant('GET', '')
    Object.assign(state, { ok: true, error: '', points: info.points_count ?? 0, lastSync: nowText(), upserted, deleted: gone.length })
    if (upserted || gone.length) console.log(`[向量庫] 同步 ${q.collection}：寫入 ${upserted}、刪除 ${gone.length}，共 ${state.points} 筆`)
    return { upserted, deleted: gone.length, points: state.points }
  } catch (err) {
    Object.assign(state, { ok: false, error: err.message, lastSync: nowText() })
    console.error(`[向量庫] 同步失敗：${err.message}`)
    throw err
  } finally {
    state.syncing = false
  }
}

/**
 * 語意搜尋：問題 → 最相近的筆記 [{ id, title, score }]（score 0～1，越高越相近）
 * 失敗回傳 []（不影響問答）
 */
export async function searchVectors(text, { limit = 8, minScore = 0 } = {}) {
  // 只有 IP、沒有文字的問題不做語意搜尋
  if (!vectorEnabled() || String(text ?? '').replace(/[\d.:/\s]+/g, '').length < 2) return []
  try {
    const r = await qdrant('POST', '/points/query', { query: await embedQuery(String(text).slice(0, 1200)), limit, with_payload: ['noteId', 'title'], score_threshold: minScore || undefined })
    return (r.points ?? []).map((p) => ({ id: p.payload.noteId, title: p.payload.title, score: Math.round(p.score * 1000) / 1000 }))
  } catch (err) {
    state.error = `搜尋失敗：${err.message}`
    console.error(`[向量庫] ${state.error}`)
    return []
  }
}

if (vectorEnabled()) {
  // 筆記異動後 3 秒同步（連續修改只跑一次）
  let timer = null
  kbEvents.on('change', () => {
    clearTimeout(timer)
    timer = setTimeout(() => syncVectors().catch(() => {}), 3000)
  })
  setTimeout(() => syncVectors().catch(() => {}), 5000)
  setInterval(() => syncVectors().catch(() => {}), 30 * 60000).unref()
}
