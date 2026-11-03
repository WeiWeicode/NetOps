/**
 * PA-560 其他類型的 log（TRAFFIC 以外）：威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID
 * 每種類型定義：欄位對應（CSV 第一列的欄位名稱）、KPI、排行、每小時累計的維度（AI 問答依 IP 查用）
 * 與 TRAFFIC 相同：原始 log 不存本機，只存摘要與每小時的累計統計
 * 次數一律乘上 Repeat Count（PA 會把重複的事件合併成一筆）
 */

// 威脅 / URL / 資料過濾 / WildFire 是同一種 THREAT 格式（Threat/Content Type 不同）
const THREAT_COLUMNS = {
  time: ['Receive Time', 'Generate Time'],
  subtype: ['Threat/Content Type'],
  src: ['Source address'],
  dst: ['Destination address'],
  natSrc: ['NAT Source IP'],
  natDst: ['NAT Destination IP'],
  rule: ['Rule'],
  srcUser: ['Source User'],
  app: ['Application'],
  fromZone: ['Source Zone'],
  toZone: ['Destination Zone'],
  dport: ['Destination Port'],
  proto: ['IP Protocol'],
  action: ['Action'],
  url: ['URL/Filename'],
  name: ['Threat/Content Name'],
  category: ['Category', 'URL Category'],
  severity: ['Severity'],
  direction: ['Direction'],
  srcCountry: ['Source Country'],
  dstCountry: ['Destination Country'],
  repeat: ['Repeat Count'],
  thrCategory: ['thr_category'],
  filedigest: ['filedigest'],
  filetype: ['filetype'],
}

const cut = (v, n = 100) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, n)
/** URL 的主機名稱（去掉路徑） */
const hostOf = (url) => cut(String(url ?? '').split(/[/?]/)[0], 120)
/** 非私有 IP 的國家（PA 對私有 IP 填網段範圍，例如 10.0.0.0-10.255.255.255） */
const country = (c) => (c && !/^\d/.test(c) ? c : '')
const ext = (ip, c) => (ip && country(c) ? `${ip}（${c}）` : '')

/**
 * 類型定義
 *   dir：FTP 目錄（config.paEvents.dirs 可改）；label：中文名稱
 *   columns / numeric：欄位對應與數字欄位
 *   kpis：[名稱, 標題, (r) => 值]（數量少的列舉，例如動作、嚴重度）
 *   tops：[名稱, 標題, (r) => 值]（排行，空字串不算）
 *   dims：[名稱, 標題, (r) => 值]（每小時累計的維度，AI 問答用）；ips：dims 裡是 IP 的欄位
 */
export const EVENT_TYPES = {
  threat: {
    label: '威脅',
    dir: '/threat',
    columns: THREAT_COLUMNS,
    kpis: [
      ['action', '動作', (r) => r.action],
      ['severity', '嚴重度', (r) => r.severity],
      ['subtype', '類型', (r) => r.subtype],
    ],
    tops: [
      ['name', '威脅名稱', (r) => cut(r.name, 120)],
      ['highName', '高風險（critical / high）威脅', (r) => (/^(critical|high)$/i.test(r.severity) ? `${cut(r.name, 80)}｜${r.src} → ${r.dst}:${r.dport}｜${r.action}` : '')],
      ['src', '來源 IP', (r) => r.src],
      ['dst', '目的 IP', (r) => r.dst],
      ['extSrc', '外部來源（國家）', (r) => ext(r.src, r.srcCountry)],
      ['thrCategory', '威脅分類', (r) => r.thrCategory],
      ['app', 'App', (r) => r.app],
      ['rule', '規則', (r) => r.rule],
    ],
    dims: [
      ['src', '來源', (r) => r.src],
      ['dst', '目的', (r) => r.dst],
      ['dport', 'Port', (r) => (r.dport ? `${r.proto}/${r.dport}` : r.proto)],
      ['action', '動作', (r) => r.action],
      ['severity', '嚴重度', (r) => r.severity],
      ['subtype', '類型', (r) => r.subtype],
      ['name', '威脅', (r) => cut(r.name, 100)],
      ['url', 'URL', (r) => cut(r.url, 80)],
    ],
    ips: ['src', 'dst'],
  },
  url: {
    label: 'URL 過濾',
    dir: '/url-filtering',
    columns: THREAT_COLUMNS,
    kpis: [
      ['action', '動作', (r) => r.action],
      ['category', 'URL 類別', (r) => r.category],
    ],
    tops: [
      ['host', '網站', (r) => hostOf(r.url)],
      ['blockHost', '被擋的網站', (r) => (r.action !== 'alert' ? hostOf(r.url) : '')],
      ['category', 'URL 類別', (r) => r.category],
      ['src', '來源 IP', (r) => r.src],
      ['blockSrc', '被擋最多的來源 IP', (r) => (r.action !== 'alert' ? r.src : '')],
      ['user', '使用者', (r) => r.srcUser],
      ['app', 'App', (r) => r.app],
    ],
    dims: [
      ['src', '來源', (r) => r.src],
      ['host', '網站', (r) => hostOf(r.url)],
      ['category', '類別', (r) => r.category],
      ['action', '動作', (r) => r.action],
      ['user', '使用者', (r) => r.srcUser],
    ],
    ips: ['src'],
  },
  data: {
    label: '資料過濾',
    dir: '/data-filtering',
    columns: THREAT_COLUMNS,
    kpis: [
      ['action', '動作', (r) => r.action],
      ['subtype', '類型', (r) => r.subtype],
      ['direction', '方向', (r) => (r.direction === 'client-to-server' ? '上傳（client→server）' : r.direction === 'server-to-client' ? '下載（server→client）' : r.direction)],
    ],
    tops: [
      ['name', '檔案類型 / 資料樣式', (r) => cut(r.name, 100)],
      ['upload', '上傳的檔案（client→server）', (r) => (r.direction === 'client-to-server' ? `${cut(r.url, 80) || `（無檔名）${cut(r.name, 40)}`}｜${r.src} → ${r.app}` : '')],
      ['src', '來源 IP', (r) => r.src],
      ['upSrc', '上傳最多的內部 IP', (r) => (r.direction === 'client-to-server' ? r.src : '')],
      ['app', 'App', (r) => r.app],
      ['filetype', '副檔名', (r) => r.filetype],
      ['user', '使用者', (r) => r.srcUser],
    ],
    dims: [
      ['src', '來源', (r) => r.src],
      ['dst', '目的', (r) => r.dst],
      ['app', 'App', (r) => r.app],
      ['direction', '方向', (r) => r.direction],
      ['action', '動作', (r) => r.action],
      ['name', '檔案類型', (r) => cut(r.name, 80)],
      ['file', '檔名', (r) => cut(r.url, 80)],
    ],
    ips: ['src', 'dst'],
  },
  wildfire: {
    label: 'WildFire',
    dir: '/wildfire-submissions',
    columns: THREAT_COLUMNS,
    kpis: [
      ['verdict', '判定', (r) => r.category],
      ['action', '動作', (r) => r.action],
    ],
    tops: [
      ['bad', '非良性（malware / grayware / phishing）', (r) => (r.category && r.category !== 'benign' ? `${r.category}｜${cut(r.url, 80)}｜${r.src} → ${r.dst}` : '')],
      ['file', '送檢檔案', (r) => cut(r.url, 100)],
      ['src', '來源 IP', (r) => r.src],
      ['dst', '目的 IP', (r) => r.dst],
      ['filetype', '檔案類型', (r) => r.filetype],
      ['app', 'App', (r) => r.app],
    ],
    dims: [
      ['src', '來源', (r) => r.src],
      ['dst', '目的', (r) => r.dst],
      ['app', 'App', (r) => r.app],
      ['verdict', '判定', (r) => r.category],
      ['action', '動作', (r) => r.action],
      ['file', '檔名', (r) => cut(r.url, 80)],
      ['sha256', 'SHA256', (r) => cut(r.filedigest, 64)],
    ],
    ips: ['src', 'dst'],
  },
  decryption: {
    label: '解密',
    dir: '/decryption',
    columns: {
      time: ['Receive Time', 'Generate Time'],
      src: ['Source address'],
      dst: ['Destination address'],
      rule: ['Rule'],
      app: ['Application'],
      dport: ['Destination Port'],
      action: ['Action'],
      error: ['Error'],
      errIndex: ['err_index'],
      status: ['Decryption Status'],
      tls: ['Client TLS Version', 'tls_version'],
      proxyType: ['proxy_type'],
      policy: ['policy_name'],
      sni: ['Server Name Indication', 'SNI', 'sni'],
      repeat: ['Repeat Count'],
    },
    kpis: [
      ['status', '解密狀態', (r) => r.status],
      ['errIndex', '錯誤階段', (r) => r.errIndex],
      ['tls', 'TLS 版本', (r) => r.tls],
    ],
    tops: [
      ['error', '錯誤訊息', (r) => cut(r.error, 120)],
      ['src', '來源 IP', (r) => r.src],
      ['dst', '目的 IP', (r) => r.dst],
      ['sni', '網站（SNI）', (r) => cut(r.sni, 100)],
      ['proxyType', 'Proxy 類型', (r) => r.proxyType],
      ['app', 'App', (r) => r.app],
    ],
    dims: [
      ['src', '來源', (r) => r.src],
      ['dst', '目的', (r) => r.dst],
      ['dport', 'Port', (r) => String(r.dport || '')],
      ['app', 'App', (r) => r.app],
      ['status', '狀態', (r) => r.status],
      ['error', '錯誤', (r) => cut(r.error, 100)],
      ['proxyType', 'Proxy', (r) => r.proxyType],
    ],
    ips: ['src', 'dst'],
  },
  globalprotect: {
    label: 'GlobalProtect VPN',
    dir: '/globalprotect',
    columns: {
      time: ['Receive Time', 'Generate Time'],
      eventId: ['Event ID'],
      stage: ['Stage'],
      auth: ['Authentication Method'],
      user: ['Source User'],
      region: ['Source Region'],
      machine: ['Machine Name'],
      publicIp: ['Public IP'],
      privateIp: ['Private IP'],
      clientVer: ['Client Version'],
      os: ['Client OS'],
      error: ['Error'],
      description: ['Description'],
      status: ['Status'],
      portal: ['Portal'],
      repeat: ['Repeat Count'],
    },
    kpis: [
      ['status', '結果', (r) => r.status],
      ['eventId', '事件', (r) => r.eventId],
    ],
    tops: [
      ['failIp', '登入失敗的外部 IP（地區）', (r) => (r.status === 'failure' ? `${r.publicIp}${r.region ? `（${r.region}）` : ''}` : '')],
      ['failUser', '登入失敗的帳號', (r) => (r.status === 'failure' ? r.user : '')],
      ['error', '失敗原因', (r) => (r.status === 'failure' ? cut(r.error || r.description, 120) : '')],
      ['user', '連線成功的帳號', (r) => (r.status === 'success' && /connected|login/i.test(r.eventId + r.stage) ? r.user : '')],
      ['region', '來源地區', (r) => r.region],
      ['os', '用戶端 OS / 版本', (r) => (r.os ? `${r.os} ${r.clientVer}`.trim() : '')],
    ],
    dims: [
      ['user', '帳號', (r) => r.user],
      ['publicIp', '外部 IP', (r) => (r.publicIp === '0.0.0.0' ? '' : r.publicIp)],
      ['privateIp', '配發 IP', (r) => (r.privateIp === '0.0.0.0' ? '' : r.privateIp)],
      ['region', '地區', (r) => r.region],
      ['eventId', '事件', (r) => r.eventId],
      ['status', '結果', (r) => r.status],
      ['error', '錯誤', (r) => cut(r.error, 100)],
      ['machine', '電腦', (r) => r.machine],
    ],
    ips: ['publicIp', 'privateIp'],
  },
  userid: {
    label: 'User-ID',
    dir: '/user-id',
    columns: {
      time: ['Receive Time', 'Generate Time'],
      subtype: ['Threat/Content Type'],
      ip: ['Source IP'],
      user: ['User'],
      dataSourceType: ['Data Source Type'],
      dataSource: ['Data Source'],
      repeat: ['Repeat Count'],
    },
    kpis: [
      ['subtype', '事件', (r) => r.subtype],
      ['source', '來源', (r) => `${r.dataSource}${r.dataSourceType ? ` / ${r.dataSourceType}` : ''}`],
    ],
    tops: [
      ['user', '使用者', (r) => r.user],
      ['ip', 'IP', (r) => r.ip],
      ['pair', 'IP → 使用者', (r) => (r.ip && r.user ? `${r.ip} → ${r.user}` : '')],
    ],
    dims: [
      ['ip', 'IP', (r) => r.ip],
      ['user', '使用者', (r) => r.user],
      ['subtype', '事件', (r) => r.subtype],
      ['source', '來源', (r) => r.dataSourceType || r.dataSource],
    ],
    ips: ['ip'],
  },
}

for (const t of Object.values(EVENT_TYPES)) t.numeric = new Set(['repeat'])

/** 摘要格式版本；改了 EVENT_TYPES 的 kpis / tops / dims 就加 1，已分析的檔案會重新分析 */
export const EVENT_VERSION = 1

// 一個檔案最多記幾種每小時組合；超過就不記組合（摘要照常），避免異常檔案產生超大統計
const MAX_AGG = 200000

/** 單一檔案的摘要：add(record) 累計、result() 輸出 */
export function createEventSummary(type) {
  const def = EVENT_TYPES[type]
  const s = { rows: 0, lines: 0, timeMin: '', timeMax: '' }
  const days = {}
  const hours = {}
  const kpi = Object.fromEntries(def.kpis.map(([k]) => [k, {}]))
  const top = Object.fromEntries(def.tops.map(([k]) => [k, new Map()]))
  const agg = new Map()
  let aggOverflow = false

  function add(r) {
    if (!r.time) return
    const w = Math.max(Number(r.repeat) || 1, 1)
    s.rows += w
    s.lines++
    if (!s.timeMin || r.time < s.timeMin) s.timeMin = r.time
    if (!s.timeMax || r.time > s.timeMax) s.timeMax = r.time
    const day = r.time.slice(0, 10)
    days[day] = (days[day] ?? 0) + w
    const hour = r.time.slice(0, 13)
    hours[hour] = (hours[hour] ?? 0) + w
    for (const [k, , fn] of def.kpis) {
      const v = fn(r) || '-'
      kpi[k][v] = (kpi[k][v] ?? 0) + w
    }
    for (const [k, , fn] of def.tops) {
      const v = fn(r)
      if (v) top[k].set(v, (top[k].get(v) ?? 0) + w)
    }
    if (!aggOverflow) {
      const key = `${hour}\t${def.dims.map(([, , fn]) => cut(fn(r), 120)).join('\t')}`
      let a = agg.get(key)
      if (!a) {
        if (agg.size >= MAX_AGG) {
          aggOverflow = true
          agg.clear()
          return
        }
        agg.set(key, (a = { n: 0, first: r.time, last: r.time }))
      }
      a.n += w
      if (r.time < a.first) a.first = r.time
      if (r.time > a.last) a.last = r.time
    }
  }

  function result() {
    const dayList = Object.entries(days).sort((a, b) => b[1] - a[1])
    return {
      type,
      ...s,
      day: dayList[0]?.[0] ?? '',
      hours,
      kpi,
      top: Object.fromEntries(Object.entries(top).map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1]).slice(0, 300)])),
      aggOverflow,
      // [小時, ...維度, 次數, 最早, 最晚]
      agg: aggOverflow ? [] : [...agg].map(([key, a]) => [...key.split('\t'), a.n, a.first, a.last]),
    }
  }
  return { add, result }
}

/** 多個檔案的摘要合併（總覽頁）：{ files, rows, timeMin, timeMax, hours: [{ hour, n }], kpi, top: { k: [{ key, n }] } } */
export function mergeEventSummaries(type, list, topN = 20) {
  const def = EVENT_TYPES[type]
  const m = { type, label: def.label, files: list.length, rows: 0, timeMin: '', timeMax: '' }
  const hours = {}
  const kpi = Object.fromEntries(def.kpis.map(([k]) => [k, {}]))
  const top = Object.fromEntries(def.tops.map(([k]) => [k, new Map()]))
  for (const s of list) {
    m.rows += s.rows || 0
    if (s.timeMin && (!m.timeMin || s.timeMin < m.timeMin)) m.timeMin = s.timeMin
    if (s.timeMax && (!m.timeMax || s.timeMax > m.timeMax)) m.timeMax = s.timeMax
    for (const [h, n] of Object.entries(s.hours ?? {})) hours[h] = (hours[h] ?? 0) + n
    for (const [k, vals] of Object.entries(s.kpi ?? {})) if (kpi[k]) for (const [v, n] of Object.entries(vals)) kpi[k][v] = (kpi[k][v] ?? 0) + n
    for (const [k, rows] of Object.entries(s.top ?? {})) if (top[k]) for (const [v, n] of rows) top[k].set(v, (top[k].get(v) ?? 0) + n)
  }
  return {
    ...m,
    hours: Object.entries(hours)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, n]) => ({ hour, n })),
    kpis: def.kpis.map(([k, title]) => ({ key: k, title, items: Object.entries(kpi[k]).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n })) })),
    tops: def.tops.map(([k, title]) => ({
      key: k,
      title,
      items: [...top[k]]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([key, n]) => ({ key, n })),
    })),
  }
}

/**
 * 每小時組合 → 給 AI 的文字（同樣的維度跨小時合併）
 *   rows：[[小時, ...維度, 次數, 最早, 最晚]]；limit：最多列幾種組合
 */
export function aggText(type, rows, limit = 30) {
  const def = EVENT_TYPES[type]
  const nd = def.dims.length
  const merged = new Map()
  for (const r of rows) {
    const key = r.slice(1, 1 + nd).join('\t')
    const m = merged.get(key) ?? { dims: r.slice(1, 1 + nd), n: 0, first: r[nd + 2], last: r[nd + 3] }
    m.n += r[nd + 1]
    if (r[nd + 2] < m.first) m.first = r[nd + 2]
    if (r[nd + 3] > m.last) m.last = r[nd + 3]
    merged.set(key, m)
  }
  const list = [...merged.values()].sort((a, b) => b.n - a.n)
  const total = list.reduce((s, x) => s + x.n, 0)
  const lines = list.slice(0, limit).map((m) => `- ${def.dims.map(([, title], i) => (m.dims[i] ? `${title} ${m.dims[i]}` : '')).filter(Boolean).join('｜')}｜${m.n.toLocaleString('en-US')} 次｜${m.first.slice(5, 16)} ~ ${m.last.slice(5, 16)}`)
  return { total, kinds: list.length, text: [...lines, list.length > limit ? `（共 ${list.length} 種組合，只列前 ${limit}）` : ''].filter(Boolean).join('\n') }
}
