import readline from 'node:readline'
import zlib from 'node:zlib'

/**
 * PA 防火牆 log（PAN-OS WebUI 匯出的 CSV，第一列為欄位名稱）
 * 依欄位名稱對應，PAN-OS 版本不同、欄位順序改變也能讀
 */
const COLUMNS = {
  time: ['Receive Time', 'Generate Time', 'Time Generated'],
  type: ['Type'],
  subtype: ['Threat/Content Type', 'Content/Threat Type', 'Subtype'],
  src: ['Source address', 'Source Address'],
  dst: ['Destination address', 'Destination Address'],
  natSrc: ['NAT Source IP'],
  natDst: ['NAT Destination IP'],
  rule: ['Rule'],
  srcUser: ['Source User'],
  app: ['Application'],
  fromZone: ['Source Zone'],
  toZone: ['Destination Zone'],
  inIf: ['Inbound Interface'],
  outIf: ['Outbound Interface'],
  sport: ['Source Port'],
  dport: ['Destination Port'],
  natDport: ['NAT Destination Port'],
  proto: ['IP Protocol'],
  action: ['Action'],
  bytes: ['Bytes'],
  sent: ['Bytes Sent'],
  recv: ['Bytes Received'],
  packets: ['Packets'],
  start: ['Start Time'],
  elapsed: ['Elapsed Time (sec)'],
  category: ['Category', 'URL Category'],
  srcCountry: ['Source Country'],
  dstCountry: ['Destination Country'],
  endReason: ['Session End Reason'],
  appRisk: ['Risk of app'],
  appCategory: ['Category of app'],
  appSubcat: ['Subcategory of app'],
  appTech: ['Technology of app'],
  srcHost: ['Source Hostname'],
  dstHost: ['Destination Hostname'],
  threat: ['Threat/Content Name', 'Threat ID'],
  severity: ['Severity'],
  url: ['URL/Filename', 'URL'],
  description: ['Description'],
}

/** 明細查詢回傳的欄位（順序即畫面欄位順序） */
export const ROW_FIELDS = [
  'time', 'subtype', 'action', 'src', 'sport', 'dst', 'dport', 'proto', 'app', 'rule', 'fromZone', 'toZone',
  'srcUser', 'natSrc', 'natDst', 'bytes', 'sent', 'recv', 'packets', 'elapsed', 'endReason', 'category',
  'srcCountry', 'dstCountry', 'appRisk', 'threat', 'severity', 'url',
]

const NUMERIC = new Set(['bytes', 'sent', 'recv', 'packets', 'elapsed', 'sport', 'dport', 'natDport', 'appRisk'])

/** 一列 CSV → 欄位陣列（PAN-OS 欄位內有逗號時會用雙引號包住） */
export function splitCsv(line) {
  if (!line.includes('"')) return line.split(',')
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * 欄位名稱列 → { 欄位: index }
 * columns：自訂欄位對應（威脅 / URL / GlobalProtect 等其他類型的 log，lib/paevents.js），只要求有時間欄
 */
export function mapHeader(cols, columns = null) {
  const idx = new Map(cols.map((c, i) => [c.trim().toLowerCase(), i]))
  const map = {}
  for (const [key, names] of Object.entries(columns ?? COLUMNS)) {
    for (const n of names) {
      const i = idx.get(n.toLowerCase())
      if (i !== undefined) {
        map[key] = i
        break
      }
    }
  }
  if (map.time === undefined || (!columns && map.src === undefined && map.description === undefined)) return null
  return map
}

/** 欄位陣列 → 紀錄物件；numeric：要轉成數字的欄位 */
export function toRecord(cols, map, numeric = NUMERIC) {
  const r = {}
  for (const key in map) {
    const v = cols[map[key]] ?? ''
    r[key] = numeric.has(key) ? Number(v) || 0 : v
  }
  return r
}

export const isAllow = (action) => action === 'allow'

/**
 * 逐列讀取 log 串流；.gz 自動解壓
 * onRow(record, rawLine) 回傳 false 時停止讀取
 * prefilter(rawLine)：先用整列文字快速排除（例如不含查詢的 IP），不符合的列不拆欄位，掃描快很多
 * columns / numeric：其他類型 log 的欄位對應與數字欄位（預設是 TRAFFIC）
 */
export async function readLog(stream, name, onRow, { prefilter = null, columns = null, numeric = NUMERIC } = {}) {
  const input = /\.gz$/i.test(name) ? stream.pipe(zlib.createGunzip()) : stream
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  // 串流被中斷（destroy）只會發出 close、不會發出 end，readline 會一直等下去；這裡主動結束
  let streamError = null
  const end = () => rl.close()
  const fail = (err) => {
    streamError ??= err
    rl.close()
  }
  for (const s of new Set([stream, input])) {
    s.once('close', end)
    s.once('error', fail)
  }
  let map = null
  let bad = 0
  try {
    for await (let line of rl) {
      if (!line) continue
      if (!map) {
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1)
        map = mapHeader(splitCsv(line), columns)
        if (!map) throw Object.assign(new Error(`不是 PA 防火牆匯出的 CSV（第一列找不到 Receive Time${columns ? '' : ' / Source address'} 欄位）`), { status: 400 })
        continue
      }
      if (prefilter && !prefilter(line)) continue
      const cols = splitCsv(line)
      if (cols.length < 8) {
        bad++
        continue
      }
      if (onRow(toRecord(cols, map, numeric), line) === false) break
    }
  } finally {
    rl.close()
    for (const s of new Set([stream, input])) {
      s.off('close', end)
      s.off('error', fail)
    }
  }
  // 傳輸錯誤（FTP 斷線等）要讓呼叫端知道，不能當成檔案已讀完
  if (streamError) throw streamError
  return { bad, columns: map ? Object.keys(map) : [] }
}

/* ───────────── 摘要 ───────────── */

/** 摘要格式 / 研判邏輯的版本（4：加連線組合統計 flows）；改了 createSummary 就加 1，已分析的檔案會在下次同步時重新分析 */
export const SUMMARY_VERSION = 4

/** 計數器：key → [次數, 位元組]；結束時只留前 N 名（依次數與依位元組各取一次） */
class Counter {
  constructor() {
    this.m = new Map()
  }
  add(key, bytes = 0) {
    if (key === '' || key === undefined) return
    const v = this.m.get(key)
    if (v) {
      v[0]++
      v[1] += bytes
    } else this.m.set(key, [1, bytes])
  }
  top(n = 300, withBytes = false) {
    const all = [...this.m.entries()].map(([k, [c, b]]) => [k, c, b])
    const byCount = all.sort((a, b) => b[1] - a[1]).slice(0, n)
    if (!withBytes) return byCount
    const keys = new Set(byCount.map((x) => x[0]))
    for (const x of all.sort((a, b) => b[2] - a[2]).slice(0, n)) if (!keys.has(x[0])) byCount.push(x)
    return byCount
  }
}

const TOP_KEYS = ['src', 'dst', 'dport', 'app', 'rule', 'zone', 'srcCountry', 'dstCountry', 'user', 'category',
  'blockSrc', 'blockDst', 'blockDport', 'blockRule', 'inboundBlockSrc', 'inboundAllow', 'riskApp', 'endReason', 'srcHost',
  // 資料外流：內部 → 公網的上傳（送出位元組）；高風險管道（檔案分享、雲端儲存、加密通道、郵件、遠端存取、即時通訊、P2P）
  'upSrc', 'upDst', 'upRiskSrc', 'upRiskPair', 'upRiskApp',
  // AI 應用（PA App-ID 子分類 artificial-intelligence）
  'aiSrc', 'aiPair', 'aiApp']
const BYTES_KEYS = new Set(['src', 'dst', 'app', 'dport', 'zone', 'dstCountry', 'user', 'upSrc', 'upDst', 'upRiskSrc', 'upRiskPair', 'upRiskApp', 'aiSrc', 'aiPair', 'aiApp'])

/** 高風險的上傳管道（PA App-ID 子分類）；ssl / web-browsing 是一般上網，只算在「上傳到外部」不算高風險管道 */
const RISK_UPLOAD_SUBCATS = new Set(['file-sharing', 'storage-backup', 'encrypted-tunnel', 'email', 'remote-access', 'instant-messaging'])
const GENERIC_APPS = new Set(['ssl', 'web-browsing', 'incomplete', 'insufficient-data', 'not-applicable', 'unknown-tcp', 'unknown-udp'])
const isRiskyUpload = (r) => !GENERIC_APPS.has(r.app) && (RISK_UPLOAD_SUBCATS.has(r.appSubcat) || r.appTech === 'peer-to-peer')
/** AI 應用：App-ID 子分類，log 沒有子分類欄位時用 App 名稱判斷 */
const AI_APP_RE = /openai|chatgpt|claude|anthropic|gemini|bard|copilot|bing-ai|perplexity|deepseek|mistral|huggingface|grok|qwen|tongyi|doubao|ernie|kimi|midjourney/i
const isAiApp = (r) => r.appSubcat === 'artificial-intelligence' || AI_APP_RE.test(r.app)

/** 私有 / 保留位址（10/8、172.16/12、192.168/16、100.64/10、127/8、169.254/16、IPv6 ULA / link-local） */
export function isPrivateIp(ip) {
  const s = String(ip)
  if (s.includes(':')) return /^(fc|fd|fe80|::1)/i.test(s)
  const [a, b] = s.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
}
/** 來源區域是 WAN 類、而且來源是公網 IP 才算「外部連入」（WAN 區域也會有其他廠區的內部 IP） */
const WAN_ZONE = /wan|untrust|internet|outside/i
const isInbound = (r) => WAN_ZONE.test(r.fromZone) && r.src && !isPrivateIp(r.src)
/** 風險 ≥ 4 的常見基礎應用（一般上網、更新），不列入高風險應用排行 */
const COMMON_RISK_APPS = new Set(['ssl', 'web-browsing', 'google-base', 'ms-update', 'dns-base', 'apple-update', 'windows-azure-base'])

/** 被擋次數多、而且目標很分散的來源（疑似掃描）：記住不同目的 IP 與 Port（各最多 1000 個） */
const SCAN_CAP = 1000
const SCAN_SOURCES = 50000

export function createSummary() {
  const top = Object.fromEntries(TOP_KEYS.map((k) => [k, new Counter()]))
  const hours = {}
  const actions = {}
  const subtypes = {}
  const days = {}
  const scan = new Map()
  const s = { rows: 0, allow: 0, block: 0, bytes: 0, sent: 0, recv: 0, timeMin: '', timeMax: '' }

  function add(r) {
    s.rows++
    const t = r.time
    if (t) {
      if (!s.timeMin || t < s.timeMin) s.timeMin = t
      if (!s.timeMax || t > s.timeMax) s.timeMax = t
    }
    const allow = isAllow(r.action)
    const bytes = r.bytes || 0
    s.bytes += bytes
    s.sent += r.sent || 0
    s.recv += r.recv || 0
    if (allow) s.allow++
    else s.block++
    actions[r.action || '(空白)'] = (actions[r.action || '(空白)'] ?? 0) + 1
    if (r.subtype) subtypes[r.subtype] = (subtypes[r.subtype] ?? 0) + 1

    const hourKey = t.slice(0, 13) // yyyy/MM/dd HH
    if (hourKey) {
      const h = (hours[hourKey] ??= { n: 0, allow: 0, block: 0, bytes: 0 })
      h.n++
      h.bytes += bytes
      if (allow) h.allow++
      else h.block++
      const d = t.slice(0, 10)
      days[d] = (days[d] ?? 0) + 1
    }

    const port = r.dport ? `${r.proto || '?'}/${r.dport}` : r.proto || ''
    const zone = r.fromZone || r.toZone ? `${r.fromZone || '?'} → ${r.toZone || '?'}` : ''
    top.src.add(r.src, bytes)
    top.dst.add(r.dst, bytes)
    top.dport.add(port, bytes)
    top.app.add(r.app, bytes)
    top.rule.add(r.rule)
    top.zone.add(zone, bytes)
    top.srcCountry.add(r.srcCountry)
    top.dstCountry.add(r.dstCountry, bytes)
    top.user.add(r.srcUser, bytes)
    top.category.add(r.category)
    top.endReason.add(r.endReason)
    top.srcHost.add(r.srcHost)
    if (r.appRisk >= 4 && allow && !COMMON_RISK_APPS.has(r.app)) top.riskApp.add(`${r.app}（風險 ${r.appRisk}）`, bytes)

    // 資料外流：內部 IP → 公網 IP、允許的連線，依送出（上傳）的位元組
    if (allow && r.src && r.dst && isPrivateIp(r.src) && !isPrivateIp(r.dst)) {
      const sent = r.sent || 0
      top.upSrc.add(r.src, sent)
      top.upDst.add(`${r.dst}${r.dstCountry ? `（${r.dstCountry}）` : ''}`, sent)
      if (isRiskyUpload(r)) {
        top.upRiskSrc.add(r.src, sent)
        top.upRiskPair.add(`${r.src} → ${r.app}`, sent)
        top.upRiskApp.add(`${r.app}（${r.appSubcat || r.appTech}）`, sent)
      }
    }
    // AI 應用（允許的連線），位元組也用送出（上傳到 AI 的資料量）
    if (allow && isAiApp(r)) {
      top.aiSrc.add(r.src, r.sent || 0)
      top.aiPair.add(`${r.src} → ${r.app}`, r.sent || 0)
      top.aiApp.add(r.app, r.sent || 0)
    }

    const inbound = isInbound(r)
    if (allow) {
      if (inbound) top.inboundAllow.add(`${r.src} → ${r.dst}:${port}`)
    } else {
      top.blockSrc.add(r.src)
      top.blockDst.add(r.dst)
      top.blockDport.add(port)
      top.blockRule.add(r.rule)
      if (inbound) top.inboundBlockSrc.add(`${r.src}${r.srcCountry ? `（${r.srcCountry}）` : ''}`)
      let sc = scan.get(r.src)
      if (!sc && scan.size < SCAN_SOURCES) scan.set(r.src, (sc = { n: 0, dsts: new Set(), ports: new Set(), zone }))
      if (sc) {
        sc.n++
        if (sc.dsts.size < SCAN_CAP) sc.dsts.add(r.dst)
        if (sc.ports.size < SCAN_CAP) sc.ports.add(port)
      }
    }
  }

  function result() {
    const dayList = Object.entries(days).sort((a, b) => b[1] - a[1])
    return {
      ...s,
      day: dayList[0]?.[0] ?? '',
      days,
      hours,
      actions,
      subtypes,
      top: Object.fromEntries(TOP_KEYS.map((k) => [k, top[k].top(300, BYTES_KEYS.has(k))])),
      scan: [...scan.entries()]
        .map(([src, v]) => [src, v.n, v.dsts.size, v.ports.size, v.zone])
        .filter((x) => x[2] >= 20 || x[3] >= 20)
        .sort((a, b) => Math.max(b[2], b[3]) - Math.max(a[2], a[3]))
        .slice(0, 200),
    }
  }

  return { add, result }
}

/** 合併多個檔案的摘要（總覽頁） */
export function mergeSummaries(list, topN = 20) {
  const m = { files: list.length, rows: 0, allow: 0, block: 0, bytes: 0, sent: 0, recv: 0, timeMin: '', timeMax: '' }
  const hours = {}
  const actions = {}
  const subtypes = {}
  const tops = {}
  const scan = new Map()
  for (const s of list) {
    for (const k of ['rows', 'allow', 'block', 'bytes', 'sent', 'recv']) m[k] += s[k] || 0
    if (s.timeMin && (!m.timeMin || s.timeMin < m.timeMin)) m.timeMin = s.timeMin
    if (s.timeMax && (!m.timeMax || s.timeMax > m.timeMax)) m.timeMax = s.timeMax
    for (const [h, v] of Object.entries(s.hours ?? {})) {
      const t = (hours[h] ??= { n: 0, allow: 0, block: 0, bytes: 0 })
      t.n += v.n
      t.allow += v.allow
      t.block += v.block
      t.bytes += v.bytes
    }
    for (const [k, v] of Object.entries(s.actions ?? {})) actions[k] = (actions[k] ?? 0) + v
    for (const [k, v] of Object.entries(s.subtypes ?? {})) subtypes[k] = (subtypes[k] ?? 0) + v
    for (const [name, rows] of Object.entries(s.top ?? {})) {
      const t = (tops[name] ??= new Map())
      for (const [key, n, b] of rows) {
        const v = t.get(key)
        if (v) {
          v[0] += n
          v[1] += b
        } else t.set(key, [n, b])
      }
    }
    for (const [src, n, dsts, ports, zone] of s.scan ?? []) {
      const v = scan.get(src)
      if (v) {
        v[0] += n
        v[1] = Math.max(v[1], dsts)
        v[2] = Math.max(v[2], ports)
      } else scan.set(src, [n, dsts, ports, zone])
    }
  }
  const top = {}
  const topBytes = {}
  for (const [name, t] of Object.entries(tops)) {
    const all = [...t.entries()].map(([key, [n, b]]) => ({ key, n, bytes: b }))
    top[name] = [...all].sort((a, b) => b.n - a.n).slice(0, topN)
    if (BYTES_KEYS.has(name)) topBytes[name] = all.sort((a, b) => b.bytes - a.bytes).slice(0, topN)
  }
  return {
    ...m,
    hours: Object.entries(hours)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, v]) => ({ hour, ...v })),
    actions,
    subtypes,
    top,
    topBytes,
    scan: [...scan.entries()]
      .map(([src, [n, dsts, ports, zone]]) => ({ src, n, dsts, ports, zone }))
      .sort((a, b) => Math.max(b.dsts, b.ports) - Math.max(a.dsts, a.ports))
      .slice(0, 50),
  }
}

/* ───────────── 明細查詢的條件 ───────────── */

const ipToInt = (ip) => {
  const p = String(ip).split('.')
  if (p.length !== 4) return null
  let n = 0
  for (const x of p) {
    const v = Number(x)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** IP 條件：192.168.1.10（完全相同）、10.10.*（萬用字元）、10.10.0.0/16（CIDR）、IPv6 以字首比對 */
export function ipMatcher(pattern) {
  const p = String(pattern ?? '').trim()
  if (!p) return null
  if (p.includes('/')) {
    const [base, bits] = p.split('/')
    const b = ipToInt(base)
    const len = Number(bits)
    if (b === null || !(len >= 0 && len <= 32)) return (ip) => ip.startsWith(base)
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0
    const net = (b & mask) >>> 0
    return (ip) => {
      const v = ipToInt(ip)
      return v !== null && ((v & mask) >>> 0) === net
    }
  }
  if (p.includes('*')) {
    const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return (ip) => re.test(ip)
  }
  return (ip) => ip === p
}

/**
 * IP 條件 → 整列文字一定會包含的字串（用來快速排除）；萬用字元 / 不足 8 位元的 CIDR 無法判斷時回傳 ''
 * 例：10.10.112.1 → '10.10.112.1'、10.10.0.0/16 → '10.10.'、10.10.124.* → '10.10.124.'
 */
export function ipNeedle(pattern) {
  const p = String(pattern ?? '').trim()
  if (!p) return ''
  if (p.includes('/')) {
    const [base, bits] = p.split('/')
    const octets = Math.floor(Number(bits) / 8)
    return octets >= 1 && /^\d+(\.\d+){3}$/.test(base) ? base.split('.').slice(0, octets).join('.') + (octets < 4 ? '.' : '') : ''
  }
  if (p.includes('*')) return p.slice(0, p.indexOf('*'))
  return p
}

/**
 * 篩選條件 → 整列文字的快速排除函式；沒有可用的條件回傳 null
 * 每一組（src / dst / ip / q）都必須出現在該列，任一組不出現就不可能符合
 */
export function buildPrefilter(f = {}) {
  const groups = []
  for (const k of ['src', 'dst', 'ip']) {
    const n = ipNeedle(f[k])
    if (n) groups.push(n)
  }
  const q = String(f.q ?? '').trim().toLowerCase()
  const tests = groups.map((n) => (line) => line.includes(n))
  if (q) tests.push((line) => line.toLowerCase().includes(q))
  return tests.length ? (line) => tests.every((t) => t(line)) : null
}

const textMatcher = (v) => {
  const p = String(v ?? '').trim().toLowerCase()
  return p ? (x) => String(x ?? '').toLowerCase() === p : null
}
const containsMatcher = (v) => {
  const p = String(v ?? '').trim().toLowerCase()
  return p ? (x) => String(x ?? '').toLowerCase().includes(p) : null
}

/**
 * 篩選條件 → (record, rawLine) => boolean
 * f: { from, to, src, dst, ip, port, app, rule, action, fromZone, toZone, user, country, q }
 */
export function buildFilter(f = {}) {
  const tests = []
  const from = String(f.from ?? '').trim()
  const to = String(f.to ?? '').trim()
  if (from) tests.push((r) => r.time >= from)
  if (to) tests.push((r) => r.time <= to + (to.length <= 16 ? ':59' : ''))
  const src = ipMatcher(f.src)
  if (src) tests.push((r) => src(r.src) || (r.natSrc && src(r.natSrc)))
  const dst = ipMatcher(f.dst)
  if (dst) tests.push((r) => dst(r.dst) || (r.natDst && dst(r.natDst)))
  const ip = ipMatcher(f.ip)
  if (ip) tests.push((r) => ip(r.src) || ip(r.dst) || (r.natSrc && ip(r.natSrc)) || (r.natDst && ip(r.natDst)))
  const port = String(f.port ?? '').trim()
  if (port) {
    const ports = new Set(port.split(/[,\s]+/).filter(Boolean).map(Number))
    tests.push((r) => ports.has(r.dport))
  }
  const proto = textMatcher(f.proto)
  if (proto) tests.push((r) => proto(r.proto))
  const app = containsMatcher(f.app)
  if (app) tests.push((r) => app(r.app))
  const rule = containsMatcher(f.rule)
  if (rule) tests.push((r) => rule(r.rule))
  const fromZone = textMatcher(f.fromZone)
  if (fromZone) tests.push((r) => fromZone(r.fromZone))
  const toZone = textMatcher(f.toZone)
  if (toZone) tests.push((r) => toZone(r.toZone))
  const user = containsMatcher(f.user)
  if (user) tests.push((r) => user(r.srcUser))
  const country = containsMatcher(f.country)
  if (country) tests.push((r) => country(r.srcCountry) || country(r.dstCountry))
  const action = String(f.action ?? '').trim()
  if (action === 'allow') tests.push((r) => isAllow(r.action))
  else if (action === 'block') tests.push((r) => !isAllow(r.action))
  else if (action) tests.push((r) => r.action === action)
  const q = String(f.q ?? '').trim().toLowerCase()
  if (q) tests.push((r, raw) => raw.toLowerCase().includes(q))
  return tests.length ? (r, raw) => tests.every((t) => t(r, raw)) : () => true
}
