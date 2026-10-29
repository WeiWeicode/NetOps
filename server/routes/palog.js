import { Router } from 'express'
import { config } from '../config.js'
import { availableDays, filesInRange, readSummary, status } from '../lib/importer.js'
import { buildFilter, buildPrefilter, mergeSummaries, ROW_FIELDS } from '../lib/palog.js'
import { scanFiles } from '../lib/scan.js'
import { ah, fail, normDate, normDateTime } from '../lib/utils.js'

const router = Router()

// 有資料的日期
router.get('/days', (req, res) => res.json({ status: 'success', data: { days: availableDays(), job: status() } }))

// 總覽：合併期間內各檔案的摘要
router.get(
  '/summary',
  ah(async (req, res) => {
    const from = normDate(req.query.from)
    const to = normDate(req.query.to) || from
    if (!from) fail('請選擇日期')
    const files = filesInRange(from, to)
    const sums = files.map((f) => readSummary(f.summary)).filter(Boolean)
    const merged = mergeSummaries(sums, Math.min(Number(req.query.top) || 20, 100))
    // 小時統計只留期間內（跨日的檔案會帶到前後一天的零星資料）
    merged.hours = merged.hours.filter((h) => h.hour.slice(0, 10) >= from && h.hour.slice(0, 10) <= to)
    res.json({ status: 'success', data: { from, to, ...merged } })
  })
)

/**
 * 明細查詢：依時間挑出對應的 log 檔，從 FTP 串流逐列篩選
 * 找到 PA_SEARCH_LIMIT 筆、超過 PA_SEARCH_SECONDS 秒或使用者離開頁面時停止
 */
router.post(
  '/search',
  ah(async (req, res) => {
    const b = req.body ?? {}
    const from = normDateTime(b.from)
    const to = normDateTime(b.to)
    if (!from || !to) fail('請選擇查詢時間')
    if (to < from) fail('結束時間不可早於開始時間')
    const limit = Math.min(Number(b.limit) || config.searchLimit, config.searchLimit)
    const filter = buildFilter({ ...b, from, to })
    const files = filesInRange(from, to)
    if (!files.length) fail('這段時間沒有已分析的 log 檔，請先到「FTP Log 檔案」同步', 404)

    const rows = []
    let closed = false
    res.on('close', () => (closed = true))

    const r = await scanFiles(files, {
      prefilter: buildPrefilter(b),
      parallel: config.ftp.parallel,
      seconds: config.searchSeconds,
      isClosed: () => closed,
      onRow: (rec, raw) => {
        if (filter(rec, raw)) rows.push(ROW_FIELDS.map((k) => rec[k] ?? ''))
        if (rows.length >= limit) return false
      },
    })
    if (closed) return
    rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    res.json({
      status: 'success',
      data: { fields: ROW_FIELDS, rows: rows.slice(0, limit), scanned: r.rows, files: r.files, filesScanned: r.filesScanned, seconds: r.seconds, stopReason: r.stopReason, limit, from, to },
    })
  })
)

// 篩選條件下拉選單的選項（期間內出現過的值）
router.get(
  '/options',
  ah(async (req, res) => {
    const from = normDate(req.query.from)
    const to = normDate(req.query.to) || from
    const sums = filesInRange(from, to).map((f) => readSummary(f.summary)).filter(Boolean)
    const m = mergeSummaries(sums, 200)
    const keys = (name) => (m.top[name] ?? []).map((x) => x.key)
    const zones = new Set()
    for (const z of keys('zone')) for (const part of z.split(' → ')) if (part && part !== '?') zones.add(part)
    res.json({ status: 'success', data: { apps: keys('app'), rules: keys('rule'), zones: [...zones].sort(), actions: Object.keys(m.actions).sort() } })
  })
)

export default router
