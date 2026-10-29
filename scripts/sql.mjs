// 開發用：node scripts/sql.mjs "SELECT ..."  直接查資料庫（唯讀查詢用，印成表格）
// 加 --raw：每列印成文字（看預存程序內容、長字串時用）
import { query } from '../server/db.js'
const args = process.argv.slice(2)
const raw = args.includes('--raw')
const text = args.filter((a) => a !== '--raw').join(' ')
try {
  const rows = await query(text)
  if (raw) for (const r of rows) console.log(Object.values(r).map((v) => (v instanceof Date ? v.toISOString() : v)).join('\t'))
  else console.table(rows.slice(0, 200))
  console.log(`${rows.length} rows`)
} catch (err) {
  console.error(err.message)
}
process.exit(0)
