// 開發用：比較向量查詢寫法（需 SSH tunnel 18081）
import { listNotes } from '../server/lib/kb.js'
const url = 'http://localhost:18081/v1/embeddings'
const e = async (t) => (await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: t.slice(0, 1500) }) })).json()).data[0].embedding
const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0)
const notes = listNotes()
const variants = {
  full: (n) => [`標題：${n.title}`, n.ips.length ? `相關 IP / 網段：${n.ips.join('、')}` : '', n.tags.length ? `標籤：${n.tags.join('、')}` : '', '', n.content].join('\n'),
  noIps: (n) => [n.title, n.tags.filter((t) => !['自動學習', '外部 IP'].includes(t)).join('、'), n.content.replace(/（AI 依[^）]*）/, '')].join('\n'),
}
const qs = ['寄信伺服器是哪一家', '產線電腦可以上網嗎', '防毒主機 port', '員工用生成式 AI 上傳資料', '遠端桌面軟體']
const qf = {
  raw: (q) => q,
  instEn: (q) => `Instruct: Given a question, retrieve relevant notes that answer it\nQuery: ${q}`,
  instZh: (q) => `Instruct: 根據問題，找出能回答問題的網路知識庫筆記\nQuery: ${q}`,
}
for (const [vn, vf] of Object.entries(variants)) {
  const vecs = []
  for (const n of notes) vecs.push(await e(vf(n)))
  for (const [qn, f] of Object.entries(qf)) {
    console.log(`--- doc=${vn} query=${qn}`)
    for (const q of qs) {
      const qv = await e(f(q))
      const top = notes.map((n, i) => [cos(qv, vecs[i]), n.title]).sort((a, b) => b[0] - a[0]).slice(0, 2)
      console.log(q, '→', top.map(([s, t]) => `${s.toFixed(3)} ${t.slice(0, 22)}`).join(' | '))
    }
  }
}
