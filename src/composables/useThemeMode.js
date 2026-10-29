import { ref } from 'vue'

const STORAGE_KEY = 'netops-theme-mode'
const root = document.documentElement

const readSaved = () => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null // 無痕模式或封鎖網站資料時讀不到
  }
}

const themeDefault = () =>
  getComputedStyle(root).getPropertyValue('--theme-default').trim() === 'dark' ? 'dark' : 'light'

export const themeMode = ref('light')

const apply = (mode) => {
  themeMode.value = mode
  root.classList.toggle('dark', mode === 'dark')
}

/** 在 main.js 掛載前呼叫，避免畫面先閃一下另一種模式 */
export function initThemeMode() {
  const saved = readSaved()
  apply(saved === 'dark' || saved === 'light' ? saved : themeDefault())
}

export function toggleThemeMode() {
  apply(themeMode.value === 'dark' ? 'light' : 'dark')
  try {
    localStorage.setItem(STORAGE_KEY, themeMode.value)
  } catch {
    // 存不了就只在這次瀏覽有效
  }
}
