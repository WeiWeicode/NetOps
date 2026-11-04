/**
 * 選單上的一般連結(ARCHITECTURE D11、D18):另開分頁,使用者在該系統另行登入,不做同步登入。
 * 舊版 IIS 在切換後仍提供 AI 問答與分析(D17),直到 AI 中控台接入。
 * TODO(待使用者確認網址):舊版 NetOps 的正式網址;Veeam 沿用舊版 server/config.js 的預設 VEEAM_URL。
 */
export const LEGACY_NETOPS_URL = 'https://gsmc-web.gigasolar.com.tw/NetOps';

export const LINKS = {
  paAsk: `${LEGACY_NETOPS_URL}/Main/PaAsk`,
  adAsk: `${LEGACY_NETOPS_URL}/Main/AdAsk`,
  veeam: 'https://gsmc-web.gigasolar.com.tw/Veeam',
} as const;

/**
 * 舊版 AI 問答並帶入問題(舊版 PaAsk 讀 ?q=問題&from=yyyy/MM/dd&to=yyyy/MM/dd,填入輸入框由使用者送出)。
 * from / to 為 YYYY-MM-DD。
 */
export function legacyAskUrl(q: string, from: string, to: string, source: 'pa' | 'ad' = 'pa'): string {
  const slash = (d: string) => d.replace(/-/g, '/');
  const qs = new URLSearchParams({ q, ...(from ? { from: slash(from), to: slash(to || from) } : {}) });
  return `${source === 'ad' ? LINKS.adAsk : LINKS.paAsk}?${qs}`;
}
