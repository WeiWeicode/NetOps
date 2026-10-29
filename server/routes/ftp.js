import { Router } from 'express'
import path from 'node:path'
import { config } from '../config.js'
import { safePath } from '../lib/ftp.js'
import { cancel, enqueue, forget, listRemote, status, sync } from '../lib/importer.js'
import { cancelEvents, enqueueEvents, eventStatus, eventTypeOfPath, eventTypes, forgetEvents, isEventPath, listEventRemote, syncEvents, typeOfDir } from '../lib/paevimport.js'
import { ah, fail } from '../lib/utils.js'

const router = Router()

/*
 * TRAFFIC（FTP_LOG_DIR，lib/importer.js）與其他類型 log（威脅、URL…各自的目錄，lib/paevimport.js）共用這組 API，
 * 依路徑判斷交給哪個匯入程式
 */

// 瀏覽 FTP 目錄（含每個檔案的分析狀態）
router.get(
  '/browse',
  ah(async (req, res) => {
    const dir = safePath(req.query.path || config.ftp.logDir)
    const type = typeOfDir(dir)
    const items = type ? await listEventRemote(type) : await listRemote(dir)
    res.json({ status: 'success', data: { path: dir, type, root: config.ftp.root, logDir: config.ftp.logDir, pattern: config.ftp.pattern, eventDirs: eventTypes(), items } })
  })
)

// 匯入進度
router.get('/status', (req, res) => res.json({ status: 'success', data: { ...status(), events: eventStatus() } }))

// 同步：FTP_LOG_DIR 的新檔案 / 已變更的檔案加入分析
router.post(
  '/sync',
  ah(async (req, res) => {
    const r = await sync()
    const e = await syncEvents()
    const added = r.added + e.added
    const msg = added ? `${added} 個檔案加入分析（TRAFFIC ${r.added}、其他類型 ${e.added}）` : `沒有新的檔案（TRAFFIC ${r.found} 個、其他類型 ${e.found} 個都已分析）`
    res.json({ status: 'success', message: e.errors.length ? `${msg}；${e.errors.join('；')}` : msg, data: { ...r, events: e } })
  })
)

// 分析選取的檔案（重新分析也用這個）
router.post(
  '/analyze',
  ah(async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    if (!items.length) fail('請選擇要分析的檔案')
    const list = items.map((it) => {
      const p = safePath(it.path)
      return { path: p, name: path.posix.basename(p), size: Number(it.size) || 0, modified: it.modified || null }
    })
    const ev = list.filter((f) => isEventPath(f.path)).map((f) => ({ ...f, type: eventTypeOfPath(f.path) }))
    const added = enqueue(list.filter((f) => !isEventPath(f.path))) + enqueueEvents(ev)
    res.json({ status: 'success', message: `${added} 個檔案加入分析`, data: { added } })
  })
)

router.post('/cancel', (req, res) => res.json({ status: 'success', message: `已取消 ${cancel() + cancelEvents()} 個檔案的分析` }))

// 刪除分析結果
router.post(
  '/forget',
  ah(async (req, res) => {
    const paths = (Array.isArray(req.body.paths) ? req.body.paths : []).map((p) => safePath(p))
    if (!paths.length) fail('請選擇檔案')
    const n = forget(paths.filter((p) => !isEventPath(p))) + forgetEvents(paths.filter((p) => isEventPath(p)))
    res.json({ status: 'success', message: `已刪除 ${n} 個檔案的分析結果` })
  })
)

export default router
