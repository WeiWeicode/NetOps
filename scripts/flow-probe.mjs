// 開發用：拿 FTP 上一個 PA log 檔測連線組合統計的大小（node scripts/flow-probe.mjs [/my-data/檔名]）
import fs from 'node:fs'
import path from 'node:path'
import { openStream, listDir } from '../server/lib/ftp.js'
import { readLog } from '../server/lib/palog.js'
import { createFlowStats, flowDir, queryFlows } from '../server/lib/flows.js'
import { config } from '../server/config.js'

let p = process.argv[2]
if (!p) p = (await listDir(config.ftp.logDir)).filter((f) => !f.dir && /\.csv$/i.test(f.name)).sort((a, b) => b.size - a.size)[0].path
const t0 = Date.now()
const { stream, done } = await openStream(p)
const fl = createFlowStats()
let rows = 0
await readLog(stream, path.posix.basename(p), (r) => { fl.add(r); rows++ })
await done
const r = fl.save('_probe.tsv.gz')
const size = fs.statSync(path.join(flowDir, '_probe.tsv.gz')).size
console.log(p, `${rows} 列 → ${r.flows} 組合，gz ${(size / 1e6).toFixed(2)} MB，${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
const t1 = Date.now()
const q = await queryFlows(['_probe.tsv.gz'], { from: '2000/01/01 00:00', to: '2100/01/01 00:00', prefilter: (l) => l.includes('10.10.112.'), test: () => true })
console.log(`查 10.10.112.*：${q.flows.length} 組合，${Date.now() - t1} ms`)
fs.rmSync(path.join(flowDir, '_probe.tsv.gz'))
process.exit(0)
