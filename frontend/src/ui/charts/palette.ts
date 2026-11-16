/** 圖表色盤:對應 tokens.css 的 --chart-N 與語意 tone(圖表元件只從這裡取色) */
export const CHART_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];

export const chartColor = (i: number) => `var(${CHART_VARS[i % CHART_VARS.length]})`;

const TONE_VARS: Record<string, string> = {
  primary: '--c-primary',
  info: '--c-info',
  success: '--c-success',
  warning: '--c-warning',
  danger: '--c-danger',
  cyan: '--c-cyan',
  violet: '--c-violet',
  solar: '--c-accent-solar',
  storage: '--c-accent-storage',
  neutral: '--text-3',
};
export const toneColor = (tone: string) => `var(${TONE_VARS[tone] ?? '--c-primary'})`;

let seq = 0;
/** SVG gradient id(同頁多個圖表不衝突) */
export const uid = (p: string) => `${p}-${++seq}`;
