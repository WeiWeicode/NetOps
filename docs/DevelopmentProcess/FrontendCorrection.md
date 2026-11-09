# 前端修改紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。範圍:`frontend/`。

## 2026-11-09 A1-frontend:移除翻譯與「請 AI 記錄」(決定不搬)
- 工作項目:A1(`feature/a1-ai-frontend`;需求方 2026-11-09 依 `docs/AI-FEATURE-INVENTORY.md` 決定翻譯(#5)與整理筆記(#6)不搬,ARCHITECTURE D25)
- 內容:合併 `feature/a1-ai-api`(後端已拿掉 `/ai/translations`、`/ai/notes`)後,前端拿掉 `components/TranslateBox.vue`(問答與 AI 分析下方的翻譯)、問答頁的「記錄到知識庫」按鈕與「請記錄:…」判斷(`NOTE_RE`、`record()`、筆記結果的顯示)、由連結帶入時的「請確認」提示(原本只為防止連結誘導寫入知識庫)、`api/ai.ts` 的 `translate`、`note`、`TRANSLATE_LANGS`;假 Gateway 拿掉兩支 API。問答頁改提示「要補充環境資訊,請到知識庫新增筆記」。權限代碼不變(問答頁原本用的 `UI.kbWrite` 是知識庫頁既有的按鈕代碼)。
- 檔案:`frontend/src/{api/ai.ts,composables/aiChat.ts,components/{AiAnalysis,TranslateBox(刪除)}.vue,pages/ai/Ask.vue}`、`frontend/mock/ai.ts`、`frontend/test/ai.test.ts`、`docs/Gherkin/{ui/ai.feature,README.md}`、`docs/UI-GUIDE.md`
- 驗證:`npm run typecheck`、`npm test`(78 項通過;移除前 79 項,拿掉「請記錄」判斷 1 項)、`npm run build`

## 2026-11-05 A1-frontend 審查修正
- 工作項目:A1(第 3 批;`code-reviewer`、`security-auditor` 審查後)
- 內容:① AI 回答(`AiMarkdown` → `renderMarkdown(text, { ai: true })`):不同網域的連結改成「文字(網址)」純文字、不顯示圖片(模型可能被 log / RDAP 內容誘導出釣魚連結;圖片會自動帶 Cookie 發 GET);知識庫筆記不變。② 由連結(`?q=`)帶入的問題,第一次送出一律當成問題,不因「請記錄」字樣改寫入知識庫,並提示「問題由連結帶入」。③ 串流沒收到 `done` 就結束時丟 `NETOPS_STREAM_INCOMPLETE`(保留已收到的內容並標示不完整;舊版當成完成);結束或丟錯時 `reader.cancel()`;最後一段沒有結尾空行也處理。④ 停止時標示「已停止,回答不完整」,不放進之後的對話紀錄;「看原始紀錄」用送出那一題的期間。⑤ `IpLearning` 輪詢:卸載後不再排程,只有最新一次查詢可以排下一輪(不會重複輪詢);天數與筆數送出前限制範圍。⑥ 知識庫:語意搜尋等全部回應取回後才更新畫面(連續查詢不互相覆蓋),新增 / 修改 / 刪除後也更新匯整檔資訊;勾選語意搜尋改用 `watch`;向量庫同步中每 3 秒查狀態直到結束,離開頁面時清除。⑦ 權限:記錄到知識庫用按鈕代碼 `UI.kbWrite`(同知識庫頁);安全事件頁點 IP 改檢查 `UI.paAskUse`。⑧ 無障礙:對話列表 `aria-live`、狀態 `role="status"`、輸入框加標籤。
- 檔案:`frontend/src/{api/ai.ts,composables/{markdown,aiChat}.ts,components/{AiMarkdown,AiAnalysis,IpLearning}.vue,pages/ai/Ask.vue,pages/knowledge/Knowledge.vue,pages/firewall/Events.vue}`、`frontend/mock/ai.ts`、`frontend/test/ai.test.ts`、`docs/Gherkin/ui/ai.feature`
- 驗證:`npm run typecheck`、`npm test`(79 項通過,新增 2 項)、`npm run build`;`MOCK=admin` 瀏覽器確認:連結帶入「請記錄:…」送出後走問答、沒有寫入;外部連結變純文字、同網域連結可點、圖片拿掉
- 未改:SPA 內登出再換人登入時,模組層級的對話會保留(web-kit 登出是整頁導向入口網,目前不會發生;之後若改成不重新載入要清掉)

## 2026-11-05 A1-frontend:AI 問答、AI 分析、翻譯、知識庫 AI 功能
- 工作項目:A1(第 3 批 `feature/a1-ai-frontend`,從第 2 批開出)
- 內容:舊版 AI 畫面搬進新版(ARCHITECTURE D23):① `pages/ai/Ask.vue`(PA `/firewall/ask`、AD `/ad/ask` 共用;由舊版 `src/views/PaAsk.vue` 搬移):SSE 串流顯示查詢進度、查到的資料、PA 其他 log、AD 事件、參考的知識庫筆記與回答;追問、停止、清除、複製、翻譯、看原始紀錄(帶條件到明細查詢)、範例問題;有 `netops.kb.write` 可「記錄到知識庫」(或輸入「請記錄:…」);對話放在模組層級的 reactive(`composables/aiChat.ts`,切頁回來還在,重新整理清空,不存 localStorage)。② `components/AiAnalysis.vue`:流量總覽的「AI 分析」對話框(按鈕權限 `netops.pa-dashboard.ai`)。③ `components/TranslateBox.vue`、`AiMarkdown.vue`(一律經 DOMPurify)。④ 知識庫頁:語意搜尋(勾選後依相近度排序、顯示相近度)、向量庫狀態(只搜尋不同步時註明;開啟同步時有「立即同步」)、外部 IP 自動學習對話框(`components/IpLearning.vue`,執行中每 2 秒查狀態,完成後重新整理清單)。⑤ `api/ai.ts`:POST SSE 以 `fetch` 讀串流,帶 Cookie 與 CSRF、不帶 Bearer,401 先 Refresh;串流開始前的錯誤是 `ApiError`,`error` 事件是 `AiStreamError`。⑥ 移除連到舊版 NetOps 的連結(`config/links.ts` 只剩 Veeam):選單的「AI 問答(舊版)」改成新版頁面;安全事件頁點 IP 改到新版 AI 問答(沒有 AI 問答權限時不可點)。⑦ `api/perms.ts`:`NETOPS.paAsk` / `adAsk`、`UI.paAskUse` / `adAskUse` / `paDashboardAi`、`API.aiUse`。⑧ 假 Gateway `mock/ai.ts`(`MOCK=admin`):固定的 SSE 事件、翻譯、整理筆記、向量庫狀態、外部 IP 學習。
- 與舊版不同:對話紀錄只送最近 20 則(後端只用最近 6 則);AI 回答與知識庫一樣用 `composables/markdown.ts` 清理(連結另開分頁、外部圖片拿掉);深入思考改成 GCheckbox;日期改兩個 `datetime-local`;服務資訊不再寫死主機位址(舊版畫面寫 10.10.130.45)。
- 檔案:`frontend/src/{api/ai.ts,api/perms.ts,composables/aiChat.ts,components/{AiMarkdown,AiAnalysis,TranslateBox,IpLearning}.vue,pages/ai/{Ask,PaAsk,AdAsk}.vue,pages/firewall/{Dashboard,Events}.vue,pages/knowledge/Knowledge.vue,router.ts,config/links.ts}`、`frontend/mock/{ai,gateway,types}.ts`、`frontend/test/{ai,links}.test.ts`、`docs/Gherkin/ui/{ai,navigation}.feature`、`docs/UI-GUIDE.md`
- 驗證:`npm run typecheck`、`npm test`(13 檔 77 項通過,新增 10 項)、`npm run build`;以 `MOCK=admin` 本機假 Gateway 在瀏覽器確認:AI 問答串流顯示(查到的資料、掃描逾時資料不完整、其他 log、知識庫、Markdown 表格、惡意 `onerror` 已清掉)、翻譯、流量總覽 AI 分析(摘要讀不到的提示)、外部 IP 學習輪詢完成。經 Gateway 的實際串流待測試區驗收
## 2026-11-05 R1 即時監控頁(防火牆群組最上方)
- 工作項目:R1
- 內容:新增 `/firewall/live`「即時監控」(選單 `netops.pa-live.read`,API `netops.pa-realtime.read`;`deploy/gateway-rbac.yaml` 登記節點 sort 5 並加入 `netops-admin`、`netops-viewer`)。設備狀態(Session、管理 / 資料平面 CPU、整體流量、介面流量;快照過期顯示「停止更新」)、最近 1 小時趨勢、即時排行(類型 × 5 / 15 / 60 分鐘)、即時 log(EventSource 串流、類型切換、IP / Port / Action 篩選、暫停、最多 500 筆、標示 Redis 最早時間並連到 Log 明細查詢)。收集器停止、未啟用、Redis 連不上時頁首明確提示,排行與 log 標示「不是即時的」(AGENT §5)。串流非 200 時改用一般 API 檢查登入並 10 秒後重連,串流斷線期間每 10 秒輪詢快照。假 Gateway `mock/paLive.ts`(`MOCK_PA_LIVE=stopped|disabled|unavailable`)。
- 檔案:`frontend/src/pages/firewall/Live.vue`、`frontend/src/api/paLive.ts`、`frontend/src/composables/paLive.ts`、`frontend/src/router.ts`、`frontend/src/api/perms.ts`、`frontend/src/ui/icons.ts`、`frontend/mock/{paLive,gateway}.ts`、`frontend/test/paLive.test.ts`、`deploy/gateway-rbac.yaml`
- 依 `code-reviewer` 審查修正:預載 log 接在串流之後(不打亂順序)、切換類型時丟棄舊請求、處理 SSE `degraded`、串流卡住或快照 API 失敗時不顯示舊數字。`security-auditor` 因額度中斷未完成(見 MR)。
- 驗證:`npm run typecheck`、`npm test`(72 passed)、`npm run build`;內建瀏覽器以假 Gateway 檢查正常與 `stopped` 狀態(API 皆 200、停止時不顯示舊數字)

## 2026-11-05 D1 驗收修正:FTP 勾選、AD 清單改手動、導回時不回報錯誤
- 工作項目:D1(驗收報告 `docs/test-reports/2026-11-05-d1-uat-pending.md` §3.1、§4.2、§4.4)
- 內容:① PA「FTP Log 檔案」:後端只分析 TRAFFIC 目錄直屬(`path === logDir`)與各類型目錄的檔案,其他目錄(例如 `FTP_LOG_DIR` 之外的 `/my-data`)勾了一定被略過。選改動最小的做法:**這些目錄不顯示勾選框與全選 / 分析 / 刪除列**,改顯示「這個目錄的檔案只能瀏覽,不能分析」與 TRAFFIC 目錄(`ftpFiles.ts` `analyzableDir`;API 不變)。略過時的 toast 也寫明 TRAFFIC 目錄。② AD「FTP Log 檔案」:依需求方決定,載入時只查 `GET /ftp/ad/status`,不送 `POST /ftp/ad/listings`;有 `netops.ad-files.manage` 的人按「列出 FTP 資料夾」才送出,沒有的人看不到按鈕(改顯示「重新整理」只更新同步狀態);同步 / 匯入結束時只在已列過清單時才重新列出。③ 未登入或沒有應用權限時,守衛 `return false` 中止第一次導覽,`router.isReady()` 以不帶訊息的 NavigationFailure 拒絕,`App.vue` 的 `.finally()` 讓它變成未處理的 Promise 拒絕,被 web-kit 監控回報成 `netops-web` 錯誤(正式建置堆疊對到 vue-router 的 `createRouterError`)。改成導覽中止時吞掉並維持載入畫面(`guard.ts` `isLeavingNavigation`),其他錯誤照常回報。
- 檔案:`frontend/src/pages/firewall/Files.vue`、`frontend/src/pages/ad/Files.vue`、`frontend/src/composables/{ftpFiles,guard}.ts`、`frontend/src/App.vue`、`frontend/test/{ftpFiles,guard}.test.ts`、`docs/Gherkin/{ftp/*,ui/navigation}.feature`
- 驗證:`npm run typecheck`、`npm test`(12 檔 67 項通過,新增 4 項)、`npm run build`;畫面未在瀏覽器實測(合併後於測試區重驗,見 HANDOFF「2026-11-05」)

## 2026-11-04 D1:前端 SPA 映像與發佈腳本
- 工作項目:D1
- 內容:新增 `frontend/Dockerfile`、`frontend/publish.sh`、`.dockerignore`(同 GigaItApp、giga-Portal):建置 `dist` 後以一次性容器發佈到 Gateway 的 `gw_www`,`/srv/www/netops/current` symlink 原子切換、保留 5 版、可回滾;`publish.sh` 只接受 `netops`,不會動到其他系統的目錄。版本名稱(commit SHA)同時作為 web-kit 監控回報的 `VITE_RELEASE`。畫面程式沒有修改。
- 檔案:`frontend/Dockerfile`、`frontend/publish.sh`、`frontend/.dockerignore`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 3 批:收尾
- 工作項目:F1
- 內容:所有頁面改寫完成,移除 `frontend/` 內的過渡程式:佔位頁 `pages/WipPage.vue`、`components/PingCard.vue`、`api/netops.ts`(`/api/netops/ping` 只在佔位頁用)、路由的 `wip()` 與假 Gateway 的 ping。舊版 `src/`、`server/`、根目錄的 Element Plus / Tailwind 依 D12、D18 暫不刪(見 UI-GUIDE §4)。
- 檔案:`frontend/src/router.ts`、`frontend/mock/gateway.ts`、`docs/UI-GUIDE.md`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 2 批:知識庫
- 工作項目:F1
- 內容:改寫知識庫,串接 docs/API.md §7(後端 B2-kb !10)。筆記查詢(後端分頁)、閱讀、下載 .md、匯整檔預覽與下載;有 `netops.kb-page.write` 可新增、修改、刪除(對話框,標題 300 字、內容 20,000 字、IP 30 個、標籤 10 個)。Markdown 以 `marked` 轉換後一律經 `DOMPurify`(`composables/markdown.ts`;連結另開分頁並加 rel,禁 style / form / iframe;AGENT.md §7.4)。新增相依 `marked`、`dompurify`(版本同舊版,AGENT.md §7.4 要求 DOMPurify)。不改寫(D17):語意搜尋、向量同步、外部 IP 自動學習、在 AI 問答請 AI 記錄 → 連到舊版。假 API `mock/kb.ts`(含惡意 HTML 範例)。
- 檔案:`frontend/src/pages/knowledge/Knowledge.vue`、`frontend/src/api/kb.ts`、`frontend/src/composables/markdown.ts`、`frontend/src/config/links.ts`、`frontend/mock/kb.ts`、`frontend/package.json`
- 驗證:見 MR 描述

## 2026-11-03 F1 第 2 批:Log 明細查詢(PA、AD)
- 工作項目:F1
- 內容:改寫防火牆與 AD 的 Log 明細查詢。AD 串接 docs/API.md §6.2(後端分頁、匯出由後端產生,期間最長 31 天);PA 照 §4.3 改工作模式(送出 → 進度 → 分頁讀結果、停止 = 取消工作、匯出;期間最長 31 天、Port 格式檢查、stopReason 含 closed / error),串接後端 B2-logs(!11);本機 `MOCK` 模式用 `mock/paLog.ts`。網址條件只收白名單與格式正確的值(`composables/searchQuery.ts`),時間接受 `YYYY-MM-DD`(整天)、`YYYY-MM-DDTHH:mm` 與舊版 `YYYY/MM/DD HH:mm`,送 API 時轉 ISO 8601 含時區。展開列改對話框。下載改共用 `api/gateway.ts` 的 `download()`(fetch Blob、帶 CSRF、不帶 Bearer)。
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
