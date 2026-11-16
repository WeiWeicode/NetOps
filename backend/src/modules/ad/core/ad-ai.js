import { summarizeAd } from './adlog.js'

/**
 * AD 事件記錄給 AI 的文字(由舊版 server/lib/adimport.js 搬移,IMPL-PLAN A1;判斷與文字內容不變)
 * 與舊版不同:adContext 的事件與已匯入日期由呼叫端傳入(舊版直接讀 AD 資料目錄),見 modules/ad/importer.ts adContext。
 */

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
 *   events：期間內的事件（新的在前）；days：已匯入的日期 [{ day: 'yyyy/MM/dd', files: [{ channel, rows }] }]
 *   ips / eventIds / accounts：問題中的 IP、事件 ID、帳號，會另外列出符合的事件明細
 */
export function adContext(events, allDays, from, to, { ips = [], eventIds = [], accounts = [], full = true } = {}) {
  // events:呼叫端傳入(舊版 eventsInRange(from, to))
  if (!events.length) return ''
  const s = summarizeAd(events, 20)
  const days = allDays.filter((d) => d.day >= from.slice(0, 10) && d.day <= to.slice(0, 10))
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
