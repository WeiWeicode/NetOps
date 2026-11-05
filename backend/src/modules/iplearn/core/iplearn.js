import { ipMatcher, isPrivateIp, mergeSummaries } from '../../pa/core/palog.js'

/**
 * 外部 IP 自動學習(由舊版 server/lib/iplearn.js 搬移,IMPL-PLAN A1、ARCHITECTURE D10):防火牆 log 裡出現的公網 IP(10.10、172.16、172.20 與其他私有 IP 以外)
 *   1. 從最近幾天的 PA 摘要挑出外部 IP(連線目的、被擋、上傳目的、外部連入),附上它在 log 裡的行為
 *   2. 查 IP 註冊資料(RDAP:ARIN / APNIC / RIPE / LACNIC / AFRINIC)與 DNS 反查,得到擁有者與網段
 *   3. 依組織 / 網段分組,請 AI 主機的模型整理成知識庫筆記(作者「AI 自動學習」、標籤「自動學習」)
 * 查過的 IP 記在 palogs/iplearn.json(ttlDays 天內不重查;落在已查過的網段內也不重查)
 * 同一個組織 / 網段只有一則筆記,之後學到新的 IP 會更新那則筆記;已有管理者手寫筆記的 IP 會略過
 *
 * 挑選、分組、提示與寫入筆記的規則與舊版相同。與舊版不同:
 *   - 外部相依由 createIpLearner 注入(狀態讀寫、摘要、筆記、模型、RDAP 查詢、DNS 反查),本檔不連線、不讀檔、不讀設定
 *   - 每天定時執行由呼叫端排程(舊版 import 時就啟動計時器)
 *   - RDAP 回應的解析(parseRdap)與連線(infra/rdap)分開
 */
export const AUTHOR = 'AI 自動學習'
export const TAG = '自動學習'
/** 自動學習筆記的上限（與管理者共用知識庫 5,000 則的上限，預留給管理者） */
export const MAX_AUTO_NOTES = 1000

/* ───────── IP 工具 ───────── */

const ipInt = (ip) => {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}
const intIp = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')

/** 起訖位址 → CIDR 清單 */
export function rangeToCidrs(start, end) {
  const out = []
  let s = ipInt(start)
  const e = ipInt(end)
  if (s === null || e === null) return out
  while (s <= e && out.length < 32) {
    let len = 32
    while (len > 0) {
      const size = 2 ** (32 - len + 1)
      if (s % size !== 0 || s + size - 1 > e) break
      len--
    }
    out.push(`${intIp(s)}/${len}`)
    s += 2 ** (32 - len)
  }
  return out
}

/** 要學習的外部 IP：IPv4 公網位址（使用者指定排除 10.10、172.16、172.20 開頭，其他私有 / 保留位址也排除） */
export function isLearnable(ip) {
  const s = String(ip)
  if (/^(10\.10\.|172\.16\.|172\.20\.)/.test(s)) return false
  const v = ipInt(s)
  if (v === null || isPrivateIp(s)) return false
  const a = v >>> 24
  return a !== 0 && a < 224 && !(a === 192 && ((v >>> 16) & 255) === 0) && !/^198\.1[89]\./.test(s)
}

/* ───────── RDAP 回應 ───────── */

/**
 * 與舊版不同（審查修正）：RDAP 的名稱與說明由網段登記人填寫，可能夾帶要模型照做的文字（之後會寫進知識庫）；
 * 每個欄位壓成一行、去掉控制字元並限制長度
 */
const clean = (v, n = 120) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
const vcardFn = (e) => clean(e?.vcardArray?.[1]?.find((x) => x[0] === 'fn')?.[3] ?? '')

/** RDAP 回應 JSON → { name, handle, org, country, start, end, cidrs, desc }；沒有網段資料丟出錯誤（舊版 rdap() 的解析部分） */
export function parseRdap(j) {
  if (!j.startAddress) throw new Error('RDAP 沒有網段資料')
  // 擁有者：registrant 優先，其次第一個有名稱的聯絡人
  const ents = [...(j.entities ?? []), ...(j.entities ?? []).flatMap((e) => e.entities ?? [])]
  const owner = ents.find((e) => e.roles?.includes('registrant') && vcardFn(e)) ?? ents.find((e) => vcardFn(e) && !e.roles?.includes('abuse'))
  const desc = (j.remarks ?? []).flatMap((r) => r.description ?? []).filter((x) => typeof x === 'string' && x && x.length < 120).map((x) => clean(x)).slice(0, 3)
  const cidrs = (j.cidr0_cidrs ?? []).filter((c) => c.v4prefix).map((c) => `${c.v4prefix}/${c.length}`)
  return {
    name: clean(j.name),
    handle: clean(j.handle, 60),
    org: vcardFn(owner) || desc[0] || clean(j.name) || '',
    country: clean(j.country, 10),
    start: j.startAddress,
    end: j.endAddress,
    cidrs: (cidrs.length ? cidrs : rangeToCidrs(j.startAddress, j.endAddress)).slice(0, 16),
    desc,
  }
}

/* ───────── 從 PA 摘要挑外部 IP ───────── */

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`)
const stripCountry = (k) => String(k).replace(/（.*$/, '')

/** 最近幾天的 PA 摘要（summaries：readSummary 的結果）→ Map(ip → { score, ctx: [說明] })（舊版 candidates 的計算部分） */
export function candidatesFrom(summaries) {
  const m = mergeSummaries(summaries, 150)
  // mergeSummaries：top[k] = [{ key, n, bytes }]（依次數），topBytes[k]（依位元組）
  const rows = (k) => {
    const seen = new Set()
    return [...(m.top?.[k] ?? []), ...(m.topBytes?.[k] ?? [])].filter((x) => !seen.has(x.key) && seen.add(x.key))
  }
  // 每個 IP 的行為：dst 是「連往此 IP 的全部連線（含被擋）」，扣掉 blockDst 才是允許的
  const acc = new Map()
  const get = (ip) => {
    if (!isLearnable(ip)) return null
    if (!acc.has(ip)) acc.set(ip, { dst: 0, dstBytes: 0, blockDst: 0, up: 0, upN: 0, blockSrc: 0, inBlock: 0, inAllow: [] })
    return acc.get(ip)
  }
  for (const { key, n, bytes } of rows('dst')) Object.assign(get(key) ?? {}, { dst: n, dstBytes: bytes || 0 })
  for (const { key, n } of rows('blockDst')) Object.assign(get(key) ?? {}, { blockDst: n })
  for (const { key, n, bytes } of rows('upDst')) Object.assign(get(stripCountry(key)) ?? {}, { up: bytes || 0, upN: n })
  for (const { key, n } of rows('blockSrc')) Object.assign(get(key) ?? {}, { blockSrc: n })
  for (const { key, n } of rows('inboundBlockSrc')) Object.assign(get(stripCountry(key)) ?? {}, { inBlock: n })
  for (const { key, n } of rows('inboundAllow')) {
    const [src, target] = String(key).split(' → ')
    const a = get(src)
    if (a && a.inAllow.length < 5) a.inAllow.push(`${target}（${n.toLocaleString()} 次）`)
  }
  const t = (n) => `${n.toLocaleString()} 次`
  const out = new Map()
  for (const [ip, a] of acc) {
    const ctx = []
    if (a.dst) ctx.push(`內部主機連往此 IP 共 ${t(a.dst)}：允許 ${t(Math.max(a.dst - a.blockDst, 0))}、被防火牆擋 ${t(a.blockDst)}，流量 ${fmtBytes(a.dstBytes)}`)
    else if (a.blockDst) ctx.push(`內部主機連往此 IP 被防火牆擋 ${t(a.blockDst)}`)
    if (a.up) ctx.push(`內部上傳（送出）到此 IP ${fmtBytes(a.up)}`)
    if (a.inAllow.length) ctx.push(`此 IP 從外部連入本公司、防火牆允許：→ ${a.inAllow.join('、')}`)
    if (a.inBlock) ctx.push(`此 IP 從外部主動連入本公司被擋 ${t(a.inBlock)}（對方連入 / 掃描）`)
    else if (a.blockSrc) ctx.push(`以此 IP 為來源的連線被擋 ${t(a.blockSrc)}`)
    out.set(ip, { score: a.dst + a.blockSrc + a.inBlock + a.up / 1e6 + a.inAllow.length * 1000, ctx })
  }
  return out
}

/* ───────── AI 整理成筆記 ───────── */

export const groupKey = (r) => (r.org || r.name || r.handle || 'unknown').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function groupText(key, g) {
  const ips = Object.entries(g.ips).slice(0, 25)
  return [
    `### 分組 ${key}`,
    `- 擁有者：${g.org || '（RDAP 未提供）'}；網段名稱：${g.name || '－'}（${g.handle || '－'}）；國家：${g.country || '－'}`,
    g.desc?.length ? `- 登記說明：${g.desc.join(' / ')}` : '',
    `- 網段：${g.cidrs.join('、') || '－'}`,
    '- 在本公司防火牆 log 出現的 IP：',
    ...ips.map(([ip, v]) => `  - ${ip}${v.ptr ? `（DNS 反查：${v.ptr}）` : '（無 DNS 反查）'}：${v.ctx.join('；') || '－'}`),
  ]
    .filter(Boolean)
    .join('\n')
}

export const FOOTER = '（AI 依 RDAP 公開註冊資料與 DNS 反查自動整理，僅供參考）'
export const SYSTEM = `你是公司網通（網路 / 資安）工程師的助理，要把「外部 IP 的公開註冊資料 + 本公司防火牆 log 裡的行為」整理成知識庫筆記，之後 AI 問答時當參考。
規則：
1. 每個分組輸出一則筆記，只能根據給你的 RDAP 擁有者、網段、DNS 反查與 log 行為判斷，不要捏造服務名稱；雲端的區域（例如 ap-southeast-1）只有在 DNS 反查名稱或登記資料寫出來時才能寫；不確定就寫「可能」並說明依據。
2. 判斷這個來源是什麼服務（例如 outbound.protection.outlook.com = Microsoft 365 / Exchange Online 寄信伺服器；hinet = 中華電信 HiNet 用戶或主機；Palo Alto Networks = 防火牆雲端服務 / 更新 / 授權），以及在本公司的行為是否正常、需不需要注意。
3. 筆記內容用繁體中文 Markdown，精簡（每則 15 行內），包含：**擁有者與網段**、**可能的服務**、**在本公司 log 的行為**、**判斷 / 建議**（系統會自動加上「AI 自動整理，僅供參考」的註記，你不用寫）。
4. 只輸出 JSON 陣列，不要加說明或 \`\`\`：[{"key":"分組代號（照抄）","title":"標題（例如：Microsoft 365 寄信伺服器 40.74.0.0/15）","tags":["Microsoft","SMTP"],"content":"Markdown"}]
5. 「被防火牆擋」是本公司 PA 防火牆擋的；「從外部主動連入被擋」是對方連進來（可能是掃描），「內部主機連往」是本公司主機主動連出去，不要混淆。用詞用「防火牆」。
6. tags 最多 4 個（組織、服務類型，例如 Microsoft、CDN、ISP、SMTP、掃描），不要放 IP。
7. 被擋很多不代表惡意：本公司有些網段（例如產線）依政策不能上外網，連往 CDN / 雲端 / 軟體更新被 interzone-default 擋是常態，通常是軟體背景更新或遙測。不要只因為「被擋比例高」就寫 C2、惡意軟體、感染；只有對方主動連入 / 掃描、或連線行為與該服務明顯不符時才提醒可能異常，建議用「確認是哪台主機、哪個程式在連」這類可執行的檢查。`

export function parseJson(text) {
  const t = String(text).replace(/^[\s\S]*?(\[)/, '$1').replace(/\][^\]]*$/, ']')
  const arr = JSON.parse(t)
  return Array.isArray(arr) ? arr : []
}

/* ───────── 執行 ───────── */

/**
 * deps：
 *   loadState() / saveState(state)：palogs/iplearn.json（store.pa）
 *   recentSummaries(days) → { summaries, from, to, files }：最近 days 天的 TRAFFIC 摘要（from / to 為 'yyyy/MM/dd'）
 *   listNotes()、saveNote(data, author, id?)：知識庫（id 不存在時丟出錯誤）
 *   noteState(id) → 'auto' | 'manual' | null：筆記仍是自動學習的、管理者改過（拿掉標籤或修改人不是 AI 自動學習）、已刪除
 *   chatOnce({ messages, maxTokens })：模型（不串流、不思考）
 *   rdap(ip) → RDAP 回應 JSON（infra/rdap，依序查各區登記處）；reverseDns(ip) → '名稱, …'（失敗回 ''）
 *   nowText()：'yyyy/MM/dd HH:mm:ss'；log：{ error }
 *   options：{ days, max, ttlDays, maxAutoNotes? }（設定的預設值）
 */
export function createIpLearner(deps) {
  const { loadState, saveState, recentSummaries, listNotes, saveNote, chatOnce, rdap, reverseDns, nowText, options } = deps
  const noteState = deps.noteState ?? (() => 'auto')
  const maxAutoNotes = options.maxAutoNotes ?? MAX_AUTO_NOTES
  /** 目前的自動學習筆記數 */
  const autoCount = () => listNotes().filter((n) => n.tags.includes(TAG)).length
  let state = (() => {
    try {
      return loadState() ?? {}
    } catch (err) {
      // 同舊版：狀態檔讀不到就重新開始（只影響「不重查」的快取）
      deps.log?.error({ err }, '[外部 IP 學習] 狀態檔無法讀取，重新開始')
      return {}
    }
  })()
  state.ips ??= {} // ip → { at, group, ptr }
  state.nets ??= [] // [{ start, end, group }] 查過的網段
  state.groups ??= {} // group → { org, name, country, handle, cidrs, ips: { ip: { ptr, ctx, at } }, noteId }
  state.runs ??= []

  const save = () => saveState(state)

  /** 最近 days 天的 PA 摘要 → { list: Map(ip → { score, ctx }), from, to, files } */
  function candidates(days) {
    const r = recentSummaries(days)
    return { list: candidatesFrom(r.summaries), from: r.from, to: r.to, files: r.files }
  }

  /** 管理者手寫（非自動學習）筆記已涵蓋的 IP */
  function manualMatchers() {
    return listNotes()
      .filter((n) => !n.tags.includes(TAG))
      .flatMap((n) => n.ips.map(ipMatcher).filter(Boolean))
  }

  async function writeNotes(keys, log) {
    let saved = 0
    for (let i = 0; i < keys.length; i += 8) {
      const batch = keys.slice(i, i + 8)
      log(`AI 整理筆記 ${i + 1}～${i + batch.length} / ${keys.length}`)
      let notes
      try {
        const reply = await chatOnce({
          maxTokens: 6000,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: batch.map((k) => groupText(k, state.groups[k])).join('\n\n') },
          ],
        })
        notes = parseJson(reply)
      } catch (err) {
        log(`AI 整理失敗：${err.message}`)
        continue
      }
      // 與舊版不同（審查修正）：模型回的 key 只接受這一批的分組（不可改寫別組的筆記）
      const allowed = new Set(batch)
      for (const n of notes) {
        if (typeof n?.key !== 'string' || !allowed.has(n.key)) continue
        const g = state.groups[n.key]
        if (!g || typeof n.content !== 'string' || !n.content) continue
        const ips = g.cidrs.length ? g.cidrs : Object.keys(g.ips)
        const tags = [TAG, '外部 IP', ...(Array.isArray(n.tags) ? n.tags : [])].map(String).filter((x, j, a) => x && a.indexOf(x) === j)
        // AI 有時自己寫了註記：去掉再統一加（內容先限制長度，模型輸出很長時正規表示式比對會很慢）
        const content = `${n.content.slice(0, 8000).replace(/\n*（AI[^）]*自動整理[^）]*）\s*$/, '').trim()}\n\n${FOOTER}`
        const data = { title: typeof n.title === 'string' ? n.title : '', ips: ips.slice(0, 30), tags, content, source: `外部 IP 自動學習（RDAP / DNS 反查）${g.handle ? ` ${g.handle}` : ''}` }
        // 與舊版不同（審查修正）：管理者改過的筆記不覆寫（AGENT.md §7.4）；已刪除的重新建立；
        // 寫入失敗明確記錄並略過（舊版任何錯誤都改成新建，可能產生重複筆記）
        const st = g.noteId ? noteState(g.noteId) : null
        if (st === 'manual') {
          log(`「${g.org || n.key}」的筆記已由管理者修改，不覆寫`)
          continue
        }
        if (!st && autoCount() >= maxAutoNotes) {
          log(`自動學習筆記已達上限 ${maxAutoNotes} 則，不再新增`)
          continue
        }
        let note
        try {
          note = saveNote(data, AUTHOR, st ? g.noteId : undefined)
        } catch (err) {
          log(`「${g.org || n.key}」寫入知識庫失敗：${err.message}`)
          continue
        }
        g.noteId = note.id
        g.noted = nowText().slice(0, 16)
        saved++
      }
      save()
    }
    return saved
  }

  const run = { busy: false, phase: '', done: 0, total: 0, log: [], startedAt: null, finishedAt: null, result: null, error: '' }

  function learnStatus() {
    const groups = Object.values(state.groups)
    return {
      ...run,
      log: run.log.slice(-30),
      learnedIps: Object.keys(state.ips).length,
      groups: groups.length,
      notes: groups.filter((g) => g.noteId).length,
      lastRun: state.runs.at(-1) ?? null,
    }
  }

  /**
   * 學習一次：days 天內的 log、最多 max 個新 IP；rewrite = 已學過的組織筆記也全部重寫；回傳 { candidates, looked, skipped, notes }
   * 同時只能跑一個
   */
  async function learnIps({ days = options.days, max = options.max, by = '', rewrite = false } = {}) {
    if (run.busy) throw new Error('外部 IP 自動學習正在執行中')
    Object.assign(run, { busy: true, phase: '挑選外部 IP', done: 0, total: 0, log: [], startedAt: nowText(), finishedAt: null, result: null, error: '' })
    const log = (msg) => {
      run.phase = msg
      run.log.push(`${nowText().slice(11, 19)} ${msg}`)
    }
    try {
      const c = candidates(days)
      const manual = manualMatchers()
      const ttl = options.ttlDays * 86400000
      const touched = new Set()
      let manualSkip = 0
      let cached = 0
      const todo = []
      for (const [ip, info] of [...c.list.entries()].sort((a, b) => b[1].score - a[1].score)) {
        if (manual.some((f) => f(ip))) {
          manualSkip++
          continue
        }
        const old = state.ips[ip]
        if (old && Date.now() - old.at < ttl) {
          cached++
          continue
        }
        todo.push([ip, info])
      }
      const pick = todo.slice(0, max)
      log(`${c.from}～${c.to} 共 ${c.list.size} 個外部 IP；已學過 ${cached}、管理者筆記已有 ${manualSkip}，這次查 ${pick.length} 個`)
      run.total = pick.length

      // 查詢（3 個同時）；落在本次或之前查過的網段內就不再查 RDAP
      let rdapCalls = 0
      let failed = 0
      const queue = [...pick]
      const worker = async () => {
        while (queue.length) {
          const [ip, info] = queue.shift()
          const v = ipInt(ip)
          let net = state.nets.find((n) => v >= n.start && v <= n.end)
          if (!net) {
            try {
              rdapCalls++
              const r = parseRdap(await rdap(ip))
              const key = groupKey(r)
              const g = (state.groups[key] ??= { org: r.org, name: r.name, country: r.country, handle: r.handle, desc: r.desc, cidrs: [], ips: {} })
              for (const x of r.cidrs) if (!g.cidrs.includes(x) && g.cidrs.length < 30) g.cidrs.push(x)
              net = { start: ipInt(r.start), end: ipInt(r.end), group: key }
              if (net.start !== null && net.end !== null) state.nets.push(net)
              else net = { group: key }
            } catch (err) {
              failed++
              log(`${ip} 查詢失敗：${err.message}`)
              state.ips[ip] = { at: Date.now() - ttl + 86400000, group: '', ptr: '' } // 隔天再試
              run.done++
              continue
            }
          }
          const ptr = await reverseDns(ip)
          const g = state.groups[net.group]
          g.ips[ip] = { ptr, ctx: info.ctx, at: nowText().slice(0, 16) }
          // 每組最多記 40 個 IP（超過時移除最早記的）
          const entries = Object.entries(g.ips)
          if (entries.length > 40) delete g.ips[entries[0][0]]
          state.ips[ip] = { at: Date.now(), group: net.group, ptr }
          touched.add(net.group)
          run.done++
          if (run.done % 10 === 0) {
            log(`已查 ${run.done} / ${run.total}`)
            save()
          }
        }
      }
      await Promise.all([worker(), worker(), worker()])
      save()

      // rewrite：已學過的組織全部重新請 AI 整理（調整提示後更新舊筆記）
      const keys = rewrite ? Object.keys(state.groups).filter((k) => Object.keys(state.groups[k].ips).length) : [...touched]
      log(`查詢完成：${keys.length} 個組織 / 網段（RDAP 查 ${rdapCalls} 次、失敗 ${failed}），交給 AI 整理`)
      const notes = keys.length ? await writeNotes(keys, log) : 0
      const result = { at: nowText().slice(0, 16), by, range: `${c.from}～${c.to}`, candidates: c.list.size, looked: pick.length, cached, manualSkip, failed, groups: keys.length, notes }
      state.runs = [...state.runs, result].slice(-30)
      save()
      log(`完成：寫入 / 更新 ${notes} 則知識庫筆記`)
      run.result = result
      return result
    } catch (err) {
      run.error = err.message
      log(`失敗：${err.message}`)
      throw err
    } finally {
      run.busy = false
      run.finishedAt = nowText()
    }
  }

  /** 每日自動執行用：今天已跑過或正在跑就略過（舊版 setInterval 內的判斷） */
  function shouldAutoRun(today) {
    if (state.autoDay === today || run.busy) return false
    state.autoDay = today
    return true
  }

  return { learnIps, learnStatus, shouldAutoRun }
}
