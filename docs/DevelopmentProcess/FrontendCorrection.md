# 前端修改紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。範圍:`frontend/`。

## 2026-11-03 F1 第 2 批:Log 明細查詢(PA、AD)
- 工作項目:F1
- 內容:改寫防火牆與 AD 的 Log 明細查詢。AD 串接 docs/API.md §6.2(後端分頁、匯出由後端產生,期間最長 31 天);PA 照 §4.3 改工作模式(送出 → 進度 → 分頁讀結果、停止 = 取消工作、匯出),**待後端** `feature/netops-b2-logs`,目前只接假 API `mock/paLog.ts`。網址條件只收白名單與格式正確的值(`composables/searchQuery.ts`),時間接受 `YYYY-MM-DD`(整天)、`YYYY-MM-DDTHH:mm` 與舊版 `YYYY/MM/DD HH:mm`,送 API 時轉 ISO 8601 含時區。展開列改對話框。下載改共用 `api/gateway.ts` 的 `download()`(fetch Blob、帶 CSRF、不帶 Bearer)。
- 檔案:`frontend/src/pages/{firewall,ad}/Search.vue`、`frontend/src/api/{ad,pa,gateway}.ts`、`frontend/src/composables/searchQuery.ts`、`frontend/mock/{ad,paLog,types,gateway}.ts`、`frontend/src/router.ts`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 2 批:流量總覽
- 工作項目:F1
- 內容:改寫防火牆流量總覽,串接 docs/API.md §4.1。KPI(允許 / 阻擋可點)、每小時連線數 / 流量改新元件 `ui/charts/GStackedBars.vue`(允許 / 阻擋堆疊、點長條帶該小時到明細查詢、鍵盤可操作)、流量排行(次數 / 流量切換)、資料外流與 AI 應用、阻擋與風險、動作分布、連線結束原因、疑似掃描。排行點選條件抽成 `composables/paDashboard.ts`(同舊版)。明細查詢的時間條件改為 `YYYY-MM-DDTHH:mm`。AI 分析不改寫(D17),按鈕另開舊版流量總覽。新增沒有資料 / 結果不完整提示。假 API `mock/pa.ts`。
- 檔案:`frontend/src/pages/firewall/Dashboard.vue`、`frontend/src/api/pa.ts`、`frontend/src/composables/paDashboard.ts`、`frontend/src/ui/charts/GStackedBars.vue`、`frontend/src/config/links.ts`、`frontend/mock/pa.ts`、`frontend/src/router.ts`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 2 批:安全事件
- 工作項目:F1
- 內容:改寫防火牆安全事件,串接 docs/API.md §4.2。log 類型改 `GSegmented`(`?type=` 記住目前類型)、期間兩個日期欄位(預設該類型最新一天、最長 92 天)、KPI(壞值標紅)、每小時事件數改 `GAreaChart`、排行改共用元件 `components/TopList.vue`。點含 IP 的排行另開舊版 AI 問答並帶入問題(`config/links.ts` 的 `legacyAskUrl`;D17、D18)。新增結果不完整提示(分析中、摘要讀不到、分析失敗)。假 API `mock/paEvents.ts`。
- 檔案:`frontend/src/pages/firewall/Events.vue`、`frontend/src/api/paEvents.ts`、`frontend/src/components/TopList.vue`、`frontend/src/config/links.ts`、`frontend/mock/paEvents.ts`、`frontend/src/router.ts`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 2 批:AD 事件總覽
- 工作項目:F1
- 內容:改寫 AD 事件總覽,串接 docs/API.md §6.1。期間改兩個日期欄位(預設最新一天、最長 92 天);KPI 改 `GStatCard`(點選帶條件到明細查詢,需 `netops.ad-search.read`);帳號與特權異動(新帳號隨即加入特權群組的提醒)、特權登入、需要注意的事件、事件排行、登入失敗的帳號 / IP / 原因。新增資料不完整提示:期間天數多於已匯入天數、上次同步失敗。「從 FTP 同步」依 `netops.ad-files.manage` 顯示,完成後自動更新。假 API `mock/ad.ts`。
- 檔案:`frontend/src/pages/ad/Events.vue`、`frontend/src/api/ad.ts`、`frontend/src/composables/{dates,adEvents}.ts`、`frontend/mock/ad.ts`、`frontend/src/router.ts`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 2 批:FTP Log 檔案(PA、AD)
- 工作項目:F1
- 內容:改寫防火牆與 AD 的「FTP Log 檔案」頁,串接 docs/API.md §5.1、§5.2(後端 B2-pa、B2-ad 已上線)。PA:log 類型目錄切換、FTP 路徑、日期分組(前一天 / 後一天)、檔名與狀態篩選、分析進度(TRAFFIC 與其他類型)、同步、分析 / 重新分析選取、取消、刪除分析結果;同步失敗時顯示 `lastSyncError`。AD:清單改工作模式(`composables/useJob.ts`,離開頁面取消工作)、同步、重新匯入選取(一次最多 60 天)、刪除匯入結果、Security 空檔提醒、每日檔案明細改對話框。寫入按鈕依 `netops.pa-files.manage` / `netops.ad-files.manage` 顯示。假 API 在 `mock/ftp.ts`。`base.css` 新增 `.c-success`、`.c-warning`、`.c-danger` 文字色。
- 檔案:`frontend/src/pages/firewall/Files.vue`、`frontend/src/pages/ad/Files.vue`、`frontend/src/api/{ftp,jobs,format}.ts`、`frontend/src/composables/{useJob,ftpFiles}.ts`、`frontend/mock/`、`frontend/src/router.ts`、`frontend/src/ui/styles/base.css`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 1 批:前端框架
- 工作項目:F1
- 內容:新增 `frontend/`(netops-web)。`src/ui/`(不含 `GHero`)、外框、選單、風格切換由入口網 giga-Portal 複製,路由守衛與 API 包裝比照 GigaItApp;`tokens.css` 換成工程藍(UI-GUIDE §2),元件不動。選單依 ARCHITECTURE §5 權限顯示,頁面先佔位;舊版 AI 問答與 Veeam 改一般連結(D11、D18)。沒有 `netops.app.access` 導回 `/?denied=netops`;`netops.ping.read` 時佔位頁顯示 `/api/netops/ping` 結果。gw.app 在 D1 才登記 netops,登記前以 `netops.app.access` 推導本系統。本機假 Gateway `mock/gateway.ts`(`MOCK=admin|viewer|noapp|anon`)只在 dev 啟用。CI 加 `check:frontend`(只檢查不部署)。
- 檔案:`frontend/`、`.gitlab-ci.yml`、`docs/UI-GUIDE.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`
- 驗證:`cd frontend && npm run typecheck && npm test && npm run build` 通過(4 檔 25 項);瀏覽器以 `MOCK=admin` 檢查玻璃 / 扁平 × 明亮 / 黑暗 × 1440px / 375px,文字對比最低 5.05:1、無水平捲動;`MOCK=viewer` 看到全部唯讀頁;`MOCK=noapp` 導回 `/?denied=netops`
- 審查:`code-reviewer`(連結排序與顯示條件、守衛抽成 `composables/guard.ts` 並補測試、移除未用的 `usePaged`)、`security-auditor`(無 Critical / High;Registry 走 HTTP、`GAppSwitcher` 未檢查 `basePath` 屬跨專案,另行回報)已修正或列入回報
