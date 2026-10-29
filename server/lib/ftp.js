import path from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from 'basic-ftp'
import { config } from '../config.js'
import { HttpError } from './utils.js'

/**
 * FTP（FileZilla Server，支援 MLSD / UTF8）
 * 每個操作開一條新連線、用完就關；同時連線數由呼叫端控制（importer 的 FTP_PARALLEL）
 */
export async function connect() {
  if (!config.ftp.host) throw new HttpError(500, '尚未設定 FTP（server/.env 的 FTP_HOST）')
  const c = new Client(30000)
  try {
    await c.access({
      host: config.ftp.host,
      port: config.ftp.port,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: config.ftp.secure,
      secureOptions: { rejectUnauthorized: false },
    })
  } catch (err) {
    c.close()
    throw new HttpError(502, `FTP 連線失敗：${err.message}`)
  }
  return c
}

/** 畫面傳來的路徑 → FTP 絕對路徑；不可跳出 FTP_ROOT */
export function safePath(p = '') {
  const abs = path.posix.normalize('/' + String(p).replace(/\\/g, '/')).replace(/\/+$/, '') || '/'
  const root = config.ftp.root
  if (root !== '/' && abs !== root && !abs.startsWith(root + '/')) throw new HttpError(403, `只能存取 ${root} 以下的目錄`)
  return abs
}

/** 列出目錄：資料夾在前、依名稱排序 */
export async function listDir(dir) {
  const abs = safePath(dir)
  const c = await connect()
  try {
    const list = await c.list(abs)
    return list
      .filter((f) => f.name !== '.' && f.name !== '..')
      .map((f) => ({
        name: f.name,
        path: path.posix.join(abs, f.name),
        dir: f.isDirectory,
        size: f.size,
        modified: f.modifiedAt ?? null,
      }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }) : a.dir ? -1 : 1))
  } catch (err) {
    throw new HttpError(404, `無法讀取 FTP 目錄 ${abs}：${err.message}`)
  } finally {
    c.close()
  }
}

/**
 * 以串流讀取 FTP 檔案（不存到本機）
 * 回傳 { stream, done, abort }：stream 為檔案內容；done 在傳輸結束時 resolve；abort() 中斷並關閉連線
 */
export async function openStream(file) {
  const abs = safePath(file)
  const c = await connect()
  const stream = new PassThrough({ highWaterMark: 1 << 20 })
  let aborted = false
  const done = c
    .downloadTo(stream, abs)
    .catch((err) => {
      if (!aborted) stream.destroy(new HttpError(502, `讀取 FTP 檔案失敗 ${abs}：${err.message}`))
    })
    .finally(() => c.close())
  const abort = () => {
    aborted = true
    c.close()
    stream.destroy()
  }
  return { stream, done, abort }
}
