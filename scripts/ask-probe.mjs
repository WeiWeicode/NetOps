// 開發用：量 AI 問答「查資料」階段的時間（印出 evidence / events 事件，收到 notes 就中斷，不等 AI 回答）
//   node scripts/ask-probe.mjs "10.10.112.1 連到 10.10.130.154 被擋" 2026/10/19 00:00 2026/10/19 23:59
import { signToken } from '../server/lib/auth.js'
const [question, d1, t1, d2, t2] = process.argv.slice(2)
const t0 = Date.now()
const ac = new AbortController()
const res = await fetch('http://localhost:3081/api/ai/ask', {
  method: 'POST',
  signal: ac.signal,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signToken('S094009')}` },
  body: JSON.stringify({ question, from: `${d1} ${t1}`, to: `${d2} ${t2}` }),
})
const dec = new TextDecoder()
let buf = ''
const seen = new Set()
try {
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    // 查資料的事件（流量證據、其他類型 log）各印一次；收到 notes（知識庫，送 AI 前最後一步）或錯誤就中斷
    for (const e of buf.matchAll(/event: (evidence|events)\ndata: (.*)\n/g)) {
      if (seen.has(e[1])) continue
      seen.add(e[1])
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)} 秒`, e[1], e[2].slice(0, 500))
    }
    const m = buf.match(/event: (notes|error)\ndata: (.*)\n/)
    if (m) {
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)} 秒`, m[1], m[2])
      ac.abort()
      break
    }
  }
} catch {}
process.exit(0)
