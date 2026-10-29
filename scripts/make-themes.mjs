// 配色產生器：依 themes/palettes.mjs（色票）與 themes/theme.json（預設配色、微調）產生
//   src/themes/{配色}.css   各配色（結構同 docs/glass-theme-style-guide.md）
//   src/themes/active.css   theme.json 的配色 + 微調（src/style.css 匯入，是打包時的預設值）
//   themes/preview.html     配色預覽 / 調整頁（開發時 http://localhost:5203/__themes 可直接套用）
// 正式環境改用系統內「課務管理 → 樣式設定」調整（存在 server 的設定檔，GET /api/theme.css 即時套用，蓋過 active.css）
// 使用方式：npm run themes（加 --check 印對比檢查）；開發時 npm run dev 會在 theme.json / palettes.mjs 改動時自動重新產生
// 產生 CSS 的邏輯在 themes/theme-core.mjs（server 共用）
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const themesDir = resolve(root, 'themes')
const outDir = resolve(root, 'src', 'themes')

/** 載入核心與色票（加時間參數避免 import 快取，開發時改了檔案才讀得到新的） */
const fresh = (file) => import(pathToFileURL(resolve(themesDir, file)).href + `?t=${Date.now()}`)
export const loadCore = () => fresh('theme-core.mjs')
export const loadThemes = async () => (await fresh('palettes.mjs')).THEMES
export const normalizeConfig = async (cfg, themes) => (await loadCore()).normalizeConfig(cfg, themes)
export const readConfig = () => JSON.parse(readFileSync(resolve(themesDir, 'theme.json'), 'utf8'))
export const writeConfig = (cfg) => writeFileSync(resolve(themesDir, 'theme.json'), JSON.stringify(cfg, null, 2) + '\n')

/** 寫檔（內容沒變就不寫，避免開發時觸發不必要的重新載入） */
const writeIfChanged = (file, text) => {
  let old = null
  try {
    old = readFileSync(file, 'utf8')
  } catch {
    // 檔案不存在
  }
  if (old !== text) writeFileSync(file, text)
  return old !== text
}

/** 產生全部 CSS、active.css 與預覽頁；回傳 { active, changed } */
export async function generateThemes({ quiet = false } = {}) {
  const core = await loadCore()
  const themes = await loadThemes()
  const cfg = core.normalizeConfig(readConfig(), themes)
  const changed = []
  for (const [file, t] of Object.entries(themes)) {
    if (writeIfChanged(resolve(outDir, `${file}.css`), core.themeCss(t, '由 scripts/make-themes.mjs 依 themes/palettes.mjs 產生，不要直接改這個檔'))) changed.push(`${file}.css`)
  }
  const note = '由 scripts/make-themes.mjs 依 themes/theme.json 產生（打包時的預設值；正式環境以系統「樣式設定」為準）'
  if (writeIfChanged(resolve(outDir, 'active.css'), core.themeCss(core.mergeActive(themes, cfg), note, cfg.effect, cfg.fontScale))) changed.push('active.css')
  // 預覽頁：把色票與目前設定塞進 preview.src.html 的 /*__DATA__*/ 位置（< 轉義，避免字串裡出現 </script>）
  const data = JSON.stringify({ themes, config: cfg, keys: core.PALETTE_KEYS }).replace(/</g, '\\u003c')
  const html = readFileSync(resolve(themesDir, 'preview.src.html'), 'utf8').replace('/*__DATA__*/null', data)
  if (writeIfChanged(resolve(themesDir, 'preview.html'), html)) changed.push('preview.html')
  if (!quiet) console.log(`預設配色：${cfg.active}${changed.length ? `，已更新 ${changed.join('、')}` : '，沒有變更'}`)
  return { active: cfg.active, changed }
}

// 直接執行：node scripts/make-themes.mjs [--check]
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await generateThemes()
  if (process.argv.includes('--check')) {
    const { ratio } = await loadCore()
    const rows = []
    for (const [file, t] of Object.entries(await loadThemes())) {
      for (const mode of ['light', 'dark']) {
        const p = t[mode]
        const bg = p.bg[0]
        const r = {
          theme: `${file}/${mode}`,
          ink: ratio(p.ink, bg), mute: ratio(p.mute, bg), dim: ratio(p.dim, bg), link: ratio(p.brand600, bg),
          button: ratio(p.primaryText, p.primary), run: ratio(p.run, bg), warn: ratio(p.warn, bg), danger: ratio(p.danger, bg), done: ratio(p.done, bg),
        }
        rows.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? `${v.toFixed(1)}${v < (k === 'dim' ? 3 : 4.5) ? ' ✗' : ''}` : v])))
      }
    }
    console.table(rows)
  }
}
