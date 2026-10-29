import sql from 'mssql'
import { config } from './config.js'

const baseOptions = {
  connectionTimeout: 30000,
  requestTimeout: 60000,
  // useUTC: false —— 否則 datetime 會被當成 UTC，時間差 8 小時
  options: { encrypt: false, trustServerCertificate: true, useUTC: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
}

let poolPromise = null

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({ ...baseOptions, ...config.db }).connect().catch((err) => {
      poolPromise = null
      throw err
    })
  }
  return poolPromise
}

// 依 JS 型別決定 SQL 型別；字串一律 NVarChar（中文不會變問號）
const bind = (request, params) => {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) request.input(key, sql.NVarChar, null)
    else if (typeof value === 'number') request.input(key, Number.isInteger(value) ? sql.Int : sql.Float, value)
    else if (typeof value === 'boolean') request.input(key, sql.Bit, value)
    else request.input(key, sql.NVarChar, String(value))
  }
  return request
}

/**
 * 測試用：VEEAM_DRY_RUN=1 時所有 SQL 都在同一個交易內執行，程式結束時 rollback，不會寫入資料庫
 */
let dryTx = null
async function dryRunTx() {
  if (!dryTx) {
    const tx = new sql.Transaction(await getPool())
    dryTx = tx.begin().then(() => tx)
    const rollback = async () => {
      await (await dryTx).rollback().catch(() => {})
      console.log('[DRY RUN] 已 rollback，未寫入任何資料')
      process.exit(0)
    }
    process.once('SIGINT', rollback)
    process.once('SIGTERM', rollback)
    process.once('dry-run-end', rollback)
  }
  return dryTx
}
export const isDry = process.env.VEEAM_DRY_RUN === '1'
// 同一個交易一次只能跑一個 request，dry run 時排隊執行
let dryQueue = Promise.resolve()
async function run(text, params) {
  if (!isDry) return bind((await getPool()).request(), params).query(text)
  const tx = await dryRunTx()
  const job = dryQueue.then(() => bind(new sql.Request(tx), params).query(text))
  dryQueue = job.catch(() => {})
  return job
}

/** 主資料庫 PortalSolar（同一台可跨庫查 LOS / GscSystem）；SQL Server 2012 */
export async function query(text, params = {}) {
  return (await run(text, params)).recordset ?? []
}

/** 預存程序回傳多個結果集時使用 */
export async function queryMulti(text, params = {}) {
  return (await run(text, params)).recordsets ?? []
}

export async function exec(text, params = {}) {
  const r = await run(text, params)
  return r.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0
}

/** 長時間的預存程序（例：ERP 匯入 SP_ERP2SQL，舊系統給 240 秒）：另開一個 requestTimeout 較長的連線池 */
let longPoolPromise = null
export async function execLong(text, params = {}, timeoutMs = 300000) {
  if (isDry) return exec(text, params)
  if (!longPoolPromise) {
    longPoolPromise = new sql.ConnectionPool({ ...baseOptions, requestTimeout: timeoutMs, pool: { max: 2, min: 0, idleTimeoutMillis: 30000 }, ...config.db })
      .connect()
      .catch((err) => {
        longPoolPromise = null
        throw err
      })
  }
  const r = await bind((await longPoolPromise).request(), params).query(text)
  return r.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0
}

/** 交易：fn 收到 { query, exec }，同一條連線執行，失敗自動 rollback */
export async function withTx(fn) {
  if (isDry) return fn({ query, exec })
  const tx = new sql.Transaction(await getPool())
  await tx.begin()
  const runTx = async (text, params = {}) => bind(new sql.Request(tx), params).query(text)
  try {
    const result = await fn({
      query: async (text, params) => (await runTx(text, params)).recordset ?? [],
      exec: async (text, params) => (await runTx(text, params)).rowsAffected?.reduce((a, b) => a + b, 0) ?? 0,
    })
    await tx.commit()
    return result
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
}

export { sql }
