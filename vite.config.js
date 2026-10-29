import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

/**
 * 配色（themes/）：啟動 / 打包前依 themes/theme.json 產生 src/themes/active.css
 * 開發時另提供 /__themes 預覽調整頁（POST /__themes/apply 寫回 theme.json），themes/ 的檔案改動會自動重新產生並熱更新
 * 產生器用動態 import 載入，避免被打包進 vite 設定檔（路徑才會正確）
 */
const themesDir = fileURLToPath(new URL('./themes', import.meta.url))
const loadThemeTool = () => import(new URL('./scripts/make-themes.mjs', import.meta.url).href + `?t=${Date.now()}`)
const themeStudio = {
  name: 'theme-studio',
  async buildStart() {
    await (await loadThemeTool()).generateThemes({ quiet: true })
  },
  configureServer(server) {
    const regenerate = async () => {
      try {
        const { changed, active } = await (await loadThemeTool()).generateThemes({ quiet: true })
        if (changed.length) server.config.logger.info(`[配色] ${active}：已更新 ${changed.join('、')}`, { timestamp: true })
      } catch (err) {
        server.config.logger.error(`[配色] ${err.message}`, { timestamp: true })
      }
    }
    server.watcher.add(themesDir)
    server.watcher.on('change', (file) => {
      if (file.startsWith(themesDir) && /(theme\.json|palettes\.mjs|theme-core\.mjs|preview\.src\.html)$/.test(file)) regenerate()
    })
    const send = (res, status, body, type = 'application/json; charset=utf-8') => {
      res.statusCode = status
      res.setHeader('Content-Type', type)
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    server.middlewares.use('/__themes', async (req, res) => {
      try {
        const tool = await loadThemeTool()
        if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
          await tool.generateThemes({ quiet: true })
          return send(res, 200, readFileSync(new URL('./themes/preview.html', import.meta.url), 'utf8'), 'text/html; charset=utf-8')
        }
        if (req.method === 'POST' && req.url === '/apply') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          // 預覽頁沒有字體大小，沿用 theme.json 原本的值
          const cfg = await tool.normalizeConfig({ fontScale: tool.readConfig().fontScale, ...JSON.parse(raw || '{}') }, await tool.loadThemes())
          tool.writeConfig(cfg)
          const { changed } = await tool.generateThemes({ quiet: true })
          server.config.logger.info(`[配色] 已套用 ${cfg.active}`, { timestamp: true })
          return send(res, 200, { status: 'success', message: `已套用 ${cfg.active}${changed.length ? '，系統畫面會自動更新' : '（沒有變更）'}` })
        }
        send(res, 404, { status: 'error', message: '找不到' })
      } catch (err) {
        send(res, 400, { status: 'error', message: err.message })
      }
    })
  },
}

// 開發時 API 的 port：API_PORT 環境變數 > server/.env.development > server/.env 的 PORT > 3081
// （ERMS 3001、SolarMES 3011、SolarDMA 3021、E-Learning 3031）
const portOf = (file) => {
  const url = new URL(file, import.meta.url)
  return existsSync(url) ? dotenv.parse(readFileSync(url)).PORT : ''
}
const serverPort = portOf('./server/.env.development') || portOf('./server/.env')
const apiPort = process.env.API_PORT || (/^\d+$/.test(serverPort ?? '') ? serverPort : '3081')

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] }),
    themeStudio,
  ],

  base: process.env.NODE_ENV === 'production' ? '/NetOps/' : '/',

  server: {
    // 開發時把 /api 轉給 server/index.js（npm run server）
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
})
