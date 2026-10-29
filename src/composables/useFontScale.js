import { ref } from 'vue'

/**
 * 字體大小
 * 系統預設：管理員在「樣式設定」設定（/api/theme.css 的 --font-scale）
 * 個人設定：右上角 Aa（存在瀏覽器 localStorage），寫在 <html style> 上，優先於系統預設；選「依系統預設」就拿掉
 */
const STORAGE_KEY = 'netops-font-scale'
const root = document.documentElement

export const FONT_SCALES = [
  { value: 0.9, label: '小' },
  { value: 1, label: '標準' },
  { value: 1.1, label: '大' },
  { value: 1.2, label: '特大' },
  { value: 1.3, label: '超大' },
]
export const scaleLabel = (v) => `${FONT_SCALES.find((s) => s.value === Number(v))?.label ?? '自訂'} ${Math.round(Number(v) * 100)}%`

/** 個人設定；null = 依系統預設 */
export const fontScale = ref(null)

const read = () => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null // 無痕模式或封鎖網站資料時讀不到
  }
}

const apply = (v) => {
  fontScale.value = v
  if (v) root.style.setProperty('--font-scale', String(v))
  else root.style.removeProperty('--font-scale')
}

/** 在 main.js 掛載前呼叫，避免畫面先用預設大小再跳一次 */
export function initFontScale() {
  const v = Number(read())
  apply(FONT_SCALES.some((s) => s.value === v) ? v : null)
}

/** 設定個人字體大小；null = 改回依系統預設 */
export function setFontScale(v) {
  apply(v)
  try {
    if (v) localStorage.setItem(STORAGE_KEY, String(v))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 存不了就只在這次瀏覽有效
  }
}

/** 系統預設的字體大小（暫時拿掉個人設定讀 CSS 的值） */
export function systemFontScale() {
  const own = root.style.getPropertyValue('--font-scale')
  if (own) root.style.removeProperty('--font-scale')
  const v = Number(getComputedStyle(root).getPropertyValue('--font-scale')) || 1
  if (own) root.style.setProperty('--font-scale', own)
  return v
}
