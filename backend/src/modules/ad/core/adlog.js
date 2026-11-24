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

/** 常見的 Security 事件（AI 與畫面說明用；含 AD-6 §9.2、§9.3 新增事件） */
export const SECURITY_EVENTS = {
  1100: '事件記錄服務被關閉',
  1102: '稽核記錄被清除',
  1104: 'Security Log 已滿',
  4616: '系統時間被變更',
  4624: '登入成功',
  4625: '登入失敗',
  4634: '登出',
  4648: '使用明確認證登入',
  4662: '目錄物件作業（DCSync 複寫權限）',
  4672: '特殊權限登入',
  4697: '安裝服務',
  4698: '建立排程工作',
  4699: '刪除排程工作',
  4700: '啟用排程工作',
  4701: '停用排程工作',
  4702: '更新排程工作',
  4704: '指派使用者權限',
  4706: '建立網域信任關係',
  4707: '移除網域信任關係',
  4713: 'Kerberos 原則變更',
  4716: '修改網域信任資訊',
  4719: '系統稽核原則被變更',
  4720: '建立使用者帳戶',
  4722: '啟用帳戶',
  4723: '使用者自行變更密碼',
  4724: '重設密碼',
  4725: '停用帳戶',
  4726: '刪除帳戶',
  4727: '建立全域安全群組',
  4728: '加入全域安全群組',
  4729: '移出全域安全群組',
  4730: '刪除全域安全群組',
  4731: '建立本機安全群組',
  4732: '加入本機安全群組',
  4733: '移出本機安全群組',
  4734: '刪除本機安全群組',
  4735: '變更本機安全群組',
  4737: '變更全域安全群組',
  4738: '帳戶已變更',
  4739: '網域原則變更',
  4740: '帳戶被鎖定',
  4741: '建立電腦帳戶',
  4742: '變更電腦帳戶',
  4743: '刪除電腦帳戶',
  4754: '建立萬用安全群組',
  4755: '變更萬用安全群組',
  4756: '加入萬用安全群組',
  4757: '移出萬用安全群組',
  4758: '刪除萬用安全群組',
  4765: '新增 SID History 成功',
  4766: '新增 SID History 失敗',
  4767: '帳戶解除鎖定',
  4768: 'Kerberos TGT 要求',
  4769: 'Kerberos 服務票證要求',
  4771: 'Kerberos 預先驗證失敗',
  4776: 'NTLM 認證',
  4780: 'AdminSDHolder 套用到管理員帳號',
  4781: '帳戶改名',
  4794: '設定 DSRM 系統管理員密碼',
  5136: '目錄服務物件變更（GPO / AdminSDHolder）',
}

/** 常見的 System 事件（AD-6 §9.1） */
export const SYSTEM_EVENTS = {
  41: '系統未正常關機即重新啟動（Kernel-Power）',
  104: '系統事件記錄被清除',
  1074: '系統正常關機或重新啟動',
  6006: '事件記錄服務已停止',
  6008: '系統發生非預期關機',
  7045: '系統安裝新服務',
}

/** 常見的 Directory Service 事件（AD-6 §9.1） */
export const DIRECTORY_SERVICE_EVENTS = {
  1388: '偵測到 AD 複寫中的殘留物件（Lingering Object）',
  1645: 'AD 無法執行目錄複寫（SPN / 驗證問題）',
  1864: 'AD 複寫長期未同步',
  1988: 'AD 複寫因殘留物件而被封鎖',
  2042: 'AD 複寫超過邏輯刪除存留期（Tombstone）',
  2092: 'DC 無法成為 FSMO 操作主機（連線失敗）',
  2887: '未簽署或明文 LDAP 繫結彙總',
  2889: '用戶端執行未簽署的 LDAP 繫結',
}

/** 常見的 DNS Server 事件（AD-6 §9.1） */
export const DNS_SERVER_EVENTS = {
  4000: 'DNS 伺服器無法開啟 Active Directory',
  4004: 'DNS 伺服器無法完成 AD 區域列舉',
  4015: 'DNS 伺服器發生嚴重的 Active Directory 錯誤',
}

/** 各記錄類別的事件名稱對照表 */
export const CHANNEL_EVENTS = {
  Security: SECURITY_EVENTS,
  System: SYSTEM_EVENTS,
  Directory_Service: DIRECTORY_SERVICE_EVENTS,
  DNS_Server: DNS_SERVER_EVENTS,
}

/** 依記錄類別與 Event ID 取得事件中文名稱 */
export const eventName = (channel, eventId) => CHANNEL_EVENTS[channel]?.[eventId] ?? ''

/** AD-6 §9.2、§9.3 新增 Security 事件的用途與風險說明 */
export const EVENT_DESCRIPTIONS = {
  1100: '事件記錄服務被關閉（防禦規避）',
  1104: 'Security Log 已滿（和 wrapRisk 呼應）',
  4616: '系統時間被變更（已排除 LOCAL SERVICE / W32Time 正常校時）',
  4662: '對目錄物件要求 DCSync 複寫權限（已排除電腦帳號）',
  4697: '安裝服務（與 System 7045 互相佐證，DC 上出現需留意）',
  4698: '建立排程工作（持久化手法）',
  4699: '刪除排程工作（持久化手法）',
  4700: '啟用排程工作（持久化手法）',
  4701: '停用排程工作（持久化手法）',
  4702: '更新排程工作（持久化手法）',
  4706: '建立網域信任關係',
  4707: '移除網域信任關係',
  4713: 'Kerberos 原則變更（票券時效等設定被修改）',
  4716: '修改網域信任資訊',
  4719: '系統稽核原則被變更（防禦規避）',
  4723: '使用者自行變更密碼（與 4724 管理員重設區分）',
  4730: '刪除全域安全群組',
  4734: '刪除本機安全群組',
  4735: '變更本機安全群組',
  4737: '變更全域安全群組',
  4739: '網域原則變更（密碼原則等被修改）',
  4741: '建立電腦帳戶（留意機器帳號濫用 / RBCD / noPac）',
  4742: '變更電腦帳戶（留意機器帳號濫用 / RBCD / noPac）',
  4743: '刪除電腦帳戶',
  4755: '變更萬用安全群組',
  4758: '刪除萬用安全群組',
  4765: '新增 SID History 成功（正常不會出現，高度警戒）',
  4766: '新增 SID History 失敗（正常不會出現，高度警戒）',
  4768: 'Kerberos TGT 要求失敗或使用 RC4 弱加密（0x17）',
  4769: 'Kerberos 服務票證要求使用弱加密（0x17 / 0x18，潛在 Kerberoasting）',
  4780: 'AdminSDHolder 套用到管理員帳號（特權帳號佐證）',
  5136: 'GPO（groupPolicyContainer）或 CN=AdminSDHolder 目錄物件被修改',
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

/** 帳號 / 群組異動的事件 → 動作說明（與 migrations/005 ad_heat_*_mv 的 account_changes 保持一致；AD-6 新增異動事件是否納進 MV 須由需求方另核准 migration） */
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
/** AD-6 新增、需比照 ACCOUNT_CHANGES 解析主體 / 對象 / 群組欄位的事件（不更動既有 MV 清單） */
const AD6_ACCOUNT_GROUP_EVENTS = new Set([4723, 4742, 4735, 4737, 4755, 4730, 4734, 4758, 4765, 4766, 4780])
const GROUP_EVENTS = new Set([4727, 4731, 4754, 4735, 4737, 4755, 4730, 4734, 4758, 4728, 4729, 4732, 4733, 4756, 4757])
const GROUP_ONLY_EVENTS = new Set([4735, 4737, 4755, 4730, 4734, 4758])

/** Kerberos 票證加密類型（4768 / 4769） */
const TICKET_ENC_TYPES = {
  '0x1': 'DES-CBC-CRC',
  '0x3': 'DES-CBC-MD5',
  '0x11': 'AES128-CTS-HMAC-SHA1',
  '0x12': 'AES256-CTS-HMAC-SHA1',
  '0x17': 'RC4-HMAC',
  '0x18': 'RC4-HMAC-EXP',
}
const WEAK_ENC_TYPES = new Set(['0x1', '0x3', '0x17', '0x18'])

/** 4624 登入類型（常見值） */
const LOGON_TYPES = {
  2: '互動式',
  3: '網路',
  4: '批次',
  5: '服務',
  7: '解鎖',
  8: '網路明文',
  9: '新認證',
  10: 'RDP 遠端互動',
  11: '快取互動',
}

/** 4662 DCSync 複寫權限 GUID → 權限名稱（AD-6 §9.3） */
const DCSYNC_GUID_NAMES = [
  ['1131f6aa-9c07-11d1-f79f-00c04fc2dcd2', 'DS-Replication-Get-Changes'],
  ['1131f6ad-9c07-11d1-f79f-00c04fc2dcd2', 'DS-Replication-Get-Changes-All'],
  ['89e95b76-444d-4c62-991a-0facbeda640c', 'DS-Replication-Get-Changes-In-Filtered-Set'],
]

function normalizeHex(raw) {
  const m = /^0x0*([0-9a-f]+)$/i.exec(String(raw ?? '').trim())
  return m ? `0x${m[1].toLowerCase()}` : String(raw ?? '').trim().toLowerCase()
}

function formatWeakEncryption(message) {
  const enc = field(message, ['票證加密類型', 'Ticket Encryption Type'])
  if (!enc) return ''
  const norm = normalizeHex(enc)
  if (!WEAK_ENC_TYPES.has(norm)) return ''
  const label = TICKET_ENC_TYPES[norm]
  return label ? `弱加密 ${label}（${norm}）` : `弱加密（${norm}）`
}

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
  if (e.eventId === 4771 || e.eventId === 4768 || e.eventId === 4769) {
    if (!e.reason) {
      const code = normalizeHex(e.message.match(/(?:錯誤碼|失敗碼|結果碼|Failure Code|Result Code)\s*[:：]\s*(0x[0-9a-f]+)/i)?.[1] ?? '')
      if (code && code !== '0x0') e.reason = KERBEROS_CODES[code] ? `${KERBEROS_CODES[code]}（${code}）` : code
    }
    if (e.eventId === 4768 || e.eventId === 4769) {
      const weak = formatWeakEncryption(e.message)
      if (weak && !String(e.reason ?? '').includes(weak)) e.reason = e.reason ? `${e.reason}；${weak}` : weak
    }
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
  if (channel === 'Security') {
    ev.account = field(message, ['帳戶名稱', 'Account Name', '目標帳戶名稱'])
    ev.domain = field(message, ['帳戶網域', 'Account Domain'])
    ev.ip = field(message, ['來源網路位址', 'Source Network Address', '用戶端位址', 'Client Address']).replace(/^::ffff:/i, '')
    ev.workstation = field(message, ['工作站名稱', 'Workstation Name', '來源工作站', 'Caller Computer Name'])
    // 4625 同時有「失敗原因」（文字）與「狀態 / 子狀態」（代碼），優先用文字
    ev.reason = field(message, ['失敗原因', 'Failure Reason']) || field(message, ['子狀態', 'Sub Status']) || field(message, ['狀態', 'Status'])
    // 帳號 / 群組異動：誰（主體）對誰（新帳戶 / 目標帳戶 / 成員）做了什麼、哪個群組
    if (ACCOUNT_CHANGES[ev.eventId] || AD6_ACCOUNT_GROUP_EVENTS.has(ev.eventId) || ev.eventId === 4672) {
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = cnName(field(message, ['目標帳戶名稱', 'Target Account Name', '帳戶名稱', 'Account Name']))
      if (GROUP_EVENTS.has(ev.eventId)) {
        ev.group = field(message, ['群組名稱', 'Group Name'])
        ev.privileged = isPrivGroup(ev.group)
        if (GROUP_ONLY_EVENTS.has(ev.eventId) && ev.group) ev.target = ev.group
      }
      if (ev.eventId === 4765 || ev.eventId === 4766) {
        const sidHist = field(message, ['SID 歷程記錄', 'SID 記錄', 'SID 歷史記錄', 'SID History'])
        const srcAcct = field(message, ['來源帳戶', 'Source Account'])
        const detail = [sidHist, srcAcct].filter(Boolean).join(' / ')
        if (detail && !ev.reason) ev.reason = detail
      }
      ev.account = ev.target || ev.account
    } else if (ev.eventId === 4624) {
      // 4624 登入類型（有出現在訊息中才補，維持舊版無該欄位時的相容性）
      const lt = field(message, ['登入類型', 'Logon Type'])
      if (lt && !ev.reason) ev.reason = LOGON_TYPES[lt] ? `登入類型 ${lt}（${LOGON_TYPES[lt]}）` : `登入類型 ${lt}`
    } else if (ev.eventId === 4768 || ev.eventId === 4769) {
      // 4768 / 4769 Kerberos 票證：服務名稱（ServiceName）；弱加密由 enrichEvent 補進 reason
      const svc = field(message, ['服務名稱', 'Service Name'])
      if (svc) ev.target = svc
    } else if (ev.eventId === 4697) {
      // 4697 安裝服務：執行者、服務名稱、服務檔案名稱
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['服務名稱', 'Service Name'])
      ev.reason = field(message, ['服務檔案名稱', 'Service File Name']) || ev.reason
    } else if (ev.eventId >= 4698 && ev.eventId <= 4702) {
      // 4698–4702 排程工作：執行者、工作名稱（TaskName）
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['工作名稱', 'Task Name'])
    } else if (ev.eventId === 4719) {
      // 4719 系統稽核原則被變更：執行者、子類別、變更內容
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['子類別', 'Subcategory', '類別', 'Category'])
      ev.reason = field(message, ['變更', 'Changes']) || ev.reason
    } else if (ev.eventId === 4739 || ev.eventId === 4713) {
      // 4739 網域原則變更 / 4713 Kerberos 原則變更
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['網域名稱', 'Domain Name'])
      ev.reason = field(message, ['已變更的網域原則', 'Domain Policy Changed', '已變更的原則', 'Policy Changed']) || ev.reason
    } else if (ev.eventId === 4706 || ev.eventId === 4707 || ev.eventId === 4716) {
      // 4706 / 4707 / 4716 信任關係：執行者、信任網域名稱、信任類型 / 方向
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['受信任的網域名稱', '受信任的網域', 'Trusted Domain', '網域名稱', 'Domain Name'])
      const trustInfo = [field(message, ['信任類型', 'Trust Type']), field(message, ['信任方向', 'Trust Direction'])].filter(Boolean).join(' / ')
      if (trustInfo && !ev.reason) ev.reason = trustInfo
    } else if (ev.eventId === 4616) {
      // 4616 系統時間被變更：執行者、處理程序名稱、前後時間
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['處理程序名稱', 'Process Name'])
      const prev = field(message, ['先前的時間', 'Previous Time'])
      const next = field(message, ['新的時間', 'New Time'])
      if ((prev || next) && !ev.reason) ev.reason = `${prev || '?'} → ${next || '?'}`
    } else if (ev.eventId === 4662) {
      // 4662 DCSync 複寫權限：執行者、目標物件、複寫 GUID 名稱
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['物件名稱', 'Object Name'])
      const low = message.toLowerCase()
      const rights = DCSYNC_GUID_NAMES.filter(([g]) => low.includes(g)).map(([, name]) => name)
      ev.reason = rights.length ? rights.join(', ') : field(message, ['屬性', 'Properties']) || ev.reason
    } else if (ev.eventId === 5136) {
      // 5136 目錄服務物件變更（GPO / AdminSDHolder）：執行者、ObjectDN、AttributeLDAPDisplayName
      ev.actor = field(message, ['帳戶名稱', 'Account Name'], true)
      ev.target = field(message, ['物件 DN', 'Object DN', 'DN'])
      const attr = field(message, ['LDAP 顯示名稱', 'LDAP Display Name', 'Attribute LDAP Display Name'])
      const cls = field(message, ['類別', 'Class', 'Object Class'])
      const val = field(message, ['值', 'Value'])
      const parts = [attr, cls && `(${cls})`, val && `= ${val.slice(0, 80)}`].filter(Boolean)
      if (parts.length && !ev.reason) ev.reason = parts.join(' ')
    }
  } else if (channel === 'System' && ev.eventId === 7045) {
    // System 7045 系統安裝新服務（與 Security 4697 互相佐證）
    ev.actor = field(message, ['服務帳戶', 'Account Name'])
    ev.target = field(message, ['服務名稱', 'Service Name'])
    ev.reason = field(message, ['服務檔案名稱', 'Service File Name'])
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
// 需求方 2026-11-24 決定（AD-6 M3）：只保留既有與高風險 ID；4723 / 4742 / 群組屬性變更與刪除（4730 / 4734 / 4758 / 4735 / 4737 / 4755）只記錄、不算需要注意（涉及特權群組仍依 privileged 標記）
const SECURITY_ISSUE_IDS = new Set([
  1100, 1102, 1104, 4616, 4625, 4662, 4697, 4698, 4699, 4700, 4701, 4702, 4706, 4707, 4713, 4716, 4719, 4739, 4740, 4765, 4766, 4771, 4780, 5136,
])
const SYSTEM_ISSUE_IDS = new Set([104, 7045])
export const isIssue = (e) =>
  ISSUE.has(e.level) ||
  Boolean(e.privileged) ||
  ((!e.channel || e.channel === 'Security') &&
    (SECURITY_ISSUE_IDS.has(e.eventId) || Boolean(ACCOUNT_CHANGES[e.eventId]) || ((e.eventId === 4768 || e.eventId === 4769) && /弱加密/i.test(String(e.reason ?? ''))))) ||
  (e.channel === 'System' && SYSTEM_ISSUE_IDS.has(e.eventId))

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
  const all = [...groups.values()].map((g) => ({ ...g, computers: [...g.computers], name: eventName(g.channel, g.eventId) }))
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
