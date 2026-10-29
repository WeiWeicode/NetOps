// 配色核心：色票 + 設定 → CSS（不讀寫檔案）
// 打包時 scripts/make-themes.mjs 用它產生 src/themes/*.css；正式環境 server（GET /api/theme.css、樣式設定頁）也用它即時產生
// npm run publish 會把 themes/theme-core.mjs、palettes.mjs 一起放到發佈資料夾

/** 可微調的欄位（其餘欄位忽略）；bg、halo 是兩個顏色、blobs 是三個顏色的陣列 */
export const PALETTE_KEYS = [
  'bg', 'halo', 'glass', 'glassStrong', 'glow', 'ink', 'mute', 'dim', 'field', 'overlay',
  'danger', 'warn', 'run', 'done', 'brand50', 'brand100', 'brand500', 'brand600', 'brand700',
  'primary', 'primaryText', 'overlaySolid', 'textRegular', 'placeholder',
  'blobs', // 玻璃效果（effect = glass）背景的三個色塊，色票沒設定時由品牌色推算
]
const HEX = /^#[0-9a-f]{6}$/i
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/i
const isColor = (v) => typeof v === 'string' && (HEX.test(v) || RGBA.test(v))
/** 會拿來計算 Element Plus 色階或背景色塊的欄位必須是 #rrggbb */
export const HEX_ONLY = ['primary', 'run', 'warn', 'danger', 'done', 'bg', 'blobs', 'brand500']
/** 陣列欄位與顏色數 */
export const MULTI = { bg: 2, halo: 2, blobs: 3 }
/** 邊框依 glow 的 rgb 換透明度，必須是 rgba(...) */
export const RGBA_ONLY = ['glow']

/** 字體大小（系統預設）可選的值：80% ~ 150% */
export const FONT_SCALE_RANGE = [0.8, 1.5]

/** 檢查設定，回傳整理後的 { active, defaultMode, effect, fontScale, custom }（不合法的值丟出錯誤，避免產生壞掉的 CSS） */
export function normalizeConfig(cfg, themes) {
  const active = String(cfg?.active ?? '')
  if (!themes[active]) throw new Error(`配色「${active}」不存在，可用：${Object.keys(themes).join(', ')}`)
  const defaultMode = ['light', 'dark'].includes(cfg?.defaultMode) ? cfg.defaultMode : ''
  const custom = { light: {}, dark: {} }
  for (const mode of ['light', 'dark']) {
    for (const [k, v] of Object.entries(cfg?.custom?.[mode] ?? {})) {
      if (!PALETTE_KEYS.includes(k)) throw new Error(`custom.${mode}.${k} 不是可調整的欄位`)
      const list = MULTI[k] ? v : [v]
      if (!Array.isArray(list) || list.length !== (MULTI[k] ?? 1)) throw new Error(`custom.${mode}.${k} 格式錯誤（bg、halo 要兩個顏色，blobs 要三個）`)
      for (const c of list) {
        const fmt = HEX_ONLY.includes(k) ? '#rrggbb' : RGBA_ONLY.includes(k) ? 'rgba(r, g, b, a)' : '#rrggbb 或 rgba(r, g, b, a)'
        if (!isColor(c) || (HEX_ONLY.includes(k) && !HEX.test(c)) || (RGBA_ONLY.includes(k) && !RGBA.test(c))) throw new Error(`custom.${mode}.${k} 的顏色「${c}」格式錯誤（${fmt}）`)
      }
      custom[mode][k] = v
    }
  }
  // effect：solid 實心卡片（長時間看表格不累）、glass 毛玻璃（Canva Glassmorphism：彩色背景色塊 + 半透明卡片 + 強模糊）
  const effect = cfg?.effect === 'glass' ? 'glass' : 'solid'
  // fontScale：字體大小（系統預設），所有文字乘上這個值；使用者可在右上角 Aa 另外設定（存在瀏覽器）
  const fontScale = cfg?.fontScale === undefined || cfg?.fontScale === null || cfg?.fontScale === '' ? 1 : Math.round(Number(cfg.fontScale) * 100) / 100
  if (!(fontScale >= FONT_SCALE_RANGE[0] && fontScale <= FONT_SCALE_RANGE[1])) throw new Error(`字體大小需介於 ${FONT_SCALE_RANGE[0] * 100}% ~ ${FONT_SCALE_RANGE[1] * 100}%`)
  return { active, defaultMode, effect, fontScale, custom }
}

export const mix = (hex, to, w) => {
  const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16))
  return '#' + a.map((v, i) => Math.round(v * (1 - w) + b[i] * w).toString(16).padStart(2, '0')).join('')
}

/** Element Plus 色階：明亮模式混白、暗色模式混黑（見樣式指南 §3.2） */
const elScale = (name, hex, mode) => {
  const toward = mode === 'light' ? '#ffffff' : '#000000'
  const back = mode === 'light' ? '#000000' : '#ffffff'
  return [
    `--el-color-${name}: ${hex};`,
    ...[3, 5, 7, 8, 9].map((n) => `--el-color-${name}-light-${n}: ${mix(hex, toward, n / 10)};`),
    `--el-color-${name}-dark-2: ${mix(hex, back, 0.2)};`,
  ]
}

const rgbaOf = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${a})`

const colorTokens = (p) => [
  `--color-glass: ${p.glass};`,
  `--color-glass-strong: ${p.glassStrong};`,
  `--color-glow: ${p.glow};`,
  `--color-ink: ${p.ink};`,
  `--color-mute: ${p.mute};`,
  `--color-dim: ${p.dim};`,
  `--color-field: ${p.field};`,
  `--color-overlay: ${p.overlay};`,
  `--color-danger: ${p.danger};`,
  `--color-warn: ${p.warn};`,
  `--color-run: ${p.run};`,
  `--color-done: ${p.done};`,
  `--color-brand-50: ${p.brand50};`,
  `--color-brand-100: ${p.brand100};`,
  `--color-brand-500: ${p.brand500};`,
  `--color-brand-600: ${p.brand600};`,
  `--color-brand-700: ${p.brand700};`,
]

const modeBlock = (p, mode) => {
  const primaryHex = p.primary
  // 邊框、填色以主色系的「glow」為基底，深淺用透明度區分
  const lineRgb = p.glow.replace(/rgba\(([^)]+),\s*[\d.]+\)/, '$1')
  return [
    ...colorTokens(p),
    '',
    '--app-background:',
    `  radial-gradient(42rem 30rem at 8% 4%, ${p.halo[0]}, transparent 70%),`,
    `  radial-gradient(36rem 28rem at 94% 90%, ${p.halo[1]}, transparent 70%),`,
    `  linear-gradient(160deg, ${p.bg[0]} 0%, ${p.bg[1]} 100%);`,
    mode === 'light'
      ? `--glass-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 6px 20px rgba(15, 23, 42, 0.06);`
      : `--glass-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 30px rgba(0, 0, 0, 0.35);`,
    `--section-title-color: ${p.brand600};`,
    `--btn-primary-text: ${p.primaryText};`,
    `--loading-mask: ${mode === 'light' ? 'rgba(255, 255, 255, 0.6)' : rgbaOf(p.bg[0], 0.6)};`,
    `background: ${p.bg[0]};`,
    `color-scheme: ${mode};`,
    '',
    ...elScale('primary', primaryHex, mode),
    ...elScale('success', p.run, mode),
    ...elScale('warning', p.warn, mode),
    ...elScale('danger', p.danger, mode),
    ...elScale('error', p.danger, mode),
    ...elScale('info', p.done, mode),
    '--el-bg-color: transparent;',
    '--el-bg-color-page: transparent;',
    `--el-bg-color-overlay: ${p.overlaySolid};`,
    `--el-fill-color-blank: ${p.field};`,
    `--el-fill-color: rgba(${lineRgb}, 0.06);`,
    `--el-fill-color-light: rgba(${lineRgb}, 0.08);`,
    `--el-fill-color-lighter: rgba(${lineRgb}, 0.05);`,
    `--el-border-color: rgba(${lineRgb}, ${mode === 'light' ? 0.22 : 0.3});`,
    `--el-border-color-light: rgba(${lineRgb}, ${mode === 'light' ? 0.16 : 0.22});`,
    `--el-border-color-lighter: rgba(${lineRgb}, ${mode === 'light' ? 0.11 : 0.15});`,
    `--el-border-color-hover: ${primaryHex};`,
    `--el-text-color-primary: ${p.ink};`,
    `--el-text-color-regular: ${p.textRegular};`,
    `--el-text-color-secondary: ${p.mute};`,
    `--el-text-color-placeholder: ${p.placeholder};`,
    `--el-mask-color: ${p.overlay};`,
  ]
}

const indent = (lines) => lines.map((l) => (l ? `  ${l}` : '')).join('\n')

/** 玻璃效果的背景色塊：色票有 blobs 用色票，否則用品牌色 + 往粉紅、青色偏移的兩個顏色 */
export const blobsOf = (p) => p.blobs ?? [p.brand500, mix(p.brand500, '#ec4899', 0.6), mix(p.brand500, '#06b6d4', 0.6)]

/** effect = glass：覆寫卡片透明度、模糊、框線、背景（數值同 themes/preview.src.html 的 glassVars） */
const glassBlock = (p, mode) => {
  const light = mode === 'light'
  const [b1, b2, b3] = blobsOf(p)
  const a = light ? [0.55, 0.45, 0.4] : [0.45, 0.35, 0.3]
  return [
    `--glass-blur: ${light ? 22 : 24}px;`,
    `--color-glass: ${light ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 255, 255, 0.07)'};`,
    `--color-glass-strong: ${light ? 'rgba(255, 255, 255, 0.62)' : rgbaOf(p.bg[0], 0.62)};`,
    `--color-glow: ${light ? 'rgba(255, 255, 255, 0.65)' : 'rgba(255, 255, 255, 0.14)'};`,
    `--el-fill-color-blank: ${light ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.06)'};`,
    light
      ? '--glass-shadow: 0 8px 32px rgba(31, 38, 135, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.6);'
      : '--glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);',
    '--app-background:',
    `  radial-gradient(40rem 32rem at 10% 8%, ${rgbaOf(b1, a[0])}, transparent 65%),`,
    `  radial-gradient(36rem 30rem at 92% 18%, ${rgbaOf(b2, a[1])}, transparent 65%),`,
    `  radial-gradient(44rem 34rem at 55% 100%, ${rgbaOf(b3, a[2])}, transparent 65%),`,
    `  linear-gradient(160deg, ${p.bg[0]} 0%, ${p.bg[1]} 100%);`,
  ]
}

/** 使用中配色：色票 + 微調（cfg 需先經 normalizeConfig） */
export function mergeActive(themes, cfg) {
  const base = themes[cfg.active]
  return {
    ...base,
    title: `使用中：${cfg.active}｜${cfg.effect === 'glass' ? '毛玻璃效果｜' : ''}${base.title}`,
    default: cfg.defaultMode || base.default,
    light: { ...base.light, ...cfg.custom.light },
    dark: { ...base.dark, ...cfg.custom.dark },
  }
}

/** 打包用 CSS（含 Tailwind @theme），寫成 src/themes/*.css */
export const themeCss = (t, note, effect = 'solid', fontScale = null) => `/* ${t.title} */
/* ${note} */

/* MES 調整：玻璃模糊變淡、表格列距變緊（變數在 style.css 使用） */

/* 明亮（Tailwind 預設值） */
@theme {
${indent(colorTokens(t.light))}
}

/* 明亮：其他變數與 Element Plus */
html:root {
${fontScale === null ? '' : `  --font-scale: ${fontScale};\n`}  --theme-default: ${t.default};
  --glass-blur: 6px;
  --table-cell-py: 5px;

${indent(modeBlock(t.light, 'light'))}
}

/* 暗色：<html class="dark"> */
html.dark:root {
${indent(modeBlock(t.dark, 'dark'))}
}
${effect === 'glass' ? `
/* 毛玻璃效果（effect = glass） */
html:root {
${indent(glassBlock(t.light, 'light'))}
}

html.dark:root {
${indent(glassBlock(t.dark, 'dark'))}
}
` : ''}`

/**
 * 執行時 CSS（GET /api/theme.css、樣式設定頁預覽）：選擇器多一個 :root 提高權重，
 * 不論和打包 CSS 的載入順序如何都會蓋過打包時的配色
 */
export function runtimeCss(themes, cfg) {
  const t = mergeActive(themes, cfg)
  const glass = cfg.effect === 'glass'
  return `/* ${t.title}（樣式設定） */
html:root:root {
  --font-scale: ${cfg.fontScale ?? 1};
  --theme-default: ${t.default};
  --glass-blur: 6px;
  --table-cell-py: 5px;
${indent(modeBlock(t.light, 'light'))}
${glass ? indent(glassBlock(t.light, 'light')) : ''}
}
html.dark:root:root {
${indent(modeBlock(t.dark, 'dark'))}
${glass ? indent(glassBlock(t.dark, 'dark')) : ''}
}
`
}

/** 對比（文字 ≥ 4.5 為合格，dim 只用在頁尾可到 3） */
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
