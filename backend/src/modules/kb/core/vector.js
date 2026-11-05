import crypto from 'node:crypto'

/**
 * 知識庫向量資料庫(由舊版 server/lib/vector.js 搬移,IMPL-PLAN A1):每則筆記一個 point 寫進 Qdrant(collection NetOpsKb)
 *   向量:AI 主機 :8081 Qwen3-Embedding-8B(4096 維,Cosine)
 *   point id = 筆記代號的 md5(UUID 格式);payload:noteId / title / ips / tags / author / updated / hash
 * 比對、要寫入的內容與語意搜尋的參數與舊版相同。與舊版不同:
 *   - Qdrant 與 embedding 由呼叫端注入(infra/vector),本檔不直接連線、不讀設定
 *   - 筆記異動事件與定時同步由呼叫端排程(舊版在 import 時就啟動計時器)
 * Qdrant 或 embedding 連不到時只記錄錯誤,問答照常用關鍵字 / IP 比對
 */

export const pointId = (noteId) => {
  const h = crypto.createHash('md5').update(String(noteId)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * 實測（scripts/vec-probe.mjs）：.45 的 embedding 服務加 Qwen3 官方的「Instruct: … Query:」前綴反而變差，查詢直接用原文；
 * 筆記也不放 IP / 網段清單（一長串數字會讓每則筆記都很像）與共通標籤、註記，只放標題、標籤、內容。IP 比對另由 kb.js 處理
 */
// 問題裡的 IP / 網段 / Port 數字會讓向量偏掉（IP 由 kb.js 的 IP 比對處理），算向量前拿掉
export const queryText = (text) => String(text).replace(/(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?::\d+)?/g, ' ').replace(/\s+/g, ' ').trim()
const COMMON_TAGS = new Set(['自動學習', '外部 IP'])
export const noteText = (n) => [n.title, n.tags.filter((t) => !COMMON_TAGS.has(t)).join('、'), n.content.replace(/（AI 依[^）]*）/, '')].filter(Boolean).join('\n')
export const hashOf = (text) => crypto.createHash('md5').update(text).digest('hex')

/**
 * qdrant：{ enabled, collection, request(method, path, body) }（infra/vector createQdrant）
 * embed(text)：文字 → 向量（infra/vector createEmbedder）
 * listNotes()：全部筆記；nowText()：本地時間字串；log：{ info, error }
 * allowWrite：false 時不寫入、不刪除 Qdrant（只做語意搜尋；VECTOR_SYNC，見 config.ts）
 */
/** scroll 最多讀幾頁（每頁 256 筆） */
const MAX_SCROLL_PAGES = 200
/** 一次同步最多刪除：現有筆數的 20%，至少可刪 5 筆 */
const MAX_DELETE_RATIO = 0.2
const MAX_DELETE_MIN = 5

export function createVectorIndex({ qdrant, embed, listNotes, nowText, log, allowWrite }) {
  const state = { ok: null, points: 0, lastSync: null, error: '', syncing: false, upserted: 0, deleted: 0 }
  const vectorEnabled = () => qdrant.enabled
  const vectorStatus = () => ({ enabled: vectorEnabled(), sync: Boolean(allowWrite), collection: qdrant.collection, ...state })
  const embedQuery = (text) => embed(queryText(text))

  /**
   * Qdrant 裡現有的 point：Map(noteId → hash)
   * 與舊版不同（審查修正）：payload 沒有 noteId 的 point（不是筆記同步寫的）不列入，之後也不會被刪除；
   * 最多讀 MAX_SCROLL_PAGES 頁，next_page_offset 重複時停止（避免無窮迴圈）
   */
  async function existing() {
    const out = new Map()
    const seen = new Set()
    let offset = null
    let pages = 0
    do {
      const r = await qdrant.request('POST', '/points/scroll', { limit: 256, offset, with_payload: ['noteId', 'hash'], with_vector: false })
      for (const p of r.points ?? []) if (typeof p.payload?.noteId === 'string' && p.payload.noteId) out.set(p.payload.noteId, { id: p.id, hash: p.payload?.hash })
      offset = r.next_page_offset ?? null
      if (offset !== null && seen.has(JSON.stringify(offset))) throw new Error('向量庫分頁異常（重複的 offset）')
      if (offset !== null) seen.add(JSON.stringify(offset))
      if (++pages >= MAX_SCROLL_PAGES && offset !== null) throw new Error(`向量庫筆數超過 ${MAX_SCROLL_PAGES * 256}，停止同步`)
    } while (offset !== null)
    return out
  }

  /** 全部比對一次：新增 / 內容變了的重算向量寫入，筆記已刪除的移除 */
  async function syncVectors() {
    if (!vectorEnabled() || !allowWrite) return { skipped: true }
    if (state.syncing) return { busy: true }
    state.syncing = true
    try {
      const notes = listNotes()
      const have = await existing()
      const ids = new Set(notes.map((n) => n.id))
      const gone = [...have.entries()].filter(([id]) => !ids.has(id)).map(([, v]) => v.id)
      // 安全閥（與舊版不同，審查修正）：collection 是共用的，知識庫讀不到（空的）或一次要刪太多時整次不同步（寫入前就檢查），請人確認
      if (gone.length && (!notes.length || gone.length > Math.max(MAX_DELETE_MIN, have.size * MAX_DELETE_RATIO)))
        throw new Error(`要從向量庫刪除 ${gone.length} / ${have.size} 筆，超過安全上限，已停止；請確認知識庫資料目錄後再同步`)
      let upserted = 0
      const batch = []
      const flush = async () => {
        if (batch.length) await qdrant.request('PUT', '/points?wait=true', { points: batch.splice(0) })
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
      if (gone.length) await qdrant.request('POST', '/points/delete?wait=true', { points: gone })
      const info = await qdrant.request('GET', '')
      Object.assign(state, { ok: true, error: '', points: info.points_count ?? 0, lastSync: nowText(), upserted, deleted: gone.length })
      if (upserted || gone.length) log.info(`[向量庫] 同步 ${qdrant.collection}：寫入 ${upserted}、刪除 ${gone.length}，共 ${state.points} 筆`)
      return { upserted, deleted: gone.length, points: state.points }
    } catch (err) {
      // 給畫面看的錯誤只放分類訊息（原文可能含主機位址，寫日誌）
      Object.assign(state, { ok: false, error: err.message, lastSync: nowText() })
      log.error({ err, cause: err.cause }, '[向量庫] 同步失敗')
      throw err
    } finally {
      state.syncing = false
    }
  }

  /**
   * 語意搜尋：問題 → 最相近的筆記 [{ id, title, score }]（score 0～1，越高越相近）
   * 失敗回傳 []（不影響問答）
   */
  async function searchVectors(text, { limit = 8, minScore = 0 } = {}) {
    // 只有 IP、沒有文字的問題不做語意搜尋
    if (!vectorEnabled() || String(text ?? '').replace(/[\d.:/\s]+/g, '').length < 2) return []
    try {
      const r = await qdrant.request('POST', '/points/query', { query: await embedQuery(String(text).slice(0, 1200)), limit, with_payload: ['noteId', 'title'], score_threshold: minScore || undefined })
      return (r.points ?? []).map((p) => ({ id: p.payload.noteId, title: p.payload.title, score: Math.round(p.score * 1000) / 1000 }))
    } catch (err) {
      state.error = `搜尋失敗：${err.message}`
      log.error({ err, cause: err.cause }, '[向量庫] 搜尋失敗')
      return []
    }
  }

  return { vectorEnabled, vectorStatus, syncVectors, searchVectors }
}
