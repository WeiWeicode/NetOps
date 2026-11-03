/**
 * AD 網域控制站的事件記錄（DC 每天匯出到 FTP /AD_Log_Backup/yyyyMMdd/*.csv）
 *   Security.csv / System.csv / Directory_Service.csv / DNS_Server.csv
 *   欄位：TimeCreated, EventID, Level, Provider, Computer, RecordID, Message（Message 會跨行，用雙引號包住）
 */

/** 整段 CSV 文字 → 列陣列（支援欄位內換行、"" 跳脫） */
export function parseCsvText(text) {
  const rows = []
  let row = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur)
      if (row.length > 1 || row[0]) rows.push(row)
      row = []
      cur = ''
    } else cur += ch
  }
  if (cur || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows
}

/** 等級 → info / warning / error / critical / audit_success / audit_failure（中英文都認得） */
const LEVELS = [
  [/稽核失敗|audit failure/i, 'audit_failure'],
  [/稽核成功|audit success/i, 'audit_success'],
  [/重大|critical/i, 'critical'],
  [/錯誤|error/i, 'error'],
  [/警告|warning/i, 'warning'],
]
const levelOf = (s) => LEVELS.find(([re]) => re.test(s))?.[1] ?? 'info'

/** 檔名 → 記錄類別 */
export const CHANNELS = {
  Security: '安全性',
  System: '系統',
  Directory_Service: '目錄服務',
  DNS_Server: 'DNS 伺服器',
}
export const channelOf = (name) => Object.keys(CHANNELS).find((k) => name.toLowerCase().startsWith(k.toLowerCase())) ?? name.replace(/\.csv$/i, '')

/** 常見的 Security 事件（AI 與畫面說明用） */
export const SECURITY_EVENTS = {
  4624: '登入成功',
  4625: '登入失敗',
  4634: '登出',
  4648: '使用明確認證登入',
  4672: '特殊權限登入',
  4720: '建立使用者帳戶',
  4722: '啟用帳戶',
  4723: '使用者變更密碼',
  4724: '重設密碼',
  4725: '停用帳戶',
  4726: '刪除帳戶',
  4728: '加入全域安全群組',
  4732: '加入本機安全群組',
  4738: '帳戶已變更',
  4740: '帳戶被鎖定',
  4756: '加入萬用安全群組',
  4767: '帳戶解除鎖定',
  4768: 'Kerberos TGT 要求',
  4769: 'Kerberos 服務票證要求',
  4771: 'Kerberos 預先驗證失敗',
  4776: 'NTLM 認證',
  1102: '稽核記錄被清除',
}

/**
 * Message 中「標籤: 值」（中英文）
 * 同一個標籤出現多次時：預設取最後一個有意義的值（4625 的「登入失敗的帳戶」、4720 的「新帳戶」、4728 的「成員」）；first = true 取第一個（「主體」= 執行者）
 */
function field(msg, labels, first = false) {
  const re = new RegExp(`(?:${labels.join('|')})\\s*[:：]\\s*([^\\r\\n]*)`, 'gi')
  let val = ''
  for (const m of msg.matchAll(re)) {
    const v = m[1].trim()
    if (v && v !== '-' && v !== 'NULL SID' && !/^0x0$/i.test(v)) {
      val = v
      if (first) break
    }
  }
  return val
}

/** 帳號 / 群組異動的事件 → 動作說明 */
export const ACCOUNT_CHANGES = {
  4720: '建立帳號',
  4722: '啟用帳號',
  4725: '停用帳號',
  4726: '刪除帳號',
  4724: '重設密碼',
  4738: '帳號屬性變更',
  4781: '帳號改名',
  4767: '解除鎖定',
  4741: '建立電腦帳戶',
  4743: '刪除電腦帳戶',
  4727: '建立全域安全群組',
  4731: '建立本機安全群組',
  4754: '建立萬用安全群組',
  4728: '加入全域安全群組',
  4729: '移出全域安全群組',
  4732: '加入本機安全群組',
  4733: '移出本機安全群組',
  4756: '加入萬用安全群組',
  4757: '移出萬用安全群組',
  4704: '指派使用者權限',
  4794: '設定 DSRM 系統管理員密碼',
}
const GROUP_EVENTS = new Set([4727, 4731, 4754, 4728, 4729, 4732, 4733, 4756, 4757])

/** 特權群組（加入 / 移出這些群組要特別注意）；中文版 Windows 的內建群組名稱也列入 */
const PRIV_GROUP_RE =
  /^(domain admins|enterprise admins|schema admins|administrators|account operators|backup operators|server operators|print operators|dnsadmins|group policy creator owners|enterprise key admins|key admins|cert publishers|remote desktop users|網域管理員|企業系統管理員|結構描述管理員|系統管理員|帳戶操作員|備份操作員|伺服器操作員|列印操作員)$/i
export const isPrivGroup = (g) => PRIV_GROUP_RE.test(String(g ?? '').replace(/^.*\\/, '').trim())

/** Kerberos（4771 / 4768）錯誤碼 → 原因 */
const KERBEROS_CODES = {
  '0x6': '帳號不存在',
  '0x12': '帳號已停用 / 鎖定 / 過期',
  '0x17': '密碼已過期',
  '0x18': '密碼錯誤',
  // Kerberos 以 UTC 比對；時間與時區都正確仍出現時，多半是該主機的網域服務用了過期的認證在重試
  '0x25': 'Kerberos 回報時間差（時鐘 / 時區；若時間正確，請檢查該主機的網域連線狀態）',
  '0x20': '票證已過期',
}

/** 登入失敗（4625 / 4776）的狀態碼 → 原因 */
const NT_STATUS = {
  '0xc000006a': '密碼錯誤',
  '0xc0000064': '帳號不存在',
  '0xc0000234': '帳號已鎖定',
  '0xc0000072': '帳號已停用',
  '0xc0000193': '帳號已過期',
  '0xc0000071': '密碼已過期',
  '0xc0000224': '下次登入須變更密碼',
  '0xc000006f': '不在允許登入的時間',
  '0xc0000070': '不允許從此工作站登入',
  '0xc000015b': '未授與此登入類型',
  '0xc000006d': '使用者名稱或密碼錯誤',
  '0xc0000133': '與 DC 時間不同步',
}

/**
 * 讀取時補齊衍生欄位（舊資料不必重新匯入）：
 *   Kerberos 失敗沒有「失敗原因」，改由錯誤碼換成中文；登入失敗只有狀態碼時也換成中文
 */
export function enrichEvent(e) {
  if (/^0x[0-9a-f]+$/i.test(e.reason ?? '')) {
    const code = e.reason.toLowerCase()
    if (NT_STATUS[code]) e.reason = `${NT_STATUS[code]}（${e.reason}）`
  }
  if (!e.reason && (e.eventId === 4771 || e.eventId === 4768)) {
    const code = String(e.message.match(/(?:錯誤碼|失敗碼|Failure Code|Result Code)\s*[:：]\s*(0x[0-9a-f]+)/i)?.[1] ?? '').toLowerCase()
    if (code) e.reason = KERBEROS_CODES[code] ? `${KERBEROS_CODES[code]}（${code}）` : code
  }
  return e
}

/** CN=王小明,OU=… → 王小明 */
const cnName = (v) => String(v ?? '').match(/^CN=([^,]+)/i)?.[1] ?? v

/** 一列 → 事件；Security 事件另外抓帳戶、來源 IP、工作站、失敗原因 */
export function toEvent(cols, map, channel) {
  const g = (k) => (map[k] === undefined ? '' : String(cols[map[k]] ?? '').trim())
  const message = g('message').replace(/[‎‏]/g, '').replace(/\r/g, '')
  const ev = {
    time: g('time').replace(/-/g, '/').replace('T', ' ').slice(0, 19),
    eventId: Number(g('eventId')) || 0,
    level: levelOf(g('level')),
    levelText: g('level'),
    provider: g('provider'),
    computer: g('computer'),
    recordId: g('recordId'),
    channel,
    message: message.slice(0, 3000),
  }
  if (channel === 'Security' || /^4[67]\d\d$|^1102$/.test(String(ev.eventId))) {
    ev.account = field(message, ['帳戶名稱', 'Account Name', '目標帳戶名稱'])
    ev.domain = field(message, ['帳戶網域', 'Account Domain'])
    ev.ip = field(message, ['來源網路位址', 'Source Network Address', '用戶端位址', 'Client Address']).replace(/^::ffff:/i, '')
    ev.workstation = field(message, ['工作站名稱', 'Workstation Name', '來源工作站', 'Caller Computer Name'])
    // 4625 同時有「失敗原因」（文字）與「狀態 / 子狀態」（代碼），優先用文字
    ev.reason = field(message, ['失敗原因', 'Failure Reason']) || field(message, ['子狀態', 'Sub Status']) || field(message, ['狀態', 'Status'])
    // 帳號 / 群組異動：誰（主體）對誰（新帳戶 / 目標帳戶 / 成員）做了什麼、哪個群組
    if (ACCOUNT_CHANGES[ev.eventId] || ev.eventId === 4672) {
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = cnName(field(message, ['帳戶名稱', 'Account Name']))
      if (GROUP_EVENTS.has(ev.eventId)) {
        ev.group = field(message, ['群組名稱', 'Group Name'])
        ev.privileged = isPrivGroup(ev.group)
      }
      ev.account = ev.target || ev.account
    }
  }
  return ev
}

const HEADERS = {
  time: ['TimeCreated', 'Date and Time', '日期和時間'],
  eventId: ['EventID', 'Event ID', 'Id', '事件識別碼'],
  level: ['Level', 'LevelDisplayName', '層級'],
  provider: ['Provider', 'ProviderName', 'Source', '來源'],
  computer: ['Computer', 'MachineName', '電腦'],
  recordId: ['RecordID', 'RecordId'],
  message: ['Message', '訊息', 'Task Category'],
}

/** CSV 文字 → 事件陣列 */
export function parseAdCsv(text, fileName) {
  const rows = parseCsvText(text.replace(/^﻿/, ''))
  if (!rows.length) return []
  const idx = new Map(rows[0].map((h, i) => [h.trim().toLowerCase(), i]))
  const map = {}
  for (const [k, names] of Object.entries(HEADERS)) {
    for (const n of names) {
      if (idx.has(n.toLowerCase())) {
        map[k] = idx.get(n.toLowerCase())
        break
      }
    }
  }
  if (map.time === undefined || map.eventId === undefined) throw new Error(`${fileName} 不是事件記錄匯出的 CSV（找不到 TimeCreated / EventID 欄位）`)
  const channel = channelOf(fileName)
  return rows.slice(1).filter((r) => r.length > 1).map((r) => toEvent(r, map, channel))
}

/* ───────── 統計 ───────── */

const ISSUE = new Set(['warning', 'error', 'critical', 'audit_failure'])
export const isIssue = (e) => ISSUE.has(e.level) || [4625, 4740, 4771, 1102].includes(e.eventId) || Boolean(ACCOUNT_CHANGES[e.eventId])

/** 訊息的第一行（去掉數字讓同類訊息歸在一起） */
const msgKey = (m) => String(m).split('\n')[0].slice(0, 120)

/** 事件陣列 → 統計（總覽與 AI 用） */
export function summarizeAd(events, topN = 30) {
  const s = { total: events.length, byChannel: {}, byLevel: {}, hours: {}, timeMin: '', timeMax: '' }
  const groups = new Map()
  const fail = { accounts: new Map(), ips: new Map(), reasons: new Map(), reasonDetail: new Map() }
  const changes = [] // 帳號 / 群組異動（建立帳號、加入特權群組…）
  const privLogons = new Map() // 4672 特權登入：帳號 → 次數
  for (const e of events) {
    if (ACCOUNT_CHANGES[e.eventId]) {
      changes.push({ time: e.time, eventId: e.eventId, action: ACCOUNT_CHANGES[e.eventId], actor: e.actor ?? '', target: e.target ?? '', group: e.group ?? '', privileged: Boolean(e.privileged), computer: e.computer, recordId: e.recordId })
    }
    // 電腦帳戶（xxx$）與系統帳戶的特權登入是常態，不列入
    if (e.eventId === 4672 && e.actor && !/\$$|^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(e.actor)) privLogons.set(e.actor, (privLogons.get(e.actor) ?? 0) + 1)
    s.byChannel[e.channel] = (s.byChannel[e.channel] ?? 0) + 1
    s.byLevel[e.level] = (s.byLevel[e.level] ?? 0) + 1
    if (!s.timeMin || e.time < s.timeMin) s.timeMin = e.time
    if (!s.timeMax || e.time > s.timeMax) s.timeMax = e.time
    const h = (s.hours[e.time.slice(0, 13)] ??= { n: 0, issue: 0 })
    h.n++
    if (isIssue(e)) h.issue++
    const key = `${e.channel}|${e.eventId}|${e.level}|${e.provider}`
    const g = groups.get(key) ?? { channel: e.channel, eventId: e.eventId, level: e.level, provider: e.provider, n: 0, first: e.time, last: e.time, sample: msgKey(e.message), computers: new Set() }
    g.n++
    if (e.time < g.first) g.first = e.time
    if (e.time > g.last) g.last = e.time
    g.computers.add(e.computer)
    groups.set(key, g)
    if ([4625, 4771, 4740].includes(e.eventId)) {
      if (e.account) fail.accounts.set(e.account, (fail.accounts.get(e.account) ?? 0) + 1)
      if (e.ip) fail.ips.set(e.ip, (fail.ips.get(e.ip) ?? 0) + 1)
      if (e.reason) {
        fail.reasons.set(e.reason, (fail.reasons.get(e.reason) ?? 0) + 1)
        // 每個原因的來源 IP 與帳號（總覽頁顯示在原因下面）
        const d = fail.reasonDetail.get(e.reason) ?? { ips: new Map(), accounts: new Map() }
        if (e.ip) d.ips.set(e.ip, (d.ips.get(e.ip) ?? 0) + 1)
        if (e.account) d.accounts.set(e.account, (d.accounts.get(e.account) ?? 0) + 1)
        fail.reasonDetail.set(e.reason, d)
      }
    }
  }
  const all = [...groups.values()].map((g) => ({ ...g, computers: [...g.computers], name: g.channel === 'Security' ? SECURITY_EVENTS[g.eventId] ?? '' : '' }))
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([key, n]) => ({ key, n }))
  return {
    ...s,
    hours: Object.entries(s.hours).sort((a, b) => a[0].localeCompare(b[0])).map(([hour, v]) => ({ hour, ...v })),
    events: all.sort((a, b) => b.n - a.n).slice(0, topN * 2),
    issues: all.filter((g) => isIssue(g)).sort((a, b) => b.n - a.n).slice(0, topN),
    failAccounts: top(fail.accounts),
    failIps: top(fail.ips),
    // 每個原因附上前 5 個來源 IP 與帳號
    failReasons: top(fail.reasons).map((x) => {
      const d = fail.reasonDetail.get(x.key)
      const top5 = (m) => [...(m ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, n]) => ({ key, n }))
      return { ...x, ips: top5(d?.ips), accounts: top5(d?.accounts) }
    }),
    // 特權群組異動排最前面，其次建立 / 刪除帳號、重設密碼，再依時間（新的在前）
    accountChanges: changes
      .sort((a, b) => Number(b.privileged) - Number(a.privileged) || Number([4720, 4726, 4724, 4794].includes(b.eventId)) - Number([4720, 4726, 4724, 4794].includes(a.eventId)) || b.time.localeCompare(a.time))
      .slice(0, 300),
    privilegedChanges: changes.filter((c) => c.privileged).length,
    accountsCreated: changes.filter((c) => c.eventId === 4720).length,
    privLogons: top(privLogons),
  }
}

/** 查詢條件 → (event) => boolean；f: { channel, level, eventId, q, account, ip, issueOnly } */
export function buildAdFilter(f = {}) {
  const tests = []
  if (f.channel) tests.push((e) => e.channel === f.channel)
  if (f.level) tests.push((e) => e.level === f.level)
  if (f.issueOnly) tests.push(isIssue)
  const ids = String(f.eventId ?? '').split(/[,\s]+/).filter(Boolean).map(Number)
  if (ids.length) tests.push((e) => ids.includes(e.eventId))
  for (const k of ['account', 'ip']) {
    const v = String(f[k] ?? '').trim().toLowerCase()
    if (v) tests.push((e) => String(e[k] ?? '').toLowerCase().includes(v) || e.message.toLowerCase().includes(v))
  }
  const q = String(f.q ?? '').trim().toLowerCase()
  if (q) tests.push((e) => `${e.message}\n${e.provider}\n${e.eventId}`.toLowerCase().includes(q))
  return (e) => tests.every((t) => t(e))
}
