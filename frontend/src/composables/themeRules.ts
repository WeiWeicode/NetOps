/** 明暗與風格的判斷規則(純函式,供 theme.ts 與測試使用;public/theme-init.js 需保持相同規則) */
export type Theme = 'light' | 'dark';
export type Style = 'glass' | 'flat';

/** 不支援模糊或使用者要求減少透明度時一律扁平(FR-6.4) */
export function resolveStyle(saved: string | null, env: { supportsBlur: boolean; reducedTransparency: boolean }): { style: Style; forced: boolean } {
  if (!env.supportsBlur || env.reducedTransparency) return { style: 'flat', forced: true };
  return { style: saved === 'flat' ? 'flat' : 'glass', forced: false };
}

export function resolveTheme(saved: string | null, prefersDark: boolean): Theme {
  if (saved === 'light' || saved === 'dark') return saved;
  return prefersDark ? 'dark' : 'light';
}
