import { buildFilter, ipMatcher, ipNeedle, isAllow } from './palog.js'

/**
 * AI 問答用：從問題抓出 IP / Port → 掃描 log 的篩選條件 → 彙整符合的紀錄給 AI
 */

const IP_RE = /(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?:\/(\d{1,2}))?(?![\d.])/g
const PORT_RES = [/(?:port|埠|連接埠|通訊埠)\s*[:：]?\s*(\d{1,5})\b/gi, /\b(\d{1,5})\s*(?:port|埠)/gi, /(?:(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/g]

/** 問題文字 → { ips: ['10.10.112.1', '10.10.0.0/16'], ports: [445] }；沒有就是空陣列 */
export function parseQuestion(text) {
  const s = String(text ?? '')
  const ips = []
  for (const m of s.matchAll(IP_RE)) {
    if (m[1].split('.').some((x) => Number(x) > 255)) continue
    const ip = m[2] ? `${m[1]}/${m[2]}` : m[1]
    if (!ips.includes(ip)) ips.push(ip)
  }
  const ports = []
  for (const re of PORT_RES) {
    for (const m of s.matchAll(re)) {
      const p = Number(m[1])
      if (p > 0 && p <= 65535 && !ports.includes(p)) ports.push(p)
    }
  }
  return { ips: ips.slice(0, 4), ports: ports.slice(0, 10) }
}

/**
 * 條件 → { filter, prefilter, flowTest, label }
 *   flowTest(flow)：連線組合統計（lib/flows.js）用的判斷，IP 規則相同、Port 比對目的 Port
 *   1 個 IP：該 IP 為來源或目的（含 NAT）
 *   2 個 IP：兩者之間的連線（不分方向）
 *   3~4 個 IP：任一 IP 出現
 *   Port：目的 Port 符合
 */
export function buildCondition({ ips, ports }, from, to) {
  const base = buildFilter({ from, to, port: ports.join(',') })
  const m = ips.map((ip) => ipMatcher(ip))
  const has = (r, i) => m[i](r.src) || m[i](r.dst) || (r.natSrc && m[i](r.natSrc)) || (r.natDst && m[i](r.natDst))
  const needles = ips.map(ipNeedle)
  let ipTest = () => true
  let prefilter = null
  let label = ''
  if (ips.length === 1) {
    ipTest = (r) => has(r, 0)
    if (needles[0]) prefilter = (line) => line.includes(needles[0])
    label = `${ips[0]} 的所有連線（來源或目的）`
  } else if (ips.length === 2) {
    ipTest = (r) => has(r, 0) && has(r, 1)
    if (needles[0] && needles[1]) prefilter = (line) => line.includes(needles[0]) && line.includes(needles[1])
    label = `${ips[0]} 與 ${ips[1]} 之間的連線（不分方向）`
  } else if (ips.length > 2) {
    ipTest = (r) => m.some((_, i) => has(r, i))
    if (needles.every(Boolean)) prefilter = (line) => needles.some((n) => line.includes(n))
    label = `${ips.join('、')} 任一出現的連線`
  }
  if (ports.length) label += `${label ? '，' : ''}目的 Port ${ports.join('、')}`
  const flowTest = (f) => ipTest(f) && (!ports.length || ports.includes(Number(f.dport)))
  return { filter: (r, raw) => ipTest(r) && base(r, raw), prefilter, flowTest, label }
}

/**
 * 彙整符合的紀錄：連線組合、時段、結束原因、範例
 *   add(record)：從 FTP 掃到的一筆 log；addFlow(flow)：連線組合統計的一列（已累計次數，沒有範例紀錄）
 */
export function createCollector() {
  const flows = new Map()
  const hours = new Map()
  const count = (map, key, allow, w = 1) => {
    const v = map.get(key) ?? { n: 0, allow: 0, block: 0 }
    v.n += w
    if (allow) v.allow += w
    else v.block += w
    map.set(key, v)
  }
  const endReasons = new Map()
  const rules = new Map()
  const apps = new Map()
  const peers = new Map()
  const samples = []
  const s = { n: 0, allow: 0, block: 0, bytes: 0, first: '', last: '' }

  function add(r) {
    s.n++
    const allow = isAllow(r.action)
    if (allow) s.allow++
    else s.block++
    s.bytes += r.bytes || 0
    if (!s.first || r.time < s.first) s.first = r.time
    if (!s.last || r.time > s.last) s.last = r.time
    const port = r.dport ? `${r.proto}/${r.dport}` : r.proto
    const key = `${r.src} → ${r.dst}:${port}｜${r.action}｜規則 ${r.rule || '-'}｜App ${r.app || '-'}｜${r.fromZone} → ${r.toZone}`
    let f = flows.get(key)
    if (!f) {
      if (flows.size < 5000) flows.set(key, (f = { n: 0, bytes: 0, first: r.time, last: r.time, end: new Map(), nat: r.natSrc || r.natDst ? `NAT ${r.natSrc || '-'} → ${r.natDst || '-'}` : '', country: r.dstCountry }))
      // 每種連線組合留一筆範例
      if (samples.length < 25) samples.push(r)
    }
    if (f) {
      f.n++
      f.bytes += r.bytes || 0
      if (r.time < f.first) f.first = r.time
      if (r.time > f.last) f.last = r.time
      f.end.set(r.endReason, (f.end.get(r.endReason) ?? 0) + 1)
    }
    count(hours, r.time.slice(0, 13), allow)
    count(endReasons, r.endReason || '-', allow)
    count(rules, r.rule || '-', allow)
    count(apps, r.app || '-', allow)
    count(peers, `${r.src} → ${r.dst}`, allow)
  }

  /** 連線組合統計的一列（lib/flows.js parseLine）：同一小時、同一組合已累計 n 次 */
  function addFlow(r) {
    const w = r.n
    s.n += w
    const allow = isAllow(r.action)
    if (allow) s.allow += w
    else s.block += w
    s.bytes += r.bytes
    if (!s.first || r.first < s.first) s.first = r.first
    if (!s.last || r.last > s.last) s.last = r.last
    const port = r.dport ? `${r.proto}/${r.dport}` : r.proto
    const key = `${r.src} → ${r.dst}:${port}｜${r.action}｜規則 ${r.rule || '-'}｜App ${r.app || '-'}｜${r.fromZone} → ${r.toZone}`
    let f = flows.get(key)
    if (!f && flows.size < 5000) flows.set(key, (f = { n: 0, bytes: 0, first: r.first, last: r.last, end: new Map(), nat: r.natSrc || r.natDst ? `NAT ${r.natSrc || '-'} → ${r.natDst || '-'}` : '', country: r.dstCountry, user: r.srcUser, category: r.category }))
    if (f) {
      f.n += w
      f.bytes += r.bytes
      if (r.first < f.first) f.first = r.first
      if (r.last > f.last) f.last = r.last
      for (const [e, c] of r.end) f.end.set(e === '-' ? '' : e, (f.end.get(e === '-' ? '' : e) ?? 0) + c)
      f.user ||= r.srcUser
      f.category ||= r.category
    }
    count(hours, r.hour, allow, w)
    for (const [e, c] of r.end) count(endReasons, e || '-', allow, c)
    count(rules, r.rule || '-', allow, w)
    count(apps, r.app || '-', allow, w)
    count(peers, `${r.src} → ${r.dst}`, allow, w)
  }

  const num = (n) => (Number(n) || 0).toLocaleString('en-US')
  const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${(b / 1024).toFixed(1)}KB`)
  const lines = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, n)
      .map(([k, v]) => `- ${k}｜${num(v.n)} 次（允許 ${num(v.allow)}、阻擋 ${num(v.block)}）`)

  /** 給 AI 的文字 */
  function text() {
    if (!s.n) return '（這段時間 log 中沒有符合條件的紀錄）'
    return [
      `符合 ${num(s.n)} 筆：允許 ${num(s.allow)}、阻擋 ${num(s.block)}；流量 ${kb(s.bytes)}；時間 ${s.first} ~ ${s.last}`,
      '\n### 連線組合（來源 → 目的:協定/Port｜動作｜規則｜App｜區域）次數、流量、時間、結束原因',
      ...[...flows.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 40)
        .map(([k, f]) => `- ${k}｜${num(f.n)} 次｜${kb(f.bytes)}｜${f.first.slice(5)} ~ ${f.last.slice(5)}｜結束原因 ${[...f.end.entries()].map(([e, c]) => `${e || '-'} ${num(c)}`).join('、')}${f.nat ? `｜${f.nat}` : ''}${f.country ? `｜目的 ${f.country}` : ''}${f.user ? `｜使用者 ${f.user}` : ''}${f.category ? `｜URL 類別 ${f.category}` : ''}`),
      flows.size > 40 ? `（共 ${num(flows.size)} 種組合，只列前 40）` : '',
      '\n### 來源 → 目的（不分 Port）',
      ...lines(peers, 15),
      '\n### 規則',
      ...lines(rules, 10),
      '\n### App',
      ...lines(apps, 10),
      '\n### 結束原因',
      ...lines(endReasons, 8),
      '\n### 每小時',
      ...[...hours.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([h, v]) => `- ${h}時｜${num(v.n)}（允許 ${num(v.allow)}、阻擋 ${num(v.block)}）`),
      samples.length ? '\n### 範例紀錄（每種連線組合一筆）' : '',
      ...samples.slice(0, 15).map((r) => `- ${r.time}｜${r.action}｜${r.src}:${r.sport} → ${r.dst}:${r.dport}/${r.proto}｜${r.app}｜規則 ${r.rule}｜${r.fromZone}→${r.toZone}｜${r.endReason}｜送 ${r.sent}B 收 ${r.recv}B 封包 ${r.packets}${r.srcUser ? `｜使用者 ${r.srcUser}` : ''}${r.category && r.category !== 'any' ? `｜URL 類別 ${r.category}` : ''}`),
    ]
      .filter((x) => x !== '')
      .join('\n')
  }

  return { add, addFlow, text, stats: () => ({ ...s, flows: flows.size }) }
}
