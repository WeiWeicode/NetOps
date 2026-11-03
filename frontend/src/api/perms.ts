/**
 * 本系統的權限代碼(ARCHITECTURE §5;D1 登記到 deploy/gateway-rbac.yaml)。
 *   NETOPS:應用與選單(kind app / menu);UI:按鈕(kind button);API:netops-api 的 x-permission(BFF 檢查)
 * 頁面可見 = 選單權限 ∩ 該頁需要的 API 讀取權限(requires);按鈕權限只是體驗,BFF 一定再以 API 權限檢查。
 */
export const NETOPS = {
  app: 'netops.app.access',
  paDashboard: 'netops.pa-dashboard.read',
  paEvents: 'netops.pa-events.read',
  paSearch: 'netops.pa-search.read',
  paFiles: 'netops.pa-files.read',
  adEvents: 'netops.ad-events.read',
  adSearch: 'netops.ad-search.read',
  adFiles: 'netops.ad-files.read',
  kbPage: 'netops.kb-page.read',
} as const;

export const UI = {
  paFilesManage: 'netops.pa-files.manage',
  adFilesManage: 'netops.ad-files.manage',
  kbWrite: 'netops.kb-page.write',
} as const;

export const API = {
  ping: 'netops.ping.read',
  paRead: 'netops.pa.read',
  paLogRead: 'netops.pa-log.read',
  ftpRead: 'netops.ftp.read',
  ftpWrite: 'netops.ftp.write',
  adRead: 'netops.ad.read',
  adLogRead: 'netops.ad-log.read',
  kbRead: 'netops.kb.read',
  kbWrite: 'netops.kb.write',
} as const;
