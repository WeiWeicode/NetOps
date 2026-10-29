import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { config } from '../config.js'
import { connect, listDir, safePath } from './ftp.js'
import { buildAdFilter, channelOf, enrichEvent, parseAdCsv, summarizeAd } from './adlog.js'

/**
 * AD 事件記錄匯入：FTP {FTP_AD_DIR}/yyyyMMdd/*.csv → {AD_DATA_DIR}/yyyyMMdd.json（全部事件，一天約幾千筆）
 * 每天資料夾裡任一檔案大小或時間改變就重新匯入；與 PA log 共用 FTP_SYNC_MINUTES 自動同步
 */
fs.mkdirSync(config.ad.dataDir, { recursive: true })
const dayFile = (day) => path.join(config.ad.dataDir, `${day}.json`)
const DAY_RE = /^\d{8}$/
const slash = (d) => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`

const state = { running: false, lastSyncAt: null, lastSyncError: '', lastResult: null }
export const adStatus = () => ({ ...state, dir: config.ad.dir })

/** FTP 檔案 → Buffer（AD 匯出檔很小，直接讀進記憶體） */
async function download(client, file) {
  const chunks = []
  await client.downloadTo(new Writable({ write(c, _e, cb) { chunks.push(c); cb() } }), file)
  return Buffer.concat(chunks)
}
const decode = (buf) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '')

const cache = new Map()
/** 讀一天的資料：{ day, files: [{ name, channel, size, modified, rows }], events } */
export function readDay(day) {
  const f = dayFile(day)
  if (!fs.existsSync(f)) return null
  const mtime = fs.statSync(f).mtimeMs
  const hit = cache.get(day)
  if (hit?.mtime === mtime) return hit.data
  const data = JSON.parse(fs.readFileSync(f, 'utf8'))
  data.events.forEach(enrichEvent)
  if (cache.size > 60) cache.delete(cache.keys().next().value)
  cache.set(day, { mtime, data })
  return data
}

/** 已匯入的日期（新的在前）：[{ day: 'yyyy/MM/dd', events, files: [{ name, rows }] }] */
export function adDays() {
  return fs
    .readdirSync(config.ad.dataDir)
    .filter((f) => /^\d{8}\.json$/.test(f))
    .map((f) => readDay(f.slice(0, 8)))
    .filter(Boolean)
    .map((d) => ({ day: slash(d.day), events: d.events.length, files: d.files.map(({ name, channel, rows }) => ({ name, channel, rows })), importedAt: d.importedAt }))
    .sort((a, b) => b.day.localeCompare(a.day))
}

const csvFiles = async (client, dirPath) => (await client.list(dirPath)).filter((f) => f.isFile && /\.csv$/i.test(f.name))
const sigOf = (files) => files.map((f) => `${f.name}:${f.size}:${f.modifiedAt?.toISOString() ?? f.rawModifiedAt}`).sort().join('|')

/** 匯入一天（dirPath 為 FTP 上的日期資料夾），回傳筆數 */
async function importDay(client, day, dirPath, files, sig) {
  const events = []
  const info = []
  for (const f of files) {
    try {
      const evs = parseAdCsv(decode(await download(client, `${dirPath}/${f.name}`)), f.name)
      events.push(...evs)
      info.push({ name: f.name, channel: evs[0]?.channel ?? f.name.replace(/\.csv$/i, ''), size: f.size, modified: f.modifiedAt, rows: evs.length })
    } catch (err) {
      info.push({ name: f.name, size: f.size, modified: f.modifiedAt, rows: 0, error: err.message })
    }
  }
  // 同一天可能同時有舊檔名（Security.csv）和新檔名（Security_GSMC-DC1.csv，v3 匯出程式）：依主機 + 記錄 + 記錄編號去除重複
  const seen = new Set()
  const unique = events.filter((e) => {
    const k = `${e.computer}|${e.channel}|${e.recordId}`
    if (!e.recordId || !seen.has(k)) return seen.add(k), true
    return false
  })
  unique.sort((a, b) => b.time.localeCompare(a.time))
  const data = { day, sig, importedAt: new Date().toISOString(), files: info, events: unique }
  fs.writeFileSync(`${dayFile(day)}.tmp`, JSON.stringify(data))
  fs.renameSync(`${dayFile(day)}.tmp`, dayFile(day))
  cache.delete(day)
  return unique.length
}

/**
 * FTP 上的日期資料夾與匯入狀態（FTP Log 檔案頁）
 * state：new 未匯入 / changed 檔案有變（會重新匯入）/ done 已匯入 / orphan 已匯入但 FTP 上已沒有這個資料夾
 * 回傳 [{ day, path, state, events, importedAt, files: [{ name, size, modified, channel, rows, error }] }]
 */
export async function listAdRemote() {
  const client = await connect()
  try {
    const dirs = (await listDir(safePath(config.ad.dir))).filter((d) => d.dir && DAY_RE.test(d.name))
    const out = []
    for (const d of dirs) {
      const files = await csvFiles(client, d.path)
      const local = readDay(d.name)
      const state = !local ? 'new' : local.sig === sigOf(files) ? 'done' : 'changed'
      const byName = new Map((local?.files ?? []).map((f) => [f.name, f]))
      out.push({
        day: slash(d.name),
        path: d.path,
        state,
        events: local?.events.length ?? null,
        importedAt: local?.importedAt ?? null,
        files: files.map((f) => ({ name: f.name, size: f.size, modified: f.modifiedAt, channel: channelOf(f.name), rows: byName.get(f.name)?.rows ?? null, error: byName.get(f.name)?.error ?? '' })),
      })
    }
    // 已匯入、但 FTP 上已經沒有資料夾的日期（例如手動補匯出後又刪掉），列出來才能刪除
    const onFtp = new Set(dirs.map((d) => d.name))
    for (const f of fs.readdirSync(config.ad.dataDir)) {
      const day = f.slice(0, 8)
      if (!/^\d{8}\.json$/.test(f) || onFtp.has(day)) continue
      const local = readDay(day)
      if (!local) continue
      out.push({
        day: slash(day),
        path: '',
        state: 'orphan',
        events: local.events.length,
        importedAt: local.importedAt,
        files: local.files.map((x) => ({ name: x.name, size: x.size, modified: x.modified, channel: x.channel, rows: x.rows, error: x.error ?? '' })),
      })
    }
    return out.sort((a, b) => b.day.localeCompare(a.day))
  } finally {
    client.close()
  }
}

/** 刪除指定日期的匯入結果（FTP 上的檔案不動；之後同步會重新匯入） */
export function forgetAdDays(days) {
  let n = 0
  for (const d of days) {
    const key = toKey(d)
    if (!DAY_RE.test(key)) continue
    if (fs.existsSync(dayFile(key))) {
      fs.rmSync(dayFile(key))
      cache.delete(key)
      n++
    }
  }
  return n
}

/**
 * 同步：每個日期資料夾比對檔案大小 / 時間，有變才重新匯入
 *   days：只處理這些日期（'yyyy/MM/dd' 或 yyyyMMdd）；force：不比對，一律重新匯入
 * 回傳 { days, imported: [{ day, events }] }
 */
export async function syncAd({ days = null, force = false } = {}) {
  if (state.running) return { busy: true }
  state.running = true
  const imported = []
  const want = days ? new Set(days.map(toKey)) : null
  const client = await connect()
  try {
    const root = safePath(config.ad.dir)
    const dirs = (await listDir(root)).filter((d) => d.dir && DAY_RE.test(d.name) && (!want || want.has(d.name)))
    for (const d of dirs) {
      const files = await csvFiles(client, d.path)
      const sig = sigOf(files)
      if (!force && readDay(d.name)?.sig === sig) continue
      imported.push({ day: slash(d.name), events: await importDay(client, d.name, d.path, files, sig) })
    }
    state.lastResult = { days: dirs.length, imported }
    state.lastSyncError = ''
    return state.lastResult
  } catch (err) {
    state.lastSyncError = err.message
    throw err
  } finally {
    state.lastSyncAt = new Date().toISOString()
    state.running = false
    client.close()
  }
}

if (config.ftp.syncMinutes > 0 && config.ftp.host && config.ad.dir) {
  const tick = () =>
    syncAd().then(
      (r) => r.imported?.length && console.log(`[AD 自動同步] 匯入 ${r.imported.map((x) => `${x.day}（${x.events} 筆）`).join('、')}`),
      (err) => console.error(`[AD 自動同步] ${err.message}`)
    )
  setTimeout(tick, 20000)
  setInterval(tick, config.ftp.syncMinutes * 60000).unref()
}

/* ───────── 查詢 ───────── */

const toKey = (d) => String(d ?? '').replace(/\D/g, '').slice(0, 8)

/** 期間內的事件（from / to：'yyyy/MM/dd'，可帶 HH:mm） */
export function eventsInRange(from, to) {
  const a = toKey(from)
  const b = toKey(to) || a
  const fromT = String(from ?? '').length > 10 ? from : ''
  const toT = String(to ?? '').length > 10 ? `${to}:59` : ''
  const out = []
  for (const f of fs.readdirSync(config.ad.dataDir)) {
    const day = f.slice(0, 8)
    if (!/^\d{8}\.json$/.test(f) || day < a || day > b) continue
    for (const e of readDay(day)?.events ?? []) if ((!fromT || e.time >= fromT) && (!toT || e.time <= toT)) out.push(e)
  }
  return out.sort((x, y) => y.time.localeCompare(x.time))
}

export const adSummary = (from, to) => summarizeAd(eventsInRange(from, to))

/* ───────── 給 AI 的文字 ───────── */

const AD_RE = /\bAD\b|網域|\bDC\b|GSMC-DC|帳號|帳戶|登入|登錄|鎖定|密碼|Kerberos|KDC|NETLOGON|LDAP|DNS|群組|稽核|事件|event\s*id|目錄服務|網域控制站|特權|管理員|admin/i

/** 問題是否和 AD 有關 */
export const isAdQuestion = (q) => AD_RE.test(String(q ?? ''))

/** 問題中的事件 ID（4 位數、前後有「事件 / ID / EventID」或在常見範圍） */
export function eventIdsIn(q) {
  const s = String(q ?? '')
  const ids = new Set()
  for (const m of s.matchAll(/(?:事件|event\s*id|eventid|id)\s*[:：#]?\s*(\d{1,5})/gi)) ids.add(Number(m[1]))
  for (const m of s.matchAll(/(?<![\d.])(4[67]\d\d|1102|5719|2089|2887|3041)(?![\d.])/g)) ids.add(Number(m[1]))
  return [...ids]
}

/** 問題中的帳號：工號（S094009 這類）、或「帳號 / 帳戶 / account」後面接的名稱 */
export function accountsIn(q) {
  const s = String(q ?? '')
  const out = new Set()
  for (const m of s.matchAll(/(?<![\w.])([A-Za-z]\d{6,7})(?![\w.])/g)) out.add(m[1])
  for (const m of s.matchAll(/(?:帳號|帳戶|account)\s*[:：]?\s*([A-Za-z][\w.$-]{1,30})/gi)) out.add(m[1])
  return [...out].slice(0, 5)
}

/**
 * 期間的 AD 事件 → 給 AI 的文字；沒有資料回傳 ''
 *   ips / eventIds / q：問題中的 IP、事件 ID，會另外列出符合的事件明細
 */
export function adContext(from, to, { ips = [], eventIds = [], accounts = [], full = true } = {}) {
  const events = eventsInRange(from, to)
  if (!events.length) return ''
  const s = summarizeAd(events, 20)
  const days = adDays().filter((d) => d.day >= from.slice(0, 10) && d.day <= to.slice(0, 10))
  // 多台 DC 時加總每台的 Security 筆數
  const secEmpty = days.length && days.every((d) => d.files.filter((f) => f.channel === 'Security').reduce((a, f) => a + (f.rows ?? 0), 0) === 0)
  const g = (x) => `- [${x.channel}] 事件 ${x.eventId}${x.name ? `（${x.name}）` : ''}｜${x.level}｜${x.n} 次｜${x.first.slice(5, 16)} ~ ${x.last.slice(5, 16)}｜${x.provider}｜${x.sample}`
  const lines = [
    `## AD 網域控制站事件記錄（${from.slice(0, 10)} ~ ${to.slice(0, 10)}，主機 ${[...new Set(events.map((e) => e.computer))].join('、')}）`,
    `- 共 ${s.total} 筆：${Object.entries(s.byChannel).map(([c, n]) => `${c} ${n}`).join('、')}；等級：${Object.entries(s.byLevel).map(([l, n]) => `${l} ${n}`).join('、')}`,
    secEmpty ? '- ⚠ Security（安全性）記錄是空的：登入成功 / 失敗、帳號鎖定、帳號與群組異動都沒有資料，無法判斷這類問題' : '',
    '\n### 需要注意的事件（錯誤、警告、登入失敗、帳號異動）',
    ...(s.issues.length ? s.issues.map(g) : ['（無）']),
  ]
  // 帳號與特權異動（建立帳號、加入特權群組…）：特權的排最前面
  if (s.accountChanges.length) {
    const created = new Set(s.accountChanges.filter((c) => c.eventId === 4720).map((c) => c.target))
    const backdoor = s.accountChanges.filter((c) => c.privileged && created.has(c.target))
    lines.push(
      `\n### 帳號與特權異動（共 ${s.accountChanges.length} 筆；加入 / 移出特權群組 ${s.privilegedChanges} 筆、建立帳號 ${s.accountsCreated} 筆）`,
      ...(backdoor.length ? [`- ⚠ 新建立的帳號隨即被加入特權群組（常見的入侵後門手法，需立即確認）：${backdoor.map((c) => `${c.target} → ${c.group}（${c.actor}，${c.time}）`).join('、')}`] : []),
      ...s.accountChanges.slice(0, 40).map((c) => `- ${c.time}｜${c.privileged ? '【特權】' : ''}${c.action}｜執行者 ${c.actor || '-'}｜對象 ${c.target || '-'}${c.group ? `｜群組 ${c.group}` : ''}`)
    )
  }
  if (s.privLogons.length) lines.push('\n### 特權登入（4672，已排除電腦帳戶與系統帳戶）', ...s.privLogons.slice(0, 20).map((x) => `- ${x.key}｜${x.n} 次`))
  if (full) lines.push('\n### 事件排行', ...s.events.slice(0, 15).map(g))
  if (s.failAccounts.length) lines.push('\n### 登入失敗 / 鎖定最多的帳號', ...s.failAccounts.slice(0, 15).map((x) => `- ${x.key}｜${x.n} 次`))
  if (s.failIps.length) lines.push('\n### 登入失敗最多的來源 IP', ...s.failIps.slice(0, 15).map((x) => `- ${x.key}｜${x.n} 次`))
  if (s.failReasons.length) lines.push('\n### 登入失敗的原因', ...s.failReasons.slice(0, 10).map((x) => `- ${x.key}｜${x.n} 次`))
  // 問題中的 IP / 事件 ID 的明細
  const acc = accounts.map((a) => a.toLowerCase())
  const match = events.filter(
    (e) =>
      (eventIds.length && eventIds.includes(e.eventId)) ||
      ips.some((ip) => (e.ip ?? '') === ip || e.message.includes(ip)) ||
      acc.some((a) => [e.account, e.actor, e.target].some((x) => String(x ?? '').toLowerCase() === a) || e.message.toLowerCase().includes(a))
  )
  const asked = [...ips, ...accounts.map((a) => `帳號 ${a}`), ...eventIds.map((i) => `事件 ${i}`)]
  if (asked.length && !match.length) lines.push(`\n### 與問題中的 ${asked.join('、')} 相關的事件\n（這段期間的 AD 事件中查無相關紀錄）`)
  if (match.length) {
    lines.push(
      `\n### 與問題中的 ${asked.join('、')} 相關的事件（共 ${match.length} 筆，列前 25 筆）`,
      ...match.slice(0, 25).map((e) => `- ${e.time}｜[${e.channel}] ${e.eventId}｜${e.level}${e.account ? `｜帳號 ${e.account}` : ''}${e.ip ? `｜IP ${e.ip}` : ''}${e.reason ? `｜原因 ${e.reason}` : ''}｜${e.message.replace(/\s+/g, ' ').slice(0, 400)}`)
    )
  }
  return lines.filter(Boolean).join('\n')
}

export function searchAd(from, to, filters = {}, limit = 2000) {
  const all = eventsInRange(from, to)
  const test = buildAdFilter(filters)
  const rows = all.filter(test)
  return { total: rows.length, scanned: all.length, rows: rows.slice(0, limit), limited: rows.length > limit }
}
