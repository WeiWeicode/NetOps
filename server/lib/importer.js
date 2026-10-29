import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { listDir, openStream } from './ftp.js'
import { createSummary, readLog, SUMMARY_VERSION } from './palog.js'
import { createFlowStats, flowFileName, removeFlows } from './flows.js'

/**
 * PA log 匯入：從 FTP 串流讀取每個檔案、算出摘要存成 JSON（原始 log 不存本機）
 *   {PA_DATA_DIR}/index.json            每個 FTP 檔案的分析狀態
 *   {PA_DATA_DIR}/summaries/*.json      每個檔案的摘要（總覽頁合併使用）
 *   {PA_DATA_DIR}/flows/*.tsv.gz        每個檔案的連線組合統計（AI 問答用，lib/flows.js）
 * 檔案大小或修改時間變了會重新分析
 */
const indexFile = path.join(config.dataDir, 'index.json')
const sumDir = path.join(config.dataDir, 'summaries')
fs.mkdirSync(sumDir, { recursive: true })

let index = (() => {
  try {
    return JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  } catch {
    return { files: {} }
  }
})()
index.files ??= {}

let saveTimer = null
function saveIndex(now = false) {
  const write = () => {
    saveTimer = null
    const tmp = `${indexFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(index))
    fs.renameSync(tmp, indexFile)
  }
  if (now) return write()
  saveTimer ??= setTimeout(write, 1000)
}

const sumName = (p) => `${path.posix.basename(p).replace(/[^\w.-]+/g, '_').slice(0, 80)}-${crypto.createHash('md5').update(p).digest('hex').slice(0, 8)}.json`
const modKey = (d) => (d ? new Date(d).toISOString() : '')

/* ───────── 工作佇列 ───────── */

const job = {
  queue: [], // [{ path, name, size, modified }]
  running: new Map(), // path → { path, name, size, read, rows, startedAt, abort }
  total: 0,
  done: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  lastSyncAt: null,
  lastSyncError: '',
}

export function status() {
  return {
    busy: job.running.size > 0 || job.queue.length > 0,
    total: job.total,
    done: job.done,
    failed: job.failed,
    queued: job.queue.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastSyncAt: job.lastSyncAt,
    lastSyncError: job.lastSyncError,
    autoSyncMinutes: config.ftp.syncMinutes,
    running: [...job.running.values()].map(({ abort, ...r }) => ({ ...r, seconds: Math.round((Date.now() - r.startedAt) / 1000) })),
  }
}

async function analyze(item) {
  const run = { path: item.path, name: item.name, size: item.size, read: 0, rows: 0, startedAt: Date.now(), abort: null }
  job.running.set(item.path, run)
  const t0 = Date.now()
  try {
    const { stream, done, abort } = await openStream(item.path)
    run.abort = () => {
      run.cancelled = true
      abort()
    }
    stream.on('data', (chunk) => (run.read += chunk.length))
    const sum = createSummary()
    const flows = createFlowStats()
    const { bad } = await readLog(stream, item.name, (r) => {
      sum.add(r)
      flows.add(r)
      run.rows++
    })
    await done
    // 中斷或傳輸不完整時串流也會「正常結束」，不能把不完整的摘要當成已分析
    if (run.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true })
    if (item.size && run.read < item.size) throw new Error(`FTP 傳輸不完整（${run.read} / ${item.size} bytes）`)
    const result = { file: item.path, name: item.name, size: item.size, modified: item.modified, analyzedAt: new Date().toISOString(), bad, ...sum.result() }
    const file = sumName(item.path)
    fs.writeFileSync(path.join(sumDir, file), JSON.stringify(result))
    const flowFile = flowFileName(file)
    const fl = flows.save(flowFile)
    summaryCache.delete(file)
    index.files[item.path] = {
      name: item.name,
      size: item.size,
      modified: modKey(item.modified),
      status: 'done',
      error: '',
      v: SUMMARY_VERSION,
      analyzedAt: result.analyzedAt,
      ms: Date.now() - t0,
      rows: result.rows,
      day: result.day,
      timeMin: result.timeMin,
      timeMax: result.timeMax,
      summary: file,
      // 連線組合統計：組合數；組合太多（overflow）時沒有統計檔，問答改掃 FTP
      flows: fl.overflow ? '' : flowFile,
      flowCount: fl.flows,
    }
    job.done++
  } catch (err) {
    // 取消的檔案維持原本狀態（下次同步再分析）
    if (err.cancelled) return
    console.error(`[匯入] ${item.path}：${err.message}`)
    index.files[item.path] = { ...(index.files[item.path] ?? {}), name: item.name, size: item.size, modified: modKey(item.modified), status: 'error', error: err.message, analyzedAt: new Date().toISOString() }
    job.failed++
  } finally {
    job.running.delete(item.path)
    saveIndex()
  }
}

function pump() {
  while (job.running.size < config.ftp.parallel && job.queue.length) {
    const item = job.queue.shift()
    analyze(item).finally(pump)
  }
  if (!job.running.size && !job.queue.length && job.startedAt && !job.finishedAt) {
    job.finishedAt = new Date().toISOString()
    saveIndex(true)
  }
}

/** 加入分析佇列（已在佇列或分析中的會略過） */
export function enqueue(items) {
  if (!job.running.size && !job.queue.length) Object.assign(job, { total: 0, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null })
  let added = 0
  for (const it of items) {
    if (job.running.has(it.path) || job.queue.some((q) => q.path === it.path)) continue
    job.queue.push(it)
    added++
  }
  job.total += added
  pump()
  return added
}

/** 取消：清空佇列並中斷分析中的檔案 */
export function cancel() {
  const n = job.queue.length + job.running.size
  job.queue = []
  for (const r of job.running.values()) r.abort?.()
  return n
}

/* ───────── FTP 檔案清單 ───────── */

const pattern = () => {
  try {
    return new RegExp(config.ftp.pattern, 'i')
  } catch {
    return /\.(csv|log|txt|gz)$/i
  }
}

/**
 * FTP 上的檔案搬到別的資料夾（例如根目錄 → /my-data）：檔名與大小相同就沿用原本的分析結果，只更新路徑，不重新分析
 * PA 匯出檔名含日期與序號（PA-560_traffic_2026_10_16_last_calendar_day_0.csv），同名同大小即為同一個檔案
 */
function migrateMoved(list) {
  const here = new Set(list.map((f) => f.path))
  const byName = new Map()
  for (const [p, st] of Object.entries(index.files)) if (!here.has(p) && st.status === 'done') byName.set(path.posix.basename(p), p)
  let moved = 0
  for (const f of list) {
    if (f.dir || index.files[f.path]) continue
    const old = byName.get(f.name)
    if (!old || index.files[old].size !== f.size) continue
    index.files[f.path] = { ...index.files[old], modified: modKey(f.modified) }
    delete index.files[old]
    moved++
  }
  if (moved) {
    console.log(`[匯入] ${moved} 個已分析的檔案在 FTP 上搬了位置，已更新路徑（不重新分析）`)
    saveIndex(true)
  }
}

/** FTP 目錄的檔案 + 分析狀態（new 未分析 / changed 已變更 / done / error / queued / running） */
export async function listRemote(dir = config.ftp.logDir) {
  const re = pattern()
  const list = await listDir(dir)
  migrateMoved(list)
  return list.map((f) => {
    const st = index.files[f.path]
    let state = 'new'
    if (job.running.has(f.path)) state = 'running'
    else if (job.queue.some((q) => q.path === f.path)) state = 'queued'
    else if (st) state = st.status === 'error' ? 'error' : st.size === f.size && st.modified === modKey(f.modified) && st.v === SUMMARY_VERSION ? 'done' : 'changed'
    return {
      ...f,
      isLog: !f.dir && re.test(f.name),
      state,
      rows: st?.rows ?? null,
      day: st?.day ?? '',
      timeMin: st?.timeMin ?? '',
      timeMax: st?.timeMax ?? '',
      analyzedAt: st?.analyzedAt ?? null,
      ms: st?.ms ?? null,
      error: st?.error ?? '',
    }
  })
}

/** 同步：FTP_LOG_DIR 裡符合 FTP_PATTERN、還沒分析或已變更的檔案加入佇列 */
export async function sync() {
  try {
    const list = await listRemote()
    const items = list.filter((f) => f.isLog && ['new', 'changed', 'error'].includes(f.state))
    job.lastSyncAt = new Date().toISOString()
    job.lastSyncError = ''
    return { found: list.filter((f) => f.isLog).length, added: enqueue(items) }
  } catch (err) {
    job.lastSyncAt = new Date().toISOString()
    job.lastSyncError = err.message
    throw err
  }
}

if (config.ftp.syncMinutes > 0 && config.ftp.host) {
  // 失敗（例如啟動時剛好連不上 FTP）2 分鐘後再試一次，不必等到下一個週期
  const tick = (retry = true) =>
    sync().then(
      (r) => r.added && console.log(`[自動同步] 新增 ${r.added} 個檔案待分析`),
      (err) => {
        console.error(`[自動同步] ${err.message}${retry ? '，2 分鐘後重試' : ''}`)
        if (retry) setTimeout(() => tick(false), 120000).unref()
      }
    )
  setTimeout(tick, 15000)
  setInterval(tick, config.ftp.syncMinutes * 60000).unref()
}

/* ───────── 已分析的摘要 ───────── */

/** 已分析完成的檔案（依資料時間排序） */
export function analyzedFiles() {
  return Object.entries(index.files)
    .filter(([, v]) => v.status === 'done')
    .map(([p, v]) => ({ path: p, ...v }))
    .sort((a, b) => (a.timeMin || '').localeCompare(b.timeMin || '') || a.name.localeCompare(b.name, 'en', { numeric: true }))
}

/** 有資料的日期（資料時間，不是檔名日期）：[{ day, files, rows }] */
export function availableDays() {
  const days = new Map()
  for (const f of analyzedFiles()) {
    if (!f.day) continue
    const d = days.get(f.day) ?? { day: f.day, files: 0, rows: 0 }
    d.files++
    d.rows += f.rows || 0
    days.set(f.day, d)
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day))
}

/** 資料時間與 [from, to] 有重疊的檔案；from / to 為 'yyyy/MM/dd' 或 'yyyy/MM/dd HH:mm' */
export function filesInRange(from, to) {
  const end = to && to.length <= 10 ? `${to} 23:59:59` : to ? `${to}:59` : ''
  return analyzedFiles().filter((f) => (!from || (f.timeMax || '') >= from) && (!end || (f.timeMin || '') <= end))
}

const summaryCache = new Map()
export function readSummary(file) {
  if (summaryCache.has(file)) return summaryCache.get(file)
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sumDir, file), 'utf8'))
    if (summaryCache.size > 400) summaryCache.delete(summaryCache.keys().next().value)
    summaryCache.set(file, s)
    return s
  } catch {
    return null
  }
}

/** 刪除摘要（之後同步會重新分析） */
export function forget(paths) {
  let n = 0
  for (const p of paths) {
    const st = index.files[p]
    if (!st) continue
    if (st.summary) {
      fs.rmSync(path.join(sumDir, st.summary), { force: true })
      summaryCache.delete(st.summary)
    }
    removeFlows(st.flows)
    delete index.files[p]
    n++
  }
  saveIndex(true)
  return n
}
