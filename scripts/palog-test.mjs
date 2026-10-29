// 開發用：直接從 FTP 串流分析一個檔案，印出筆數、耗時與摘要重點（不寫入摘要）
// node scripts/palog-test.mjs <FTP 檔案路徑>
import { openStream } from '../server/lib/ftp.js'
import { createSummary, readLog, mergeSummaries } from '../server/lib/palog.js'

const file = process.argv[2]
const t0 = Date.now()
const { stream, done } = await openStream(file)
let bytes = 0
stream.on('data', (c) => (bytes += c.length))
const sum = createSummary()
const { bad, columns } = await readLog(stream, file, (r) => sum.add(r))
await done
const s = sum.result()
const sec = (Date.now() - t0) / 1000
console.log(`${file}: ${s.rows} 列（錯誤 ${bad}），${(bytes / 1048576).toFixed(1)} MB，${sec.toFixed(1)} 秒（${(bytes / 1048576 / sec).toFixed(1)} MB/s）`)
console.log('欄位:', columns.join(','))
console.log('時間:', s.timeMin, '~', s.timeMax, '資料日:', s.day)
console.log('動作:', s.actions, '子類型:', s.subtypes)
const m = mergeSummaries([s], 5)
for (const k of ['src', 'dst', 'dport', 'app', 'zone', 'blockSrc', 'inboundBlockSrc', 'riskApp', 'dstCountry']) console.log(k.padEnd(16), m.top[k].map((x) => `${x.key}(${x.n})`).join('  '))
console.log('疑似掃描:', m.scan.slice(0, 5))
console.log('JSON 大小:', (JSON.stringify(s).length / 1024).toFixed(0), 'KB')
