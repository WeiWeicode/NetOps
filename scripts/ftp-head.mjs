// 開發用：讀出 FTP 檔案的大小與前幾行（自動判斷 UTF-16 / UTF-8 BOM）
// node scripts/ftp-head.mjs <FTP 檔案路徑> [行數]
import { Client } from 'basic-ftp'
import { Writable } from 'node:stream'
import { config } from '../server/config.js'

const file = process.argv[2]
const lines = Number(process.argv[3] || 6)
const c = new Client(30000)
try {
  await c.access({ host: config.ftp.host, port: config.ftp.port, user: config.ftp.user, password: config.ftp.password, secure: config.ftp.secure })
  const size = await c.size(file)
  const chunks = []
  let n = 0
  const sink = new Writable({ write(chunk, _e, cb) { chunks.push(chunk); n += chunk.length; cb(n > 200000 ? new Error('enough') : null) } })
  await c.downloadTo(sink, file).catch(() => {})
  const buf = Buffer.concat(chunks)
  const enc = buf[0] === 0xff && buf[1] === 0xfe ? 'utf16le' : 'utf8'
  const text = buf.toString(enc).replace(/^﻿/, '')
  const all = text.split(/\r?\n/)
  console.log(`== ${file}  ${size} bytes  編碼 ${enc}  （前 200KB 約 ${all.length} 行）`)
  console.log(all.slice(0, lines).map((l) => l.slice(0, 700)).join('\n'))
} catch (err) {
  console.error('錯誤：', err.message)
} finally {
  c.close()
}
