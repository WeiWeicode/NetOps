/**
 * 選單上的一般連結(ARCHITECTURE D11):另開分頁,使用者在該系統另行登入,不做同步登入。
 * 舊版 NetOps 的 AI 問答、AI 分析、語意搜尋與自動學習於 IMPL-PLAN A1 搬進新版(D23),不再連到舊版。
 * Veeam 沿用舊版 server/config.js 的預設 VEEAM_URL。
 */
export const LINKS = {
  veeam: 'https://gsmc-web.gigasolar.com.tw/Veeam',
} as const;
