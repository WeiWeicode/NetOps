import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { listDir, openStream } from './ftp.js'
import { readLog } from './palog.js'
import { aggText, createEventSummary, EVENT_TYPES, EVENT_VERSION, mergeEventSummaries } from './paevents.js'

/**
 * PA 其他類型 log 的匯入（威脅、URL、資料過濾、WildFire、解密、GlobalProtect、User-ID；類型定義在 paevents.js）
 *   FTP 目錄：config.paEvents.dirs；與 TRAFFIC 相同從 FTP 串流讀取，原始 log 不存本機
 *   {PA_DATA_DIR}/events/index.json             每個 FTP 檔案的分析狀態
 *   {PA_DATA_DIR}/events/{類型}/*.json.gz        每個檔案的摘要 + 每小時組合統計
 * 用 1 條 FTP 連線依序分析（TRAFFIC 另外有自己的連線），自動同步與 TRAFFIC 相同週期
 */
const baseDir = path.join(config.dataDir, 'events')
const indexFile = path.join(baseDir, 'index.json')
for (const t of Object.keys(EVENT_TYPES)) fs.mkdirSync(path.join(baseDir, t), { recursive: true })

let index = (() => {
  try {
    return JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  } catch {
    return { files: {} }
  }
})()
index.files ??= {}

function saveIndex() {
  fs.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index))
  fs.renameSync(`${indexFile}.tmp`, indexFile)
}

/** 啟用的類型：[{ type, label, dir }] */
export const eventTypes = () =>
  Object.entries(EVENT_TYPES)
    .map(([type, def]) => ({ type, label: def.label, dir: config.paEvents.dirs[type] }))
    .filter((t) => t.dir)

/** FTP 目錄 → 類型（不是這些目錄回傳 ''） */
export function typeOfDir(dir) {
  return eventTypes().find((t) => t.dir === dir)?.type ?? ''
}

const sumName = (p) => `${path.posix.basename(p).replace(/[^\w.-]+/g, '_').slice(0, 80)}-${crypto.createHash('md5').update(p).digest('hex').slice(0, 8)}.json.gz`
const modKey = (d) => (d ? new Date(d).toISOString() : '')

/* ───────── 工作佇列 ───────── */

const job = { queue: [], running: null, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, lastSyncAt: null, lastSyncError: '' }

export function eventStatus() {
  const r = job.running
  return {
    busy: Boolean(r) || job.queue.length > 0,
    total: job.total,
    done: job.done,
    failed: job.failed,
    queued: job.queue.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastSyncAt: job.lastSyncAt,
    lastSyncError: job.lastSyncError,
    running: r ? [{ path: r.path, name: r.name, type: r.type, size: r.size, read: r.read, rows: r.rows, seconds: Math.round((Date.now() - r.startedAt) / 1000) }] : [],
  }
}

async function analyze(item) {
  const def = EVENT_TYPES[item.type]
  const run = { ...item, read: 0, rows: 0, startedAt: Date.now(), abort: null }
  job.running = run
  try {
    const { stream, done, abort } = await openStream(item.path)
    run.abort = () => {
      run.cancelled = true
      abort()
    }
    stream.on('data', (chunk) => (run.read += chunk.length))
    const sum = createEventSummary(item.type)
    const { bad } = await readLog(
      stream,
      item.name,
      (r) => {
        sum.add(r)
        run.rows++
      },
      { columns: def.columns, numeric: def.numeric }
    )
    await done
    if (run.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true })
    if (item.size && run.read < item.size) throw new Error(`FTP 傳輸不完整（${run.read} / ${item.size} bytes）`)
    const result = { file: item.path, name: item.name, size: item.size, modified: item.modified, analyzedAt: new Date().toISOString(), bad, ...sum.result() }
    const file = `${item.type}/${sumName(item.path)}`
    fs.writeFileSync(path.join(baseDir, `${file}.tmp`), zlib.gzipSync(JSON.stringify(result)))
    fs.renameSync(path.join(baseDir, `${file}.tmp`), path.join(baseDir, file))
    cache.delete(file)
    index.files[item.path] = {
      type: item.type,
      name: item.name,
      size: item.size,
      modified: modKey(item.modified),
      status: 'done',
      error: '',
      v: EVENT_VERSION,
      analyzedAt: result.analyzedAt,
      ms: Date.now() - run.startedAt,
      rows: result.rows,
      lines: result.lines,
      day: result.day,
      timeMin: result.timeMin,
      timeMax: result.timeMax,
      aggOverflow: result.aggOverflow,
      summary: file,
    }
    job.done++
  } catch (err) {
    if (err.cancelled) return
    console.error(`[PA ${def.label}] ${item.path}：${err.message}`)
    index.files[item.path] = { ...(index.files[item.path] ?? {}), type: item.type, name: item.name, size: item.size, modified: modKey(item.modified), status: 'error', error: err.message, analyzedAt: new Date().toISOString() }
    job.failed++
  } finally {
    job.running = null
    saveIndex()
  }
}

let pumping = false
async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (job.queue.length) await analyze(job.queue.shift())
  } finally {
    pumping = false
  }
  if (job.startedAt && !job.finishedAt) job.finishedAt = new Date().toISOString()
}

/** 加入佇列：items = [{ path, name, size, modified, type }] */
export function enqueueEvents(items) {
  if (!job.running && !job.queue.length) Object.assign(job, { total: 0, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null })
  let added = 0
  for (const it of items) {
    if (job.running?.path === it.path || job.queue.some((q) => q.path === it.path)) continue
    job.queue.push(it)
    added++
  }
  job.total += added
  pump()
  return added
}

export function cancelEvents() {
  const n = job.queue.length + (job.running ? 1 : 0)
  job.queue = []
  job.running?.abort?.()
  return n
}

/* ───────── FTP 檔案清單 ───────── */

const LOG_RE = /\.(csv|gz)$/i

/** 類型目錄的檔案 + 分析狀態（與 importer.listRemote 相同格式，FTP Log 檔案頁共用） */
export async function listEventRemote(type) {
  const dir = config.paEvents.dirs[type]
  const list = await listDir(dir)
  return list.map((f) => {
    const st = index.files[f.path]
    let state = 'new'
    if (job.running?.path === f.path) state = 'running'
    else if (job.queue.some((q) => q.path === f.path)) state = 'queued'
    else if (st) state = st.status === 'error' ? 'error' : st.size === f.size && st.modified === modKey(f.modified) && st.v === EVENT_VERSION ? 'done' : 'changed'
    return {
      ...f,
      type,
      isLog: !f.dir && LOG_RE.test(f.name),
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

/** 同步：每個類型目錄的新檔 / 已變更 / 失敗的檔案加入佇列；回傳 { found, added, errors } */
export async function syncEvents() {
  let found = 0
  const items = []
  const errors = []
  for (const t of eventTypes()) {
    try {
      const list = await listEventRemote(t.type)
      const logs = list.filter((f) => f.isLog)
      found += logs.length
      items.push(...logs.filter((f) => ['new', 'changed', 'error'].includes(f.state)).map((f) => ({ path: f.path, name: f.name, size: f.size, modified: f.modified, type: t.type })))
    } catch (err) {
      errors.push(`${t.label}：${err.message}`)
    }
  }
  job.lastSyncAt = new Date().toISOString()
  job.lastSyncError = errors.join('；')
  return { found, added: enqueueEvents(items), errors }
}

if (config.ftp.syncMinutes > 0 && config.ftp.host) {
  const tick = () =>
    syncEvents().then(
      (r) => r.added && console.log(`[PA 其他 log 自動同步] 新增 ${r.added} 個檔案待分析`),
      (err) => console.error(`[PA 其他 log 自動同步] ${err.message}`)
    )
  // 比 TRAFFIC 晚一點開始，避免同時開很多條 FTP 連線
  setTimeout(tick, 60000)
  setInterval(tick, config.ftp.syncMinutes * 60000).unref()
}

/** 刪除摘要（之後同步會重新分析） */
export function forgetEvents(paths) {
  let n = 0
  for (const p of paths) {
    const st = index.files[p]
    if (!st) continue
    if (st.summary) {
      fs.rmSync(path.join(baseDir, st.summary), { force: true })
      cache.delete(st.summary)
    }
    delete index.files[p]
    n++
  }
  saveIndex()
  return n
}

/** 這個路徑是不是其他類型的 log（在類型目錄底下） */
export const isEventPath = (p) => Boolean(index.files[p]) || eventTypes().some((t) => path.posix.dirname(p) === t.dir)
export const eventTypeOfPath = (p) => index.files[p]?.type || typeOfDir(path.posix.dirname(p))

/* ───────── 已分析的摘要 ───────── */

const cache = new Map()
function readSummary(file) {
  if (cache.has(file)) return cache.get(file)
  try {
    const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(baseDir, file))).toString('utf8'))
    if (cache.size > 200) cache.delete(cache.keys().next().value)
    cache.set(file, s)
    return s
  } catch {
    return null
  }
}

/** 某類型資料時間與 [from, to] 重疊的檔案；from / to 為 'yyyy/MM/dd' 或 'yyyy/MM/dd HH:mm' */
function filesInRange(type, from, to) {
  const end = to && to.length <= 10 ? `${to} 23:59:59` : to ? `${to}:59` : ''
  return Object.values(index.files).filter((f) => f.type === type && f.status === 'done' && (!from || (f.timeMax || '') >= from) && (!end || (f.timeMin || '') <= end))
}

/** 各類型有資料的日期與筆數：[{ type, label, dir, files, rows, days: [day] }] */
export function eventOverview() {
  return eventTypes().map((t) => {
    const files = Object.values(index.files).filter((f) => f.type === t.type && f.status === 'done')
    return { ...t, files: files.length, rows: files.reduce((s, f) => s + (f.rows || 0), 0), days: [...new Set(files.map((f) => f.day).filter(Boolean))].sort().reverse() }
  })
}

/** 某類型期間的合併摘要（總覽頁） */
export function eventSummary(type, from, to, topN = 20) {
  const list = filesInRange(type, from, to)
    .map((f) => readSummary(f.summary))
    .filter(Boolean)
  return mergeEventSummaries(type, list, topN)
}

/**
 * AI 問答：問題中的 IP 在各類型 log 的紀錄（每小時組合依 IP 篩選）
 *   test(ip) → 是否符合；from / to 為 'yyyy/MM/dd HH:mm'
 * 回傳 { text, hits: [{ type, label, total, kinds }] }；都沒有回傳 text = ''
 */
export function eventsForIps(from, to, test) {
  const parts = []
  const hits = []
  const end = `${to}:59`
  for (const t of eventTypes()) {
    const def = EVENT_TYPES[t.type]
    const ipIdx = def.ips.map((k) => def.dims.findIndex(([d]) => d === k) + 1)
    const nd = def.dims.length
    const rows = []
    let overflow = 0
    for (const f of filesInRange(t.type, from, to)) {
      if (f.aggOverflow) overflow++
      const s = readSummary(f.summary)
      for (const r of s?.agg ?? []) {
        if (r[nd + 3] < from || r[nd + 2] > end) continue
        if (ipIdx.some((i) => r[i] && test(r[i]))) rows.push(r)
      }
    }
    if (!rows.length) continue
    const a = aggText(t.type, rows)
    hits.push({ type: t.type, label: t.label, total: a.total, kinds: a.kinds })
    parts.push(`### ${t.label}（${t.type}）：${a.total.toLocaleString('en-US')} 次、${a.kinds} 種組合${overflow ? `（${overflow} 個檔案事件太多沒有組合統計，可能不完整）` : ''}\n${a.text}`)
  }
  return { text: parts.length ? `## PA 其他 log（威脅 / URL / 資料過濾 / WildFire / 解密 / GlobalProtect / User-ID）中與問題 IP 相關的紀錄\n\n${parts.join('\n\n')}` : '', hits }
}

/** AI 分析 / 問答（沒有 IP 時）：期間內各類型的重點摘要文字 */
export function eventsContext(from, to, { types = null, topN = 10 } = {}) {
  const out = []
  for (const t of eventTypes()) {
    if (types && !types.includes(t.type)) continue
    const m = eventSummary(t.type, from, to, topN)
    if (!m.rows) continue
    const lines = [`### ${t.label}（${t.type}）：${m.rows.toLocaleString('en-US')} 筆，${m.timeMin} ~ ${m.timeMax}`]
    for (const k of m.kpis) lines.push(`- ${k.title}：${k.items.slice(0, 8).map((x) => `${x.key} ${x.n.toLocaleString('en-US')}`).join('、')}`)
    for (const tp of m.tops) if (tp.items.length) lines.push(`- ${tp.title}：${tp.items.slice(0, topN).map((x) => `${x.key}（${x.n.toLocaleString('en-US')}）`).join('、')}`)
    out.push(lines.join('\n'))
  }
  return out.length ? `## PA 其他 log 摘要（${from} ~ ${to}）\n\n${out.join('\n\n')}` : ''
}
