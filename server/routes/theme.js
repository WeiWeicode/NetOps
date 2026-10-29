import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import * as core from '../../themes/theme-core.mjs'
import { THEMES } from '../../themes/palettes.mjs'

/**
 * 配色 CSS（與 E-Learning 相同的配色系統，所有頁面載入 GET /api/theme.css）
 * 有 THEME_FILE 用它，沒有就用打包時的 themes/theme.json
 * 本系統沒有「樣式設定」頁；要換配色：開發時 npm run dev 後開 /__themes，或直接改 themes/theme.json 後重新發佈
 */
const defaultFile = path.resolve(import.meta.dirname, '..', '..', 'themes', 'theme.json')

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function currentConfig() {
  for (const file of [config.themeFile, defaultFile]) {
    const saved = readJson(file)
    if (!saved) continue
    try {
      return core.normalizeConfig(saved, THEMES)
    } catch {
      // 設定檔壞掉或配色已不存在，試下一個
    }
  }
  return core.normalizeConfig({ active: 'cleanroom' }, THEMES)
}

/** 依設定檔修改時間快取 */
let cssCache = { key: null, css: '' }
function currentCss() {
  let key = 'default'
  try {
    key = String(fs.statSync(config.themeFile).mtimeMs)
  } catch {
    // 沒有設定檔
  }
  if (cssCache.key !== key) cssCache = { key, css: core.runtimeCss(THEMES, currentConfig()) }
  return cssCache.css
}

/** 不需登入（登入頁也要用）；no-cache，換配色後重新整理就生效 */
export function themeCss(req, res) {
  res.set('Cache-Control', 'no-cache')
  res.type('text/css').send(currentCss())
}
