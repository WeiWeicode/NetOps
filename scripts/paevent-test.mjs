// 開發用：拿 FTP 上一個其他類型的 PA log 檔測摘要（不寫入）
// node scripts/paevent-test.mjs <類型 threat|url|data|wildfire|decryption|globalprotect|userid> <FTP 檔案路徑>
import path from 'node:path'
import zlib from 'node:zlib'
import { openStream } from '../server/lib/ftp.js'
import { readLog } from '../server/lib/palog.js'
import { aggText, createEventSummary, EVENT_TYPES, mergeEventSummaries } from '../server/lib/paevents.js'
const [type, file] = process.argv.slice(2)
const def = EVENT_TYPES[type]
const t0 = Date.now()
const { stream, done } = await openStream(file)
const sum = createEventSummary(type)
const { bad, columns } = await readLog(stream, path.posix.basename(file), (r) => sum.add(r), { columns: def.columns, numeric: def.numeric })
await done
const r = sum.result()
console.log(`${file}：${r.lines} 列（加權 ${r.rows}）、${r.agg.length} 組合、摘要 gz ${(zlib.gzipSync(JSON.stringify(r)).length / 1e6).toFixed(2)} MB、${((Date.now() - t0) / 1000).toFixed(1)} 秒、壞列 ${bad}`)
console.log('對到的欄位：', columns.join(','), '｜沒對到：', Object.keys(def.columns).filter((k) => !columns.includes(k)).join(',') || '無')
const m = mergeEventSummaries(type, [r], 5)
for (const k of m.kpis) console.log(`[${k.title}]`, k.items.slice(0, 6).map((x) => `${x.key}=${x.n}`).join('  '))
for (const tp of m.tops) console.log(`<${tp.title}>`, tp.items.slice(0, 4).map((x) => `${x.key.slice(0, 70)}=${x.n}`).join(' | '))
console.log(aggText(type, r.agg, 4).text)
process.exit(0)
