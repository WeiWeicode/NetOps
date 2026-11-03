/**
 * 明暗 × 風格(UI-GUIDE §2,沿用入口網):設定 <html data-theme data-style>,元件只讀 token。
 * 個人偏好存在 localStorage(只存 netops.theme / netops.style 兩個值,非機密;讀寫失敗時退回預設)。
 * 啟動時 public/theme-init.js 已先套用一次(避免閃爍),規則需與這裡一致。
 */
import { computed, ref } from 'vue';
import { resolveStyle, resolveTheme, type Style, type Theme } from './themeRules';

export type { Style, Theme };
const THEME_KEY = 'netops.theme';
const STYLE_KEY = 'netops.style';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 無痕模式等情況無法讀取
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 無法保存時只影響下次開啟 */
  }
}

const env = {
  supportsBlur: CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'),
  reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
};
const theme = ref<Theme>(resolveTheme(read(THEME_KEY), matchMedia('(prefers-color-scheme: dark)').matches));
const styleState = ref(resolveStyle(read(STYLE_KEY), env));

function apply() {
  const d = document.documentElement;
  d.dataset.theme = theme.value;
  d.dataset.style = styleState.value.style;
}

export function initTheme(): void {
  apply();
}

export function useTheme() {
  function setTheme(t: Theme) {
    theme.value = t;
    write(THEME_KEY, t);
    apply();
  }
  function setStyle(s: Style) {
    if (styleState.value.forced) return;
    styleState.value = { style: s, forced: false };
    write(STYLE_KEY, s);
    apply();
  }
  return {
    theme,
    style: computed(() => styleState.value.style),
    /** true = 瀏覽器不支援模糊或已開啟「減少透明度」,只能用扁平 */
    styleForced: computed(() => styleState.value.forced),
    setTheme,
    setStyle,
    toggleTheme: () => setTheme(theme.value === 'dark' ? 'light' : 'dark'),
    toggleStyle: () => setStyle(styleState.value.style === 'glass' ? 'flat' : 'glass'),
  };
}
