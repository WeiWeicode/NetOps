import { readLog } from './palog.js'

/**
 * 從 FTP 串流掃描多個 log 檔（同時開 parallel 條連線）
 *   onRow(record, raw) 回傳 false → 全部停止（例如筆數已達上限）
 *   prefilter(raw)：整列文字快速排除（見 palog.js buildPrefilter）
 *   seconds：最多掃描幾秒；isClosed()：使用者已離開時回傳 true
 *   onProgress({ filesScanned, files, rows })：每掃完一個檔案呼叫一次
 *   openStream(path)：開啟 FTP 串流（新版由呼叫端注入 infra/ftp，舊版直接 import lib/ftp.js；其餘不變）
 * 回傳 { scanned（通過 prefilter 的列數）, rows（掃完的檔案總列數）, filesScanned, files, seconds, stopReason: '' | 'limit' | 'timeout' | 'closed' }
 */
export async function scanFiles(files, { onRow, prefilter = null, parallel = 3, seconds = 300, isClosed = () => false, onProgress = null, openStream }) {
  const t0 = Date.now()
  const deadline = t0 + seconds * 1000
  const queue = [...files]
  const open = new Set()
  let scanned = 0
  let filesScanned = 0
  let rows = 0 // 已掃完的檔案總列數（prefilter 排除的也算）
  let stopReason = ''

  const stop = (reason) => {
    if (!stopReason) stopReason = reason
    for (const s of open) s.abort()
  }

  async function worker() {
    while (queue.length && !stopReason) {
      if (isClosed()) return stop('closed')
      if (Date.now() > deadline) return stop('timeout')
      const f = queue.shift()
      const s = await openStream(f.path)
      open.add(s)
      try {
        await readLog(
          s.stream,
          f.name,
          (r, raw) => {
            if (stopReason) return false
            scanned++
            if (onRow(r, raw) === false) {
              stop('limit')
              return false
            }
          },
          { prefilter }
        )
        if (!stopReason) {
          filesScanned++
          rows += f.rows || 0
          onProgress?.({ filesScanned, files: files.length, rows })
        }
      } catch (err) {
        // 其他連線被 stop() 中斷時會跑到這裡，不算錯誤
        if (!stopReason) {
          stop('error')
          throw err
        }
      } finally {
        s.abort()
        open.delete(s)
      }
    }
  }

  // 每 2 秒檢查一次逾時 / 使用者離開，中斷正在讀的檔案
  const timer = setInterval(() => {
    if (isClosed()) stop('closed')
    else if (Date.now() > deadline) stop('timeout')
  }, 2000)
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, files.length)) }, worker))
  } finally {
    clearInterval(timer)
  }
  if (!stopReason && filesScanned < files.length) stopReason = 'timeout'
  return { scanned, rows, filesScanned, files: files.length, seconds: Math.round((Date.now() - t0) / 100) / 10, stopReason }
}
