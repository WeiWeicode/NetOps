import { Router } from 'express'
import { eventOverview, eventSummary, eventTypes } from '../lib/paevimport.js'
import { fail, normDate } from '../lib/utils.js'

/**
 * PA 其他類型 log（威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID）
 *   GET /pa-events                          各類型的檔案數、筆數、有資料的日期
 *   GET /pa-events/summary?type=&from=&to=  某類型期間的合併摘要（KPI、排行、每小時）
 * FTP 檔案的同步 / 分析 / 刪除與 TRAFFIC 共用 /ftp（依路徑判斷類型）
 */
const router = Router()

router.get('/', (req, res) => res.json({ status: 'success', data: eventOverview() }))

router.get('/summary', (req, res) => {
  const type = String(req.query.type || '')
  if (!eventTypes().some((t) => t.type === type)) fail('不支援的 log 類型')
  const from = normDate(req.query.from)
  const to = normDate(req.query.to) || from
  if (!from) fail('請選擇日期')
  res.json({ status: 'success', data: eventSummary(type, from, to, Math.min(Number(req.query.top) || 20, 100)) })
})

export default router
