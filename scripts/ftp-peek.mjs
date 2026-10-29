// 開發用：統計 FTP 目錄的檔案分類，並讀出一個檔案的前幾行
// node scripts/ftp-peek.mjs [/路徑] [檔名]
import { Client } from 'basic-ftp'
import { Writable } from 'node:stream'
import { config } from '../server/config.js'

const dir = process.argv[2] || config.ftp.root
const c = new Client(30000)
try {
  await c.access({ host: config.ftp.host, port: config.ftp.port, user: config.ftp.user, password: config.ftp.password, secure: config.ftp.secure })
  await c.cd(dir)
  const list = await c.list()
  const groups = {}
  for (const f of list) {
    const key = f.isDirectory ? `[DIR] ${f.name}` : f.name.replace(/_\d+\.(\w+)$/, '_N.$1')
    const g = (groups[key] ??= { n: 0, size: 0 })
    g.n++
    g.size += f.size
  }
  for (const [k, g] of Object.entries(groups)) console.log(`${String(g.n).padStart(4)} 檔 ${(g.size / 1048576).toFixed(0).padStart(7)} MB  ${k}`)
  const name = process.argv[3] || list.find((f) => f.isFile)?.name
  let buf = ''
  const sink = new Writable({
    write(chunk, _e, cb) {
      buf += chunk.toString('utf8')
      cb(buf.length > 6000 ? new Error('enough') : null)
    },
  })
  await c.downloadTo(sink, name).catch(() => {})
  console.log(`\n--- ${name}`)
  console.log(buf.split('\n').slice(0, 4).join('\n'))
} catch (err) {
  console.error('錯誤：', err.message)
} finally {
  c.close()
}
