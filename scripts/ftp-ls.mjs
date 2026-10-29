// 開發用：列出 FTP 目錄（含子目錄一層），統計檔名樣式
// node scripts/ftp-ls.mjs [/路徑...]
import { Client } from 'basic-ftp'
import { config } from '../server/config.js'

const dirs = process.argv.slice(2)
const c = new Client(30000)
try {
  await c.access({ host: config.ftp.host, port: config.ftp.port, user: config.ftp.user, password: config.ftp.password, secure: config.ftp.secure })
  for (const dir of dirs.length ? dirs : ['/']) {
    const list = await c.list(dir)
    const groups = {}
    for (const f of list) {
      const key = f.isDirectory ? `[DIR] ${f.name}` : f.name.replace(/\d+/g, '#')
      const g = (groups[key] ??= { n: 0, size: 0, first: f.name, last: f.name, mod: f.modifiedAt })
      g.n++
      g.size += f.size
      g.last = f.name
      if (f.modifiedAt > g.mod) g.mod = f.modifiedAt
    }
    console.log(`== ${dir}（${list.length} 項）`)
    for (const [k, g] of Object.entries(groups)) console.log(`${String(g.n).padStart(5)} ${(g.size / 1048576).toFixed(0).padStart(8)} MB  ${k}  例：${g.first}${g.n > 1 ? ` ~ ${g.last}` : ''}  最新 ${g.mod?.toISOString().slice(0, 16) ?? ''}`)
  }
} catch (err) {
  console.error('錯誤：', err.message)
} finally {
  c.close()
}
