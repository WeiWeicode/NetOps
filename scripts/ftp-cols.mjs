// 開發用：列出 FTP 上 PA log 檔的欄位名稱與第一筆資料（欄位編號: 名稱 = 值），只列有值的
// node scripts/ftp-cols.mjs <FTP 檔案路徑> [第幾筆，預設 1]
import { openStream } from '../server/lib/ftp.js'
import { splitCsv } from '../server/lib/palog.js'
import readline from 'node:readline'
const [file, nth = '1'] = process.argv.slice(2)
const { stream, abort } = await openStream(file)
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
let head = null
let i = 0
for await (const line of rl) {
  if (!head) { head = splitCsv(line.replace(/^﻿/, '')); continue }
  if (++i < Number(nth)) continue
  const v = splitCsv(line)
  head.forEach((h, k) => v[k] && v[k] !== '0' && console.log(`${k}: ${h || '(空白)'} = ${String(v[k]).slice(0, 120)}`))
  console.log(`（共 ${head.length} 欄）`)
  break
}
abort()
process.exit(0)
