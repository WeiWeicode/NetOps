import { Router } from 'express'
import { config } from '../config.js'
import { allFile, deleteNote, getNote, listNotes, readAll, saveNote, searchNotes } from '../lib/kb.js'
import { searchVectors, syncVectors, vectorStatus } from '../lib/vector.js'
import { learnIps, learnStatus } from '../lib/iplearn.js'
import { isKbAdmin } from '../lib/perms.js'
import { ah, fail } from '../lib/utils.js'

/**
 * 知識庫（AI 問答時管理者請 AI 記錄的筆記）
 *   GET    /kb?q=          查詢（標題、內容、IP、標籤、記錄人）；semantic=1 改用向量庫語意搜尋（Qdrant NetOpsKb，依相近度排序）
 *   POST   /kb/vector-sync 立即同步向量庫（管理者）
 *   GET    /kb/all/md      下載匯整檔（全部筆記一份 .md，AI 問答用的就是這份）
 *   GET    /kb/learn-ips   外部 IP 自動學習的狀態
 *   POST   /kb/learn-ips   立即學習外部 IP（管理者，背景執行）
 *   GET    /kb/:id         一則筆記
 *   GET    /kb/:id/md      下載原始 .md
 *   POST   /kb             新增（管理者）
 *   PUT    /kb/:id         修改（管理者）
 *   DELETE /kb/:id         刪除（管理者）
 */
const router = Router()

const author = (req) => `${req.user.userid}${req.user.perms.info?.name ? ` ${req.user.perms.info.name}` : ''}`
const requireAdmin = (req) => {
  if (!isKbAdmin(req.user.userid)) fail('只有知識庫管理者可以新增、修改或刪除筆記（server/.env 的 KB_ADMINS）', 403)
}

router.get(
  '/',
  ah(async (req, res) => {
    let notes
    if (req.query.semantic === '1' && String(req.query.q ?? '').trim()) {
      // 語意搜尋：相近度 0.6 以上（這個模型不相關的約 0.6），依相近度排序，每則附 score
      const byId = new Map(listNotes().map((n) => [n.id, n]))
      notes = (await searchVectors(req.query.q, { limit: 20, minScore: 0.6 })).filter((h) => byId.has(h.id)).map((h) => ({ ...byId.get(h.id), score: h.score }))
    } else notes = searchNotes(req.query.q)
    const all = readAll()
    res.json({ status: 'success', data: { admin: isKbAdmin(req.user.userid), notes, vector: vectorStatus(), all: { count: all.count, updated: all.updated, chars: all.text.length, limit: config.kbMaxChars } } })
  })
)

router.post(
  '/vector-sync',
  ah(async (req, res) => {
    requireAdmin(req)
    const r = await syncVectors()
    res.json({ status: 'success', message: r.busy ? '向量庫正在同步中' : `向量庫已同步：寫入 ${r.upserted ?? 0}、刪除 ${r.deleted ?? 0}，共 ${r.points ?? 0} 筆`, data: vectorStatus() })
  })
)

router.get('/all/md', (req, res) => {
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('網通知識庫匯整.md')}`)
  res.type('text/markdown; charset=utf-8').sendFile(allFile())
})

/* 外部 IP 自動學習（lib/iplearn.js）：狀態所有人可看，執行限管理者；執行在背景跑，前端輪詢狀態 */
router.get('/learn-ips', (req, res) => res.json({ status: 'success', data: learnStatus() }))

router.post('/learn-ips', (req, res) => {
  requireAdmin(req)
  if (learnStatus().busy) fail('外部 IP 自動學習正在執行中')
  const days = Math.min(Math.max(Number(req.body?.days) || config.ipLearn.days, 1), 60)
  const max = Math.min(Math.max(Number(req.body?.max) || config.ipLearn.max, 1), 500)
  learnIps({ days, max, rewrite: req.body?.rewrite === true, by: author(req) }).catch((err) => console.error(`[外部 IP 學習] ${err.message}`))
  res.json({ status: 'success', message: '已開始學習外部 IP', data: learnStatus() })
})

router.get('/:id', (req, res) => res.json({ status: 'success', data: getNote(req.params.id) }))

router.get('/:id/md', (req, res) => {
  const n = getNote(req.params.id)
  const name = `${n.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.md`
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.type('text/markdown; charset=utf-8').sendFile(`${n.id}.md`, { root: config.kbDir })
})

router.post(
  '/',
  ah(async (req, res) => {
    requireAdmin(req)
    res.json({ status: 'success', message: '已新增筆記', data: saveNote({ ...req.body, id: undefined }, author(req)) })
  })
)

router.put(
  '/:id',
  ah(async (req, res) => {
    requireAdmin(req)
    res.json({ status: 'success', message: '已儲存', data: saveNote({ ...req.body, id: req.params.id }, author(req)) })
  })
)

router.delete(
  '/:id',
  ah(async (req, res) => {
    requireAdmin(req)
    const n = getNote(req.params.id)
    deleteNote(n.id)
    res.json({ status: 'success', message: `已刪除「${n.title}」` })
  })
)

export { author }
export default router
