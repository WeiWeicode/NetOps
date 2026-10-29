import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import { requireAuth } from './lib/auth.js'
import authRoutes from './routes/auth.js'
import ftpRoutes from './routes/ftp.js'
import palogRoutes from './routes/palog.js'
import aiRoutes from './routes/ai.js'
import kbRoutes from './routes/kb.js'
import jumpRoutes from './routes/jump.js'
import adRoutes from './routes/ad.js'
import paEventRoutes from './routes/paevents.js'
import { themeCss } from './routes/theme.js'

const app = express()
app.set('trust proxy', true)

/**
 * 日期一律輸出成本地時間字串，不用 ISO（datetime 在 JSON 會變成 UTC，畫面差 8 小時或差一天）
 * 00:00:00 → 'yyyy/MM/dd'，其餘 → 'yyyy/MM/dd HH:mm'
 */
const pad2 = (n) => String(n).padStart(2, '0')
app.set('json replacer', function (key, value) {
  const raw = this[key]
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return value
  const day = `${raw.getFullYear()}/${pad2(raw.getMonth() + 1)}/${pad2(raw.getDate())}`
  return raw.getHours() || raw.getMinutes() || raw.getSeconds() ? `${day} ${pad2(raw.getHours())}:${pad2(raw.getMinutes())}` : day
})
app.use(express.json({ limit: '1mb' }))

const api = express.Router()
api.get('/health', (req, res) => res.json({ status: 'success', time: new Date().toISOString() }))
api.use('/auth', authRoutes)
// 目前配色（所有頁面載入，含登入頁）
api.get('/theme.css', themeCss)
api.use(requireAuth)
api.use('/ftp', ftpRoutes)
api.use('/palog', palogRoutes)
api.use('/ai', aiRoutes)
api.use('/kb', kbRoutes)
api.use('/jump', jumpRoutes)
api.use('/ad', adRoutes)
api.use('/pa-events', paEventRoutes)
api.use((req, res) => res.status(404).json({ status: 'error', message: `找不到 API：${req.method} ${req.path}` }))

app.use('/api', api)
if (config.basePath) app.use(`${config.basePath}/api`, api)

// 正式環境：同一個服務提供 Vue 打包檔（dist），未命中的路徑回 index.html 交給 vue-router
if (fs.existsSync(config.distDir)) {
  const base = config.basePath || '/'
  app.use(base, express.static(config.distDir))
  app.get(`${base === '/' ? '' : base}/*splat`, (req, res) => res.sendFile(path.join(config.distDir, 'index.html')))
}

// 錯誤處理：HttpError 回傳訊息，其餘記 log 回 500
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err)
  res.status(status).json({
    status: 'error',
    message: status >= 500 ? `系統錯誤：${err.message}` : err.message,
  })
})

// Express 5：啟動失敗（例如 port 被佔用）時 callback 會收到 error
app.listen(config.port, (err) => {
  if (err) {
    console.error(`NetOps API 無法啟動（port ${config.port}）：${err.code === 'EADDRINUSE' ? 'port 已被其他程式佔用（ERMS 3001、SolarMES 3011、SolarDMA 3021、E-Learning 3031、Veeam 3043）' : err.message}`)
    process.exit(1)
  }
  console.log(`NetOps API 已啟動：http://localhost:${config.port}/api  (base ${config.basePath})`)
})
