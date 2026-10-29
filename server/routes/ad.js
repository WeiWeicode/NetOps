import { Router } from 'express'
import { adDays, adStatus, adSummary, forgetAdDays, listAdRemote, searchAd, syncAd } from '../lib/adimport.js'
import { CHANNELS, SECURITY_EVENTS } from '../lib/adlog.js'
import { ah, fail, normDate, normDateTime } from '../lib/utils.js'

/**
 * AD 事件記錄（FTP /AD_Log_Backup/yyyyMMdd/*.csv）
 *   GET  /ad/days                    已匯入的日期與同步狀態
 *   GET  /ad/browse                  FTP 上的日期資料夾、檔案與匯入狀態
 *   POST /ad/import { days }         重新匯入選取的日期
 *   POST /ad/forget { days }         刪除選取日期的匯入結果
 *   POST /ad/sync                    立即同步
 *   GET  /ad/summary?from=&to=       統計（各記錄 / 等級的數量、每小時、事件排行、異常、登入失敗的帳號 / IP）
 *   GET  /ad/events?from=&to=&...    事件查詢（channel / level / eventId / q / account / ip / issueOnly）
 */
const router = Router()

router.get('/days', (req, res) => res.json({ status: 'success', data: { days: adDays(), job: adStatus(), channels: CHANNELS, securityEvents: SECURITY_EVENTS } }))

// FTP 上的日期資料夾與匯入狀態（FTP Log 檔案頁）
router.get(
  '/browse',
  ah(async (req, res) => res.json({ status: 'success', data: { dir: adStatus().dir, job: adStatus(), days: await listAdRemote() } }))
)

// 重新匯入選取的日期（不比對檔案，一律重新匯入）
router.post(
  '/import',
  ah(async (req, res) => {
    const days = Array.isArray(req.body.days) ? req.body.days : []
    if (!days.length) fail('請選擇日期')
    const r = await syncAd({ days, force: true })
    if (r.busy) return res.json({ status: 'success', message: '正在同步中，請稍後再試', data: r })
    res.json({ status: 'success', message: `已重新匯入 ${r.imported.map((x) => `${x.day}（${x.events} 筆）`).join('、') || '0 天'}`, data: r })
  })
)

// 刪除匯入結果（FTP 上的檔案不動）
router.post('/forget', (req, res) => {
  const days = Array.isArray(req.body.days) ? req.body.days : []
  if (!days.length) fail('請選擇日期')
  res.json({ status: 'success', message: `已刪除 ${forgetAdDays(days)} 天的匯入結果` })
})

router.post(
  '/sync',
  ah(async (req, res) => {
    const r = await syncAd()
    if (r.busy) return res.json({ status: 'success', message: '正在同步中，請稍後再看', data: r })
    res.json({ status: 'success', message: r.imported.length ? `已匯入 ${r.imported.map((x) => `${x.day}（${x.events} 筆）`).join('、')}` : `沒有新的資料（共 ${r.days} 天都已匯入）`, data: r })
  })
)

const range = (q) => {
  const from = normDate(q.from)
  const to = normDate(q.to) || from
  if (!from) fail('請選擇日期')
  return [from, to]
}

router.get('/summary', (req, res) => {
  const [from, to] = range(req.query)
  res.json({ status: 'success', data: { from, to, ...adSummary(from, to) } })
})

router.get('/events', (req, res) => {
  const from = normDateTime(req.query.from)
  const to = normDateTime(req.query.to) || from
  if (!from) fail('請選擇日期')
  const { channel, level, eventId, q, account, ip } = req.query
  res.json({ status: 'success', data: searchAd(from, to, { channel, level, eventId, q, account, ip, issueOnly: req.query.issueOnly === '1' }, Math.min(Number(req.query.limit) || 2000, 5000)) })
})

export default router
