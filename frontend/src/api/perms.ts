/**
 * 本系統的權限代碼(ARCHITECTURE §5;D1 登記到 deploy/gateway-rbac.yaml)。
 *   NETOPS:應用與選單(kind app / menu);UI:按鈕(kind button);API:netops-api 的 x-permission(BFF 檢查)
 * 頁面可見 = 選單權限 ∩ 該頁需要的 API 讀取權限(requires);按鈕權限只是體驗,BFF 一定再以 API 權限檢查。
 */
export const NETOPS = {
  app: 'netops.app.access',
  paLive: 'netops.pa-live.read',
  paDashboard: 'netops.pa-dashboard.read',
  // V-b1:活動熱力圖、分析儀表板(VIZ-RULES-DESIGN §4.8;點格子 / 圖表開時段明細要 netops.pa-log.read,節點已 includes)
  paHeatmap: 'netops.pa-heatmap.read',
  paInsight: 'netops.pa-insight.read',
  paEvents: 'netops.pa-events.read',
  paSearch: 'netops.pa-search.read',
  paFiles: 'netops.pa-files.read',
  adEvents: 'netops.ad-events.read',
  adSearch: 'netops.ad-search.read',
  adFiles: 'netops.ad-files.read',
  kbPage: 'netops.kb-page.read',
  // A1:AI 問答(選單只綁該頁的讀取權限;使用 AI 由按鈕 UI.paAskUse / UI.adAskUse 綁定 netops.ai.use)
  paAsk: 'netops.pa-ask.read',
  adAsk: 'netops.ad-ask.read',
} as const;

export const UI = {
  paFilesManage: 'netops.pa-files.manage',
  // 測試區暫停 / 繼續收集器(只給 netops-admin;正式區 API 回 403)
  paLiveManage: 'netops.pa-live.manage',
  adFilesManage: 'netops.ad-files.manage',
  kbWrite: 'netops.kb-page.write',
  // A1:netops.ai.use 不是 .read,只能由按鈕綁定(deploy/gateway-rbac.yaml)
  paAskUse: 'netops.pa-ask.use',
  adAskUse: 'netops.ad-ask.use',
  paDashboardAi: 'netops.pa-dashboard.ai',
} as const;

export const API = {
  ping: 'netops.ping.read',
  paRealtime: 'netops.pa-realtime.read',
  paRealtimeWrite: 'netops.pa-realtime.write',
  paRead: 'netops.pa.read',
  paLogRead: 'netops.pa-log.read',
  ftpRead: 'netops.ftp.read',
  ftpWrite: 'netops.ftp.write',
  adRead: 'netops.ad.read',
  adLogRead: 'netops.ad-log.read',
  kbRead: 'netops.kb.read',
  kbWrite: 'netops.kb.write',
  aiUse: 'netops.ai.use',
} as const;
