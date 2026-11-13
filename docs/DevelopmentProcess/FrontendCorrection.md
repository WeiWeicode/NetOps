# 前端修改紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。範圍:`frontend/`。

## 2026-11-13 AI 分析與問答顯示 ClickHouse 來源(AC2)
- 工作項目:AC2(需求方:這次前端 UI 也由 Claude 完成)
- 內容:`components/AiAnalysis.vue`:ClickHouse 來源顯示每小時摘要小時數、每天彙總天數、摘要未建好 / 未更新、期間早於最早資料;有較粗的期間時以警告框註明「超過 30 天的資料較粗」與期間。`pages/ai/Ask.vue`:問答的查詢結果改顯示 ClickHouse 欄位(符合筆數、允許 / 阻擋、組合數、範例數、查詢秒數、組合太多不完整、超過保留期限沒有查的期間);整體統計顯示小時 / 天數與較粗提示。`composables/aiChat.ts`:`Evidence` 加 ClickHouse 欄位、`Grain`、`coarseNote()`;`scan` 的 ClickHouse 狀態文字。外部 IP 學習天數上限 30(`components/IpLearning.vue`)。mock 改為 ClickHouse 事件。FTP 來源(正式區 C6 前)的畫面不變。
- 檔案:`frontend/src/components/AiAnalysis.vue`、`frontend/src/pages/ai/Ask.vue`、`frontend/src/composables/aiChat.ts`、`frontend/src/components/IpLearning.vue`、`frontend/mock/ai.ts`、`frontend/test/ai.test.ts`
- 驗證:typecheck、`npm test`、build;mock 下 1440 / 375 px 與鍵盤操作

## 2026-11-13 FTP Log 檔案頁「每日自動同步」卡片(AC1)
- 工作項目:AC1(需求方:這次前端 UI 也由 Claude 完成)
- 內容:新增 `components/DailySyncCard.vue`:今天這一輪的狀態、前一天完成幾類、上次檢查 / 列 FTP 時間、FTP 保留期限內每類型每天的格子(已匯入 / 處理中 / 失敗 / 尚無檔案,含無障礙文字與圖例)、失敗與停止重試提示、未啟用說明;第一欄固定、窄螢幕表格內水平捲動,頁面不溢出。防火牆 › FTP Log 檔案顯示全部類型,AD 網域 › FTP Log 檔案只顯示 AD。`api/ftp.ts` 加 `DailySyncStatus`;`composables/ftpFiles.ts` 加顯示對照與純函式;mock 加 `daily`。
- 檔案:`frontend/src/components/DailySyncCard.vue`、`frontend/src/api/ftp.ts`、`frontend/src/composables/ftpFiles.ts`、`frontend/src/pages/firewall/Files.vue`、`frontend/src/pages/ad/Files.vue`、`frontend/mock/ftp.ts`、`frontend/test/dailySync.mount.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`;`MOCK=admin` 桌機與 375 px 亮色檢視(見 MR)

## 2026-11-13 Log 明細查詢接威脅 log、抽屜嚴重度只在威脅類、國家分方向與內部網段(V-b2 驗收 C7 第二輪、C7b)
- 工作項目:V-b2 驗收追加(需求方 2026-11-13 決定)
- 內容:`PA_SEARCH_KEYS` 加 type、threat、severity、srcCountry、dstCountry;Log 明細查詢頁加類型 / 威脅名稱 / 嚴重度 / 來源國家 / 目的國家欄位與威脅結果欄位(最小可用版,樣式交 Gemini),「未套用」提示只留無法套用的條件;`useSlice` 加 `supportsSeverity`(流量類抽屜不顯示嚴重度 chip)、`setSeverity` 只對威脅類;`searchExtraOf` / `topLabelOf`:來源 / 目的國家分方向,PA 國家欄位是網段範圍時顯示「內部網路 10.0.0.0/8」並改帶 src / dst CIDR(`searchQuery.countryRange`)。mock 支援 type=THREAT。
- 檔案:`frontend/src/api/pa.ts`、`frontend/src/composables/searchQuery.ts`、`frontend/src/composables/useSlice.ts`、`frontend/src/components/SliceDrawer.vue`、`frontend/src/pages/firewall/Search.vue`、`frontend/mock/paLog.ts`、`frontend/test/*`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`(見 MR)

## 2026-11-13 C7 第二輪:來源 / 目的 IP 帶入方向、未套用提示保留、時段明細逾時可重試

- 內容:`SearchExtra` 加 `filterSrc` / `filterDst`(抽屜來源 / 目的 IP 改用);`searchQuery.ignoredThreatCond()` 抽成純函式,Log 明細頁進頁時算一次;`slice.get` 可帶 `signal`,`useSlice` 加 45 秒逾時(`SLICE_TIMEOUT_MS`、`SliceTimeoutError`)與 `retryable`。抽屜的一般錯誤區塊目前沒有「重試」按鈕,交 Gemini 依 `retryable` 補(呼叫 `slice.retry()`)。
- 檔案:`composables/useSlice.ts`、`api/slice.ts`、`components/SliceDrawer.vue`、`composables/searchQuery.ts`、`pages/firewall/Search.vue`、`test/viz.test.ts`、`test/viz.mount.test.ts`、`test/searchQuery.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`(見 MR)

## 2026-11-13 時段明細抽屜邏輯層:不適用、嚴重度重查、跳 Log 條件、移除 AD 異常(C3–C5、C7–C9)
- 工作項目:V-b1(V-b2 第一輪驗收;Gemini U1–U10 `ba410a4` 的後續)
- 內容:
  - C3 `useSlice.summary`:威脅類的 `bytes` / `sent` / `recv` 為 `null`(API 回 0),抽屜總流量顯示「不適用」、不顯示上傳 / 下載。
  - C4 `useSlice.setSeverity(sev | null)`:威脅類只加 `severity`;流量類切成威脅類並只保留 IP 條件(和摘要 threats 的計算範圍一致);`null` 回到點嚴重度之前的條件,`open()` 新條件時清掉。抽屜的 chip 與「清除篩選」改呼叫它,拿掉前端過濾(Top 10 與明細由後端依嚴重度計算)。
  - C5 `useHeatmap.METRIC_OPTIONS` 移除 `ad`、`metric` 型別改 `PaHeatMetric`;`Heatmap.vue` 拿掉 `visibleMetricOptions` 過濾。`useInsight.InsightView` 已經沒有 `ad`。
  - C7 `openInSearch(extra?: { filterIp, filterApp, filterPort, filterCountry, filterThreat, severity })`(另有 `searchTarget(extra)` 回傳路由):目前條件 + 點選項目寫進 `/firewall/search` query,點 IP 時以點選的 IP 取代來源 / 目的條件;威脅類帶 `type=THREAT`、`threat`、`severity`,`searchLink` 不再只限 TRAFFIC。抽屜拿掉 `(props.slice.openInSearch as …)` 型別轉換,威脅名稱改帶 `filterThreat`(原本從名稱抓 IP 或丟進關鍵字)。Log 明細查詢頁只查 TRAFFIC,收到這三個條件時顯示「未套用」提示(AGENT §5,不靜默忽略)。
  - 抽屜威脅明細的名稱欄 key 由 `threatName` 改 `name`(API.md §4.4 threat 明細欄位是 `name`,原本真實資料這欄會是空的)。
  - 程式碼審查:`useSlice` 內部的 `run` 先同步換掉 `query` 再取消舊工作(連點同一個 chip 取消不會被吞掉);`Search.vue` 的未套用提示改 `computed`。
  - C8 mock `sliceResult`:`type=threat` 的明細列補 `severity`、`name`(依 API 欄位名,不用 `threatName`),並依 `severity` 篩選摘要、排行與明細;`mock/viz.ts` 轉送 `severity`。
  - C9 `viz.mount.test.ts`:`null` 格按 Enter 不發 `select`、年視圖直式座標、AD 異常按鈕 / Tab 不存在;新增抽屜 C3 / C4 / C7 掛載測試;`viz.test.ts` 新增 `summary`、`setSeverity`、`searchTarget` 測試,AD 停用測試改成選項不存在。
- 檔案:`frontend/src/composables/useSlice.ts`、`useHeatmap.ts`、`src/api/slice.ts`、`src/components/SliceDrawer.vue`、`src/pages/firewall/Heatmap.vue`、`Insight.vue`(註解)、`Search.vue`、`mock/fixtures/viz.ts`、`mock/viz.ts`、`test/viz.test.ts`、`test/viz.mount.test.ts`、`docs/VIZ-RULES-DESIGN.md` §6
- 驗證:`npm run typecheck`、`npm test`、`npm run build` 通過(數字見 MR)

## 2026-11-13 前端部署建置失敗:假資料產生器移出 test/、CI 加建置內容檢查
- 工作項目:V-b1 / V-b2 後續(develop pipeline 920 `deploy-web-test` job 2846 失敗,11-11 起前端沒有部署上去)
- 原因:`vite.config.ts` 一定會載入 `mock/gateway.ts`(沒設 MOCK 也載入)→ `mock/viz.ts` → `../test/fixtures/viz/generate.ts`;`frontend/.dockerignore` 排除 `test`,Docker 建置找不到檔案(`UNRESOLVED_IMPORT`)。`check:frontend` 在完整 repo 裡 build,看得到 test/,所以 CI 沒抓到
- 內容:① `test/fixtures/viz/generate.ts` 移到 `mock/fixtures/viz.ts`(內容不變),`mock/viz.ts` 與 `test/viz.test.ts`、`test/viz.mount.test.ts` 改從這裡 import;`.dockerignore` 不變(test 不進映像)。② `deploy/ci-web-build-context.sh`:把 frontend/ 版控內的檔案扣掉 `.dockerignore` 的路徑複製到 `frontend/.build-context/` 再 `npm run build`(套件沿用 `frontend/node_modules`),`check:frontend` 最後執行
- 檔案:`frontend/mock/{viz.ts,fixtures/viz.ts}`、`frontend/test/{viz,viz.mount}.test.ts`、`deploy/ci-web-build-context.sh`、`.gitlab-ci.yml`、`.gitignore`、`docs/{HANDOFF-GEMINI-VIZ,PROJECT-MAP}.md`
- 驗證:`npm run typecheck`、`npm test`(164 通過)、`npm run build`;刪掉 test/ 的副本 `npm ci` + `npm run build` 成功;`ci-web-build-context.sh` 在修正後通過,把 import 改回 `../test/fixtures/...` 時重現同一個 `UNRESOLVED_IMPORT` 而失敗

## 2026-11-12 C5 PA 精準查詢(邏輯層與最小介面)
- 工作項目:C5
- 內容:`api/paQuery.ts`、`composables/usePaQuery.ts`(按鈕權限才呼叫 API、送出 → 每 2 秒輪詢最多 90 秒、429 倒數、rejected / failed)、`components/PaQueryPanel.vue`(即時監控頁的樸素版,正式畫面交 Gemini,HANDOFF-GEMINI-VIZ §10)、`perms.ts` 加 `UI.paLiveQuery`、`API.paQueryRead`;假 Gateway `mock/paQuery.ts` 與 admin 的按鈕權限
- 檔案:`frontend/src/{api/paQuery.ts,api/perms.ts,composables/usePaQuery.ts,components/PaQueryPanel.vue,pages/firewall/Live.vue}`、`frontend/mock/{paQuery,gateway}.ts`、`frontend/test/paQuery.test.ts`
- 審查修正(2026-11-12):冷卻剩餘秒數依時間遞減、歸零後重讀狀態(原本按鈕停用到重新整理);輪詢連續失敗 3 次才放棄;429 倒數結束清掉錯誤;狀態讀取失敗另存 `stateError`,不蓋掉已完成的結果
- 驗證:`vue-tsc`、`npm test`(124 通過);`MOCK=admin` 瀏覽器:即時監控頁送出 Session 查詢,約 3 秒後顯示 6 筆

## 2026-11-12 V-b2 審查修正(Claude)
- 工作項目:V-b2(審查 Gemini 41f7b53;`code-reviewer`)
- 內容:① `GHeatmap`:滑鼠單擊延遲 250ms 才 `select`,雙擊只 `drill`(原本第一下就打開抽屜,遮罩吃掉第二下,雙擊下鑽做不到);年視圖欄位從 `from` 所在週的週起點起算(原本同一欄會跨兩週、最後一欄可能兩格疊在一起);資料換了(刷新、同長度的上一期 / 下一期)就清 tooltip;每格的 label 與 style 在 `placed` 一次算好(hover 不再讓 371 格重算 label);加 Home / End。② `GDrawer`:Esc 也掛在 document(焦點掉回 body 時仍可關)、開著時鎖背景捲動、可聚焦判斷改用 `getClientRects`、點 SVG / 表格列開啟時不把 body 當成觸發元素。③ `useInsight` 加 `canSlice`(和 `useHeatmap` 同一個判斷),`Insight.vue` 改讀它,沒有 Log 明細權限時提示而不是不動;合併重複的 import;Top 10 威脅名稱在 ≤ 640px 縮小左側標籤區。④ `Heatmap.vue`:換粒度 / 期間時清掉選取格。⑤ `components.d.ts` 補 9 個圖表元件(報告 §5 第 2 點)。⑥ 測試:雙擊 / 單擊延遲、年視圖欄位、Home / End、tooltip 清除、抽屜捲動鎖與 document Esc;頁面級測試逾時 15 秒(全套件冷啟動時偶發超過 5 秒)。
- 未改(列為後續):每個圖表元件各自的 `MutationObserver` 與 `esc()` 抽成共用(主題切換時每張圖重畫 2 次);熱力圖格子小於 24px 觸控目標;無權限時熱力圖格子仍可選取但沒有提示;多個無限循環的呼吸光暈沒有暫停機制。
- 檔案:`frontend/src/ui/charts/GHeatmap.vue`、`frontend/src/ui/components/GDrawer.vue`、`frontend/src/composables/useInsight.ts`、`frontend/src/pages/firewall/{Heatmap,Insight}.vue`、`frontend/src/components.d.ts`、`frontend/test/viz.mount.test.ts`
- 驗證:`npm run typecheck`、`npm test`(146 通過)、`npm run build`;`MOCK=admin` 瀏覽器:雙擊下鑽到日視圖、單擊開抽屜、Esc 關閉後焦點回到格子、背景捲動鎖;年視圖 368 格沒有重疊;分析儀表板 375px `scrollWidth` = 375

## 2026-11-12 V-b2 熱力圖、時段明細抽屜、分析儀表板與 9 個圖表元件(Gemini)
- 工作項目:V-b2(`docs/HANDOFF-GEMINI-VIZ.md` §1–§8;VIZ-RULES-DESIGN §3–§6)
- 內容:① `ui/styles/tokens.css`:補齊並調校明亮 / 黑暗 × 玻璃 / 扁平 4 組主題的 `--heat-empty`、`--heat-traffic-1..4`、`--heat-deny-1..4`、`--heat-threat-1..4`、`--heat-ad-1..4`、`--glow-critical`、`--glow-high`、`--badge-hot`、`--badge-cold`,色塊與相鄰背景對比 ≥ 3.4:1、徽章文字對比 ≥ 6.3:1。② `ui/components/GSourceBadge.vue`(⚡ 即時熱資料 / 🧊 歷史冷歸檔 / mixed)、`ui/components/GDrawer.vue`(右側 200ms 滑出、Esc 關閉、Tab 焦點鎖定、關閉後焦點回到觸發鈕)。③ `ui/charts/GHeatmap.vue`:GitHub 風格 CSS Grid 熱力圖(年 53×7 / 月 31×24 / 日 12×24)、`v === null` 斜線底紋區分 `0`、`partial` 缺口標記、鍵盤方向鍵移動焦點與 Enter 選取 / Shift+Enter 下鑽、毛玻璃 tooltip(Top 1 IP 標「約」)、觸控裝置兩段點擊、初次載入與換粒度 stagger ≤ 600ms(`prefers-reduced-motion` 自動停用)。④ `components/SliceDrawer.vue`:熱力圖與儀表板共用的時段明細抽屜,支援冷資料掃描線過場、202 背景工作輪詢與取消、429 忙碌倒數重試、409/404 冷歸檔未提供中性提示並保留熱力圖格彙總、503 danger 錯誤、Top 10 排行與 200 列明細表(C5 前隱藏即時連線查詢鈕)。⑤ 9 個圖表元件(`ui/charts/{GTrendDualAxis,GSankey,GTopBars,GAppShare,GAllowDeny,GSeverityCards,GThreatTimeline,GWorldMap,GTopCompare}.vue`):內部皆透過 `GEChart` 渲染(不頂層 import ECharts),自訂 tooltip HTML 一律跳脫,支援流光 / count-up / 嚴重度呼吸光暈動效與 `prefers-reduced-motion`。⑥ `pages/firewall/{Heatmap,Insight}.vue`:完整熱力圖與分析儀表板頁面(含 AD 指標與 AD Tab 停用標示「AD 階段開放」、日視圖 422 保留期限提示、每個圖表的「看表格」無障礙切換、429 忙碌倒數自動重試、點擊聯動開啟 `SliceDrawer`)。⑦ 元件掛載測試 `test/viz.mount.test.ts` 與測試報告 `docs/test-reports/2026-11-12-viz-b2.md`。
- 檔案:`frontend/src/ui/styles/tokens.css`、`frontend/src/ui/components/{GDrawer,GSourceBadge}.vue`、`frontend/src/ui/charts/{GHeatmap,GTrendDualAxis,GSankey,GTopBars,GAppShare,GAllowDeny,GSeverityCards,GThreatTimeline,GWorldMap,GTopCompare}.vue`、`frontend/src/components/SliceDrawer.vue`、`frontend/src/pages/firewall/{Heatmap,Insight}.vue`、`frontend/test/viz.mount.test.ts`、`docs/PROJECT-MAP.md`、`docs/test-reports/2026-11-12-viz-b2.md`
- 驗證:`npm run typecheck`、`npm test`(21 檔 144 項通過,新增 `viz.mount.test.ts` 9 項)、`npm run build` 通過(ECharts 維持獨立 lazy chunk `echarts-*.js`,未進入首頁 `index-*.js`)

## 2026-11-12 V-b1 熱力圖 / 儀表板前端邏輯層與元件介面
- 工作項目:V-b1(VIZ-RULES-DESIGN §6;決策 D40、D41、V9、V10)
- 內容:① `api/heatmap.ts`、`slice.ts`(200 結果 / 202 工作)、`insight.ts`。② composables:`useHeatmap`(粒度 / 指標 / 日期、下鑽、前後期、AD 停用)、`useSlice`(202 自動輪詢、429 倒數重試、409 學熱 / 冷分界、Log 明細查詢連結、離開時取消)、`useInsight`(今天 / 7 / 30 / 90 天 / 自訂 ≤ 90 天,含今天每 60 秒刷新)、`useChartPick`(圖表點擊 → 時段明細條件,最多 1 天)、`useReducedMotion`、`useLivePaQuery`(C5 前停用)、`vizTime`(台灣時間)。③ 新增相依 `echarts@6.1.0`(鎖版本):`ui/charts/echarts.ts` 按需引入(Line、Bar、Pie、Sankey、Treemap、Map + SVGRenderer)、CSS token 主題、世界地圖;`GEChart.vue` 動態載入(`ui/index.ts` 全域註冊 `charts/G*.vue`,所以不能在頂層 import ECharts),reduced-motion 關動畫、明暗切換重建、點擊正規化 `ChartPick`。④ `ui/charts/viz-types.ts`(全部圖表元件的 props / emits)、樸素版 `GHeatmap`、`GDrawer`、`GSourceBadge`、`tokens.css` 新 token 名稱。⑤ 路由 `firewall/heatmap`、`firewall/insight` 與樸素示範頁、`perms.ts`。⑥ 假資料 `test/fixtures/viz/generate.ts` 與假 Gateway `mock/viz.ts`(各種狀態)。⑦ 世界地圖 `ui/charts/world/`(Natural Earth 1:110m,`scripts/build-world-geo.mjs` 產生,不連 CDN)
- 檔案:`frontend/{package.json,package-lock.json}`、`frontend/src/{api,composables,ui/charts,ui/components,pages/firewall}/`、`frontend/src/{router.ts,components.d.ts,ui/styles/tokens.css}`、`frontend/mock/{viz,gateway}.ts`、`frontend/scripts/build-world-geo.mjs`、`frontend/test/{viz.test.ts,gechart.mount.test.ts,fixtures/viz/generate.ts}`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-12):`useInsight` 換期間 / 手動 / 自動刷新共用一條請求路徑(舊期間的回應丟棄、換期間先清資料、計時器在 dispose 後不再排程);`GEChart` 動態載入完成前卸載時不建立圖表與觀察器、桑基節點用 id;`useChartPick`:Allow / Deny 用自己的格寬、Top IP 只比對來源、桑基連線用結構化的 source / target、「其他」「未知」不帶條件;`useSlice.isCold` 預設分界改台灣今天 00:00 − 29 天、學到的分界只用當天;`GHeatmap` 格數變少時校正可聚焦格、改用 `data-i` 找按鈕、移除不完整的 grid ARIA;`echarts.ts` 提供 `escapeHtml`(formatter 回傳 HTML 時用)
- 驗證:`vue-tsc`、`npm test`(135 通過)、`vite build`:ECharts 獨立 chunk `echarts-*.js` 905 KB(gzip 303 KB,含世界地圖約 52 KB),只在儀表板頁載入,首頁 `index-*.js` 77 KB(gzip 27 KB);`MOCK=admin` 瀏覽器確認熱力圖、抽屜(409 冷資料提示)、儀表板趨勢圖(暗色主題)

## 2026-11-11 C3:日期區間欄位、顯示 ClickHouse 可查範圍
- 工作項目:C3(ARCHITECTURE D43;需求方 2026-11-11 要求日期改單一區間欄位)
- 內容:新增 `components/DateRangeField.vue`(點欄位開面板:快捷選項今天 / 昨天 / 最近 7、30 天,明細為最近 1 / 24 小時、今天、昨天;手動輸入按「套用」才更新;整個在資料範圍之前的快捷選項停用;面板 Teleport 到 body,避免被卡片的 backdrop-filter 堆疊蓋住;窄螢幕固定在底部;動畫依全域 prefers-reduced-motion 關閉)與 `composables/dateRange.ts`。流量總覽、安全事件、Log 明細改用區間欄位;「已分析 … 天」改成 ClickHouse 可查範圍;期間有一部分超過保留期限、排行還在建立時提示;移除 FTP 文案(FTP 類型的安全事件與 FTP Log 檔案頁照舊)。`api/pa.ts`、`api/paEvents.ts` 型別對齊後端(coverage、partial、topsState;明細上限 30 天)。本機假 Gateway(`mock/`)對齊新回應。
- 審查修正(`code-reviewer` 2026-11-12):面板打開後焦點移到面板內、Tab 在面板內循環、Esc / 套用 / 取消後焦點回到欄位(`aria-haspopup`、只在打開時綁 `aria-controls`);明細頁網址帶條件進來時也載入可查範圍;時間模式的天數上限改用實際經過時間(和明細頁、後端一致);快捷選項的「現在」在打開時更新;只設最早可選日期;面板加最大高度可捲動;面板內捲動不重新定位;明細「已達上限」與「部分超過保留期限」同時顯示。
- 檔案:`frontend/src/{components/DateRangeField.vue,composables/dateRange.ts,api/pa.ts,api/paEvents.ts,pages/firewall/{Dashboard,Events,Search}.vue,router.ts}`、`frontend/mock/{pa,paEvents,paLog}.ts`、`frontend/test/{dateRange,dateRange.mount}.test.ts`
- 驗證:`npm run typecheck`、`npm test`(125 通過);`MOCK=admin npm run dev` 以瀏覽器確認:桌面深色、375px 淺色(面板固定在底部、沒有橫向捲動)、快捷選項套用後重新查詢

## 2026-11-10 R1:即時 log 串流上限提高,前端不修改
- 工作項目:R1(對應 BackendCorrection 同日紀錄)
- 內容:評估 `composables/paLive.ts` 的 `mergeLogs`(最多 500 筆、依 `type:id` 去重)與 `Live.vue`:每個 `logs` 事件(最多 200 筆)只更新一次 `shallowRef`,每秒 100+ 筆不需改動;未修改任何前端檔案。
- 檔案:無
- 驗證:合併部署後在測試區頁面實測是否卡頓(見 MR 重驗步驟)

## 2026-11-10 R1:威脅類即時 log 新增「來源 Port」欄
- 工作項目:R1(驗收報告 `docs/test-reports/2026-11-10-pa-live-uat.md` §3.6、§7-3)
- 內容:`Live.vue` 威脅、URL 過濾、資料過濾、WildFire 的即時 log 表格在「目的」後新增「來源 Port」欄(手機寬度隱藏,同「規則」欄做法);缺值或 0 顯示「—」(PA 的 HTTP Payload 還沒加 `sport` 變數時)。TRAFFIC 欄位不變。
- 檔案:`frontend/src/pages/firewall/Live.vue`、`frontend/test/live.mount.test.ts`
- 驗證:`npm run typecheck`、`npm test`(116 通過,新增來源 Port 欄測試)、`npm run build`

## 2026-11-10 R1:即時監控驗收修正(排行切換、log 暫停、介面流量、URL 類別、串流 401)
- 工作項目:R1(驗收報告 `docs/test-reports/2026-11-10-pa-live-uat.md` §4.1、§4.4-1、§4.4-3、§4.4-4、§7-5)
- 內容:① `Live.vue` 兩處 `<template #extra>` 改 `#actions`(`GCard` 沒有 `extra` 插槽),即時排行的「類型」下拉、「5 / 15 / 60 分鐘」切換與即時 log 的「暫停 / 繼續」才會顯示。② 介面流量:新增 `interfaceView()`,輪詢暫停時顯示「停止更新(輪詢暫停,介面計數已清除)」,快照過期時顯示「停止更新(沒有 60 秒內的資料)」,不再顯示最後一輪的值、也不會整張卡片消失;輪詢沒開又沒資料才不顯示。③ URL 過濾的即時 log 不顯示「名稱」欄(URL Filtering 的 threatid 固定 9999,只會顯示 `9999(9999)`),改顯示「URL 類別」(`category`,收集器已寫入;只改前端欄位,API 不變)。④ 串流重連 401:`EventSource` 不經 web-kit,登入逾時不會自己換發;探測到 401 時先呼叫 web-kit `refreshSession()`(`api/gateway.ts` 轉出,web-kit 不用改),成功立即重連,失敗 `redirectToLogin()`;連線成功前只換發一次,之後仍 401 照一般錯誤 10 秒起退避;非 401 才呼叫 `snapshot` 更新設備狀態(原本與探測同時送)。⑤ 測試:新增 devDependencies `@vue/test-utils` 2.5.1、`happy-dom` 21.0.4(掛載元件需要 DOM;只用在測試,不進建置);`test/live.mount.test.ts` 掛載即時監控頁(API、EventSource 用假資料)檢查排行切換與暫停鈕真的有渲染、接收未啟用時排行與 log 的說明文字、輪詢暫停的介面流量、URL 類別欄;`test/slots.test.ts` 解析全部 `.vue`,檢查對共用元件用的 `<template #名稱>` 都是該元件宣告的插槽;`test/paLiveStream.test.ts` 測 401 換發、換發失敗導向登入、換發後仍 401 不無限重連、換發等待中換類型不殘留重連、429 不換發,與 `interfaceView`;使用者換類型或篩選時也重設換發旗標。
- 檔案:`frontend/src/{pages/firewall/Live.vue,composables/paLive.ts,api/gateway.ts}`、`frontend/test/{live.mount,slots,paLiveStream}.test.ts`、`frontend/package.json`、`frontend/package-lock.json`
- 驗證:`npm run typecheck`、`npm test`(18 檔 115 個通過,原 98)、`npm run build` 通過;把 `#actions` 暫時改回 `#extra` 時掛載測試 2 個、插槽檢查 1 個失敗(列出 `Live.vue:381`、`:414`)

## 2026-11-09 R1:即時監控驗收修正與測試區收集器開關
- 工作項目:R1(驗收報告 `docs/test-reports/2026-11-09-a1-r1-uat.md` §4.4、§6-5、§7.4;需求方 2026-11-09 決定)
- 內容:① 頁首「收集器」區分開顯示輪詢(輪詢中 / 輪詢失敗 / 輪詢暫停 / 輪詢未啟用 / 停止更新)與接收(接收中 / 接收暫停 / 接收未啟用 / 停止更新),並說明設備狀態來自輪詢、排行與即時 log 來自接收端點。② 接收未啟用或暫停時,排行與即時 log 寫「接收端點未啟用,沒有 log 來源」/「接收已暫停…」,不再寫「收集器有在運作,這段期間沒有收到這種 log」。③ 設備狀態上方顯示「設備狀態最後更新」(快照 `time` 最新者)。④ 串流非 200 時用 `fetch` 查狀態碼(立即中斷):429 顯示「串流連線數已達上限,請關閉其他即時監控分頁」並以 30 秒起倍增到 5 分鐘重試,404 `ROUTE_NOT_FOUND` 顯示「功能尚未啟用(路由未發佈)」,其他 10 秒起倍增到 2 分鐘;收到 `open` 歸零。⑤ `describeError` 遇 `ROUTE_NOT_FOUND` 一律顯示「功能尚未啟用(路由未發佈)」(AI、知識庫等全站)。⑥ 測試區開關:有 `UI.paLiveManage` 且 `control.available` 時顯示「輪詢:開啟 / 停用」「接收:開啟 / 停用」;總開關關閉的那一個停用並說明原因;顯示最後操作人與時間。⑦ 假 Gateway:`MOCK_PA_LIVE=poll-only`(測試區現況)、開關 API、`MOCK_PA_LIVE_STREAM=busy|no-route`。
- 檔案:`frontend/src/{api/{paLive,gateway,perms}.ts,composables/paLive.ts,pages/firewall/Live.vue}`、`frontend/mock/{paLive,gateway}.ts`、`frontend/test/{paLive,gateway}.test.ts`
- 驗證:見 MR 描述;`MOCK=admin MOCK_PA_LIVE=poll-only` 瀏覽器確認頁首狀態、暫停輪詢後 KPI 停止更新與文案;`MOCK=viewer MOCK_PA_LIVE_STREAM=busy` 確認 429 訊息、沒有按鈕、14 秒內只有 1 次串流 + 1 次探測

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
