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
  // PR-2 / PR-4:安全規則(清單、變更紀錄、排序檢查、規則圖)
  paPolicyPage: 'netops.pa-policy-page.read',
  // TS-2 / TS-4:威脅特徵碼(清單、版本差異、命中比對、規則覆蓋)
  paSignaturePage: 'netops.pa-signature-page.read',
  paFiles: 'netops.pa-files.read',
  adEvents: 'netops.ad-events.read',
  adSearch: 'netops.ad-search.read',
  adFiles: 'netops.ad-files.read',
  kbPage: 'netops.kb-page.read',
  // AC3:IP 對照表(只給網管;PA 畫面的名稱不需要這個權限)
  ipNamePage: 'netops.ip-name-page.read',
  // SG-1:網段設定(戰情室內部網段;只給網管)
  segmentPage: 'netops.segment-page.read',
  // A1:AI 問答(選單只綁該頁的讀取權限;使用 AI 由按鈕 UI.paAskUse / UI.adAskUse 綁定 netops.ai.use)
  paAsk: 'netops.pa-ask.read',
  adAsk: 'netops.ad-ask.read',
} as const;

export const UI = {
  paFilesManage: 'netops.pa-files.manage',
  // 測試區暫停 / 繼續收集器(只給 netops-admin;正式區 API 回 403)
  paLiveManage: 'netops.pa-live.manage',
  // C5 PA 精準查詢(XML API log、Session Browser;只給 netops-admin,CQ7)
  paLiveQuery: 'netops.pa-live.query',
  adFilesManage: 'netops.ad-files.manage',
  kbWrite: 'netops.kb-page.write',
  ipNameWrite: 'netops.ip-name-page.write',
  segmentWrite: 'netops.segment-page.write',
  // A1:netops.ai.use 不是 .read,只能由按鈕綁定(deploy/gateway-rbac.yaml)
  paAskUse: 'netops.pa-ask.use',
  adAskUse: 'netops.ad-ask.use',
  paDashboardAi: 'netops.pa-dashboard.ai',
  // AC4:熱力圖的時段明細「AI 解讀這個時段」、儀表板「AI 摘要本期異常」與其時段明細(POST /ai/explanations)
  paHeatmapAi: 'netops.pa-heatmap.ai',
  paInsightAi: 'netops.pa-insight.ai',
  // AC5:熱力圖「AI 指出異常格」與時段明細威脅列沿用上面兩個;Log 明細查詢威脅列「AI 說明威脅」
  paSearchAi: 'netops.pa-search.ai',
  // AC6:安全事件頁「AI 摘要安全事件」(四類一起)
  paEventsAi: 'netops.pa-events.ai',
  // WR-3:戰情室 AI 每小時分析「立即分析」(includes netops.ai.use;節點由後端 WR-3 登記 deploy/gateway-rbac.yaml)
  paLiveAi: 'netops.pa-live.ai',
  // PR-2:安全規則手動重新整理(只給網管)
  paPolicyRefresh: 'netops.pa-policy-page.refresh',
  // PR-5:排序檢查「AI 判讀」(includes netops.ai.use)
  paPolicyAi: 'netops.pa-policy-page.ai',
  // TS-2:威脅特徵碼手動重新整理(只給網管)與 AI 摘要(admin + viewer)
  paSignatureRefresh: 'netops.pa-signature-page.refresh',
  paSignatureAi: 'netops.pa-signature-page.ai',
} as const;

export const API = {
  ping: 'netops.ping.read',
  paRealtime: 'netops.pa-realtime.read',
  paRealtimeWrite: 'netops.pa-realtime.write',
  paRead: 'netops.pa.read',
  paLogRead: 'netops.pa-log.read',
  paQueryRead: 'netops.pa-query.read',
  ftpRead: 'netops.ftp.read',
  ftpWrite: 'netops.ftp.write',
  adRead: 'netops.ad.read',
  adLogRead: 'netops.ad-log.read',
  kbRead: 'netops.kb.read',
  kbWrite: 'netops.kb.write',
  ipNameRead: 'netops.ip-name.read',
  ipNameWrite: 'netops.ip-name.write',
  segmentRead: 'netops.segment.read',
  segmentWrite: 'netops.segment.write',
  aiUse: 'netops.ai.use',
  paPolicyRead: 'netops.pa-policy.read',
  paPolicyRefresh: 'netops.pa-policy.refresh',
  paSignatureRead: 'netops.pa-signature.read',
  paSignatureRefresh: 'netops.pa-signature.refresh',
} as const;
