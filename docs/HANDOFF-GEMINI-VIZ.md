# 交接給 Gemini:熱力圖、儀表板、告警畫面與動畫(V-b2、V-c 畫面)

> **給 Gemini 的工作規格**。Gemini 開工前先讀 `AGENT.md`「AI 分工」與本文件;不確定是畫面還是邏輯時**一律視為邏輯**,寫進 MR 說明交給 Claude。
> 背景與設計見 [VIZ-RULES-DESIGN.md](VIZ-RULES-DESIGN.md)(§6 是元件介面),決策 ARCHITECTURE D34–D41,工作項目 IMPL-PLAN V-b2、V-c 第 4 步。**狀態:V-b1 交付完成(2026-11-12,`feature/viz-b1-insight-frontend`,MR 合併後)→ 熱力圖、儀表板、時段明細抽屜可以開工(§2.1);告警與偵測設定(V-c 畫面)要等 V-c 第 4 步。**

---

## 1. 範圍與禁止事項

**你負責**(AGENT「AI 分工」Gemini 欄 ✅):

- 元件畫面:`ui/charts/GHeatmap.vue`、圖表元件(§4.2)、`ui/components/GDrawer.vue`、`GSourceBadge.vue`。
- 頁面:`pages/firewall/Heatmap.vue`、`pages/firewall/Insight.vue`、`components/SliceDrawer.vue`、`pages/detect/Alerts.vue`、`pages/detect/Settings.vue`。
- 側欄徽章的樣式(`layouts/AppLayout.vue` 顯示 `menu` 的 `badge`;資料由 Claude 提供)。
- 動畫(§5)、`ui/styles/tokens.css` 的新 token 色值(名稱由 Claude 定,§6)、文案、自己負責的元件測試、測試報告。
- 可在 `docs/PROJECT-MAP.md` 補上新頁面 / 元件那一行。

**禁止**(即使只改一行):

- `api/`、`composables/`、`router.ts`、`api/perms.ts`、`composables/menu.ts`、`ui/charts/echarts.ts`、`ui/charts/GEChart.vue`、`ui/charts/viz-types.ts`、`ui/charts/world/`(Claude 負責的邏輯層與框架)。
- `package.json`、lock 檔、`tsconfig*.json`、`vite.config.*`;`deploy/`、`Dockerfile*`、`docker-compose*`、`.gitlab-ci.yml`、`.env*`;後端;ClickHouse schema / migration。
- 頁面裡直接 `fetch`、自己判斷權限、自己寫格式化(用 `formatBytes` 等)、自己指定圖表顏色(用 token / `echarts.ts` 主題)、自創權限代碼 / 路由 / 錯誤代碼。
- 連外部 CDN(字型、地圖、圖示都不行;世界地圖已打包,V9)。
- 測試失敗時改測試或程式、跳過測試、調門檻:寫進報告交給 Claude。

需要新的 API 欄位、狀態、權限或路由時:寫在 MR 說明「交給 Claude」段落,不自己加。

## 2. 開工前 Claude 會交付的東西(V-b1、V-c 第 4 步)

| 交付 | 位置 | 用途 |
| --- | --- | --- |
| API 函式 | `api/heatmap.ts`、`slice.ts`、`insight.ts`、`alerts.ts`、`detect.ts` | 你不直接呼叫,透過 composables |
| Composables | `useHeatmap`、`useSlice`、`useInsight`、`useChartPick`、`useLivePaQuery`、`useReducedMotion`、`useAlerts`、`useAlertBadge`、`useDetectConfig` | 頁面只用這些(VIZ-RULES-DESIGN §6.3) |
| 元件介面 | `ui/charts/viz-types.ts` | 每個元件的 props / emits / 資料型別;**照型別實作,不改型別** |
| ECharts 基底 | `ui/charts/GEChart.vue`、`echarts.ts` | 圖表元件內部都用 `GEChart`,傳 `option`、收 `pick` |
| 路由與空頁 | `firewall/heatmap`、`firewall/insight`、`detect/alerts`、`detect/settings` | 你填頁面內容 |
| 假資料 | `frontend/mock/fixtures/viz.ts`(5 年每天、31 天每小時、1 天每 5 分鐘;儀表板兩個視角;告警與設定) | 本機開發與元件測試 |

### 2.1 V-b1 已交付(2026-11-12):開工方式

**可以開始做**:活動熱力圖頁、分析儀表板頁(流量、威脅兩個 Tab)、時段明細抽屜 `SliceDrawer`、§4.2 的 9 個圖表元件、`GHeatmap` / `GDrawer` / `GSourceBadge` 的畫面與動畫、§6 token 色值。**還不能做**:告警頁、偵測設定頁、側欄徽章(V-c 第 4 步才有 `useAlerts`、`useAlertBadge`、`useDetectConfig` 與路由)。

| 交付 | 檔案 | 你怎麼用 |
| --- | --- | --- |
| Composables | `composables/useHeatmap.ts`、`useSlice.ts`、`useInsight.ts`、`useChartPick.ts`、`useReducedMotion.ts`、`useLivePaQuery.ts`;時間工具 `vizTime.ts`(`formatRange` 等,台灣時間) | 頁面只用這些;各檔開頭註解寫了回傳值與用法 |
| 元件介面 | `ui/charts/viz-types.ts` | 每個元件的 props / emits;**照型別實作,不改型別**。圖表點擊一律 `emit('pick', ChartPick)`,`chart` 用 `ChartId` 的值 |
| ECharts 基底 | `ui/charts/GEChart.vue`(動態載入 `echarts.ts`)、主題 `echarts.ts` 的 `severityColors()`、`pairColors()` | 圖表元件內部用 `<GEChart :option="…" ariaLabel="…" chart="sankey" @pick="…">`(**`ariaLabel` 用駝峰寫法**);不要在元件頂層 `import 'echarts'` 或 `./echarts`(會把 ECharts 拉進首頁 bundle);世界地圖名稱 `'world'`,資料 `name` 用 ISO2 |
| 樸素版元件 | `ui/charts/GHeatmap.vue`、`ui/components/GDrawer.vue`、`GSourceBadge.vue` | 功能完整、樣式樸素;**畫面、tooltip、動畫由你改寫**,props / emits 不變(排版與鍵盤邏輯可保留) |
| 路由與頁面 | `/firewall/heatmap`(`pages/firewall/Heatmap.vue`)、`/firewall/insight`(`Insight.vue`) | 兩頁目前是樸素示範(證明資料串得通),由你改寫內容;`SliceDrawer` 新增在 `components/SliceDrawer.vue` |
| Token 名稱 | `ui/styles/tokens.css` 最後一段(`--heat-*`、`--glow-*`、`--badge-*`) | 起點值由既有色混出;你調四種組合的色值與對比 |
| 假資料 | `frontend/mock/fixtures/viz.ts`(`heatmapResponse`、`sliceResult`、`trafficInsight`、`threatInsight`) | 元件測試直接用;本機假 Gateway 也用這份 |

**本機跑假資料**(不連測試區):

```sh
cd frontend
MOCK=admin npm run dev      # PowerShell:$env:MOCK='admin'; npm run dev
# 開 http://localhost:5181/netops/firewall/heatmap、/netops/firewall/insight
# MOCK=viewer 看唯讀角色
```

用假 Gateway 造出各種狀態(`mock/viz.ts`):

| 想看的狀態 | 怎麼造 |
| --- | --- |
| `v === null`(沒有資料) | 熱力圖日期選 2026-01-01 以前(資料起點設在 2026-01-01) |
| 日視圖超過 1 年(422) | 日視圖選 1 年前的日期 |
| 冷歸檔尚未提供(409) | 點 29 天以前的格子 |
| 冷查詢忙碌(429 倒數) | `useSlice.open({ …, ip: '10.0.0.98' })` |
| 背景查詢(202 → 約 4 秒後完成) | `ip: '10.0.0.99'` |
| 冷 / 混合資料徽章 | `ip: '10.0.0.97'`(cold)、`'10.0.0.96'`(mixed) |
| ClickHouse 無法使用(503) | `ip: '10.0.0.95'` |
| `partial` 格子 | 每 17 格一個 |
| 伺服器網段未設定 | 威脅 Tab 的 `topServerDst` 一律 `null`,`notes` 有說明 |

**`useSlice` 的狀態**:`idle` → `loading` → `done`;`waiting-job`(202,自動輪詢,可 `cancel()`);`busy`(429,`retryAfter` 每秒倒數,到 0 才能 `retry()`);`error`(`error.code` 判斷:`NETOPS_COLD_ARCHIVE_DISABLED` / `NETOPS_ARCHIVE_NOT_FOUND` 用中性提示,其他用 danger)。`isCold` 在開查前就有值,用來決定要不要放冷資料過場。

**tooltip / label 的 formatter**(資安):formatter **回傳字串**時 ECharts 以 HTML 插入、不跳脫;App、威脅名稱、國家、IP 都來自 PA log,字串一律先經 `escapeHtml`(`ui/charts/echarts.ts`,由 GEChart 載入的模組;你的元件在 option 裡用字串模板 `'{b}: {c}'` 就不需要)。不要用 `v-html`。

**useInsight 的 429**:儀表板同時計算全系統 2 個,滿了回 `NETOPS_INSIGHT_BUSY`(`error.details.retryAfter` 秒),畫面顯示「稍後自動重試」類的中性提示並 `refresh()`。

**AD 指標**:`useHeatmap().metricOptions` 的 `ad` 是 `disabled: true, hint: 'AD 階段開放'`,畫面要顯示但不能選;儀表板 AD Tab 停用。

**目前資料的限制**(畫面要照實呈現,不要當成 bug):
- 測試區彙總表只保留 3 天;月 / 年視圖在測試區大多是 `null`,版面用假資料驗。
- 時段明細只查得到原始表保留期間(測試區 2 天、正式區 29 天);更早的回 409(冷歸檔要等 C4)。
- 儀表板「被攻擊最多的伺服器」在偵測設定(V-c)前是 `null`。
- 「查詢即時連線」按鈕在 C5 前不會出現(`useLivePaQuery().canQuery` 一律 false)。

## 3. 頁面清單

| 頁面 | 路由 | 選單節點(權限) | 用到的 composable | 用到的元件 |
| --- | --- | --- | --- | --- |
| 活動熱力圖 | `/firewall/heatmap` | `netops.pa-heatmap.read` | `useHeatmap`、`useSlice`、`useLivePaQuery`、`useReducedMotion` | `GHeatmap`、`GSegmented`(粒度、指標)、`GInput type=date`、`GDrawer` + `SliceDrawer` |
| 分析儀表板 | `/firewall/insight` | `netops.pa-insight.read` | `useInsight`、`useChartPick`、`useSlice`、`useReducedMotion` | `GTabs`(流量 / 威脅 / AD 預留停用)、§4.2 圖表元件、`GStatCard`、`SliceDrawer` |
| 時段明細抽屜 | 熱力圖與儀表板共用 | (隨頁面) | `useSlice`、`useLivePaQuery` | `GDrawer`、`GSourceBadge`、`GSkeleton`、`GTable`、`GBarList`、`GButton` |
| 告警 | `/detect/alerts` | `netops.alerts.read`;按鈕 `netops.alerts.manage` | `useAlerts`、`useSlice` | `GTable`、`GBadge`、`GSelect`、`GModal`(處理 / 備註)、`SliceDrawer`(證據) |
| 偵測設定 | `/detect/settings` | `netops.detect-settings.read`;按鈕 `netops.detect-settings.manage` | `useDetectConfig` | `GTabs`(規則 / 網段 / 白名單)、`GTable`、`GInput`、`GSwitch`、`GTextarea`、`GAlert`(版本衝突、尚未設定網段) |
| 側欄徽章 | 「告警」選單 | — | `useAlertBadge`(經 `menu.ts` 的 `badge`) | `GBadge`;有 critical 時用 danger 色 |

### 3.1 活動熱力圖

- 上方工具列:粒度(年 / 月 / 日)、指標(威脅等級 / 總流量 / 阻擋數 / AD 異常 — **AD 停用**並顯示提示「AD 階段開放」,資料來自 `metricOptions`)、前後期間按鈕、日期選擇、圖例(4 階 + 「沒有資料」)。
- 版面:年 = 53 欄 × 7 列(週一在第一列,欄上方標月份);月 = 31 欄(日)× 24 列(小時);日 = 12 欄(5 分鐘)× 24 列(小時)。375 px 時橫向捲動熱力圖區塊本身(不是整頁)。
- 日視圖超過 1 年:`useHeatmap.error` 是 `NETOPS_HEATMAP_OUT_OF_RETENTION`,顯示「每 5 分鐘資料只保留 1 年,最早可查 {earliest}」。
- `v === null`(沒有資料)用斜線底紋,和 0(淺色空格)分開;`partial` 格子加小標記並在 tooltip 說「此時段資料不完整」;`coverage.since` 之前顯示「此日期前沒有資料」。
- 點格子 → 開抽屜(`useSlice.open`);雙擊或抽屜「下鑽」→ `useHeatmap.drill`。

### 3.2 時段明細抽屜(`SliceDrawer`)

- 標題:時段(例「2026-11-11 08:00–09:00」)+ `GSourceBadge`:`hot` 顯示「⚡ 即時熱資料」、`cold` 顯示「🧊 歷史冷歸檔」、`mixed` 兩個都顯示。
- 冷資料:`useSlice.isCold` 為真時,一打開就放冷資料過場(§5);`state === 'waiting-job'` 顯示「查詢較久,已轉為背景查詢」與取消按鈕。
- `state === 'busy'`(429):顯示「目前有其他歷史查詢進行中,{retryAfter} 秒後可重試」與倒數按鈕;不是錯誤樣式。
- 409 `NETOPS_COLD_DETAIL_UNAVAILABLE` / `NETOPS_COLD_ARCHIVE_DISABLED`、404 `NETOPS_ARCHIVE_NOT_FOUND`:顯示 `error.message`,並保留熱力圖格子的彙總數字(從 cell 帶入)。
- 內容:摘要卡(流量、上傳 / 下載、Session、阻擋、各嚴重度威脅)、Top 10(來源、目的、App、Port、國家)、明細表(最多 200 列;`rowsTruncated` 時提示)。
- 按鈕:「在 Log 明細查詢開啟」(`openInSearch`)、「下鑽」(熱力圖時)、「查詢該 IP 當下 PA 即時連線」(只在 `useLivePaQuery.canQuery` 時顯示,C5 之前不會出現)。

### 3.3 分析儀表板

- 期間選擇:今天 / 7 天 / 30 天 / 90 天 / 自訂(≤ 90 天),用 `useInsight.range`。
- 流量 Tab:雙軸趨勢(上傳 / 下載面積 + Session 線)、桑基圖(來源區域 → App → 目的區域)、Top 10 頻寬 IP 堆疊長條(上傳 / 下載)、Top 10 App(甜甜圈 / Treemap 切換)、每小時 Allow vs Deny 堆疊柱。
- 威脅 Tab:嚴重度計分卡(含和前一期比較)、威脅堆疊時序、國家 Top 10 + 世界地圖、發起威脅最多內網 IP vs 被攻擊最多伺服器、Top 10 威脅名稱。`notes`(例「尚未設定伺服器網段」)要顯示在對應圖表。
- 任何圖表元素點擊 → `useChartPick.toSliceQuery(pick, range)` → `useSlice.open`(點擊聯動明細)。
- AD Tab:停用並顯示「AD 階段開放」(V4)。
- 每個圖表要有「看表格」切換(無障礙,資料同一份)。

### 3.4 告警與偵測設定

- 告警清單:時間、嚴重度(徽章;critical / high 用呼吸光暈,§5)、規則名稱、IP、摘要(`title`)、標記(`c2-suspect` 顯示「疑似 C2(內→外)」、`partial-data` 顯示「資料不完整」)、冷卻略過次數、狀態。篩選:期間、規則、嚴重度、狀態、IP。
- 點一列 → 詳細(`GModal`):`metrics` 表格化、處理紀錄;「查看證據」→ `SliceDrawer`(`evidence`);有 `canManage` 才顯示「確認 / 結案 / 重新開啟」與備註。
- 偵測設定:規則 Tab(啟用、嚴重度、門檻、間隔 / 窗、最後執行狀態 `ok / deferred / error / disabled` 與原因);網段 Tab(四種網段,CIDR 清單);白名單 Tab(IP、App,各附適用規則與備註)。沒有 `canEdit` 時全部唯讀。儲存衝突(`conflict`)顯示「設定已被其他人修改,請重新載入」。規則說明區要寫出 VIZ-RULES-DESIGN §5.3 的「已知限制」。

## 4. 元件

### 4.1 `GHeatmap`(介面見 `viz-types.ts`,摘要在 VIZ-RULES-DESIGN §6.4)

- 用 CSS Grid + 每格一個 `<button>`(或 `role="gridcell"` + roving tabindex);不用 ECharts。
- 色階:`--heat-<metric>-1..4`、`--heat-empty`;`level` 決定顏色,不自己算門檻。
- 鍵盤:方向鍵移動、Enter = `select`、Shift+Enter = `drill`;`aria-label` 例「2026-11-11 08:00–09:00,流量 1.2 GB,威脅 3」。
- Tooltip:流量、威脅數(依嚴重度)、Top 1 IP(**一律標「約」**,依目前指標顯示流量 / 阻擋 / 威脅的 Top 1)。觸控裝置改為點一下顯示 tooltip、再點一下開抽屜。

### 4.2 圖表元件(內部都用 `GEChart`)

`GTrendDualAxis`、`GSankey`、`GTopBars`、`GAppShare`、`GAllowDeny`、`GSeverityCards`、`GThreatTimeline`、`GWorldMap`、`GTopCompare`:props / emits 照 `viz-types.ts`;點擊一律 emit `pick`,不在元件內呼叫 API。顏色只用 `echarts.ts` 主題提供的色盤;嚴重度固定對應 token(critical = danger、high = warning…)。

### 4.3 `GDrawer`、`GSourceBadge`

- `GDrawer`:右側滑入,寬度預設 560 px,≤ 960 px 時全寬;Esc 關閉、焦點鎖在抽屜內、關閉後焦點回到觸發的格子。
- `GSourceBadge`:`hot` / `cold` / `mixed`,色用 `--badge-hot`、`--badge-cold`,文字對比 ≥ 4.5:1。

## 5. 動畫規格(全部支援 `prefers-reduced-motion`)

| 效果 | 規格 | reduced-motion 時 |
| --- | --- | --- |
| 熱力圖 stagger 進場 | 每格 `opacity 0→1` + `scale .6→1`,240 ms ease-out;延遲 = 格子順序 × 4 ms,總長上限 600 ms;只在第一次載入與切換粒度時播放,自動刷新不播 | 直接顯示 |
| hover 放大 | `transform: scale(1.25)` 120 ms,提高 `z-index`、加 1 px 外框;鍵盤焦點同樣效果 | 不放大,只顯示外框 |
| 毛玻璃 tooltip | `backdrop-filter: blur(var(--glass-blur))`、背景 `--glass-strong`、邊框 `--glass-border`;淡入 120 ms;扁平風格時改實色背景(沿用 `GStyleToggle` 的規則) | 不淡入 |
| 桑基 / 趨勢流光 | 載入時一次 1.2 s 的漸層掃過(ECharts `animationDuration` + 漸層 mask);之後每 6 s 一次輕微流光,分頁在背景時暫停 | 關閉(`GEChart` 已自動 `animation: false`) |
| Critical / High 呼吸光暈 | `box-shadow` 以 `--glow-critical` / `--glow-high` 脈動,2.4 s ease-in-out 無限;同一畫面最多 6 個元素同時呼吸(其他用靜態外框) | 靜態外框 |
| KPI count-up | 0 → 值 800 ms easeOutCubic(`requestAnimationFrame`);自動刷新時從舊值到新值 400 ms;看 `useReducedMotion().reduced` | 直接顯示最終值 |
| 冷資料過場 | `GSkeleton` + 掃描線(由上往下的漸層,1.6 s 循環)+ 文字「讀取歷史冷歸檔中…」;結果出現時淡入 200 ms | 只有骨架與文字,沒有掃描線 |
| 抽屜 | 右側滑入 200 ms | 直接出現 |

- 只動 `transform` 與 `opacity`(呼吸光暈例外用 `box-shadow`,數量有上限);不要觸發版面重排。
- CSS 動畫用 `@media (prefers-reduced-motion: reduce)` 關閉(`ui/styles/base.css` 已有同樣做法);JS 動畫一律看 `useReducedMotion()`。
- 不用新的動畫套件(要的話寫在 MR 說明交給 Claude 評估,`package.json` 你不能改)。

## 6. 主題變數

名稱由 Claude 在 `tokens.css` 建好(VIZ-RULES-DESIGN §6.6),你負責四種組合(玻璃 / 扁平 × 明亮 / 黑暗)的色值:

| Token | 用途 |
| --- | --- |
| `--heat-empty` | level 0 與沒有資料(另加斜線底紋) |
| `--heat-traffic-1..4`、`--heat-deny-1..4`、`--heat-threat-1..4` | 三種指標的 4 階色 |
| `--glow-critical`、`--glow-high` | 呼吸光暈 |
| `--badge-hot`、`--badge-cold` | 熱 / 冷徽章 |

對比:色塊對底色 ≥ 3:1;文字 ≥ 4.5:1(UI-GUIDE §2)。用瀏覽器實際檢查,數字寫進測試報告。其他顏色沿用既有 token,不新增。

## 7. 狀態呈現(AGENT §5:沒有資料不等於沒有發生)

| 狀態 | 呈現 |
| --- | --- |
| 載入中 | `GSkeleton`;冷資料用 §5 的冷資料過場 |
| 沒有資料(`null`、`coverage.since` 之前) | 斜線底紋 / 「此日期前沒有資料」,**不要畫成 0** |
| 資料不完整(`partial`、`coverage.gaps`、`partial-data`) | 小標記 + 文字說明 |
| 429 忙碌 | 提示 + 倒數重試,不是紅色錯誤 |
| 409 設定狀態(功能未開放) | 中性提示(`GAlert` info) |
| 錯誤 | `GAlert` danger,顯示 `message` 與 `requestId` |
| 沒有權限的按鈕 | 不顯示(composable 的 `canXxx`) |

## 8. 驗收方式

完成後執行測試並寫報告 `docs/test-reports/YYYY-MM-DD-viz-<主題>.md`(格式照 AGENT「測試報告」)。驗收清單:

1. `npm run typecheck`、`npm test` 通過(失敗寫進報告,不改測試)。
2. 四種風格組合 × 1440 px / 375 px:熱力圖三粒度、儀表板兩個 Tab、抽屜、告警頁、設定頁都看過,截圖附在報告。
3. 作業系統開啟「減少動態效果」後重新整理:§5 每一項都變成右欄的行為。
4. 只用鍵盤:熱力圖移動 / 選取 / 下鑽、抽屜開關與焦點回復、告警處理。
5. 狀態:用假資料造 `null`、`partial`、冷資料、202 背景查詢、429、409、404,畫面照 §7。
6. 權限:viewer 看不到「確認 / 結案」「修改設定」「查詢即時連線」;admin 看得到(C5 前「查詢即時連線」兩者都不會出現)。
7. 年視圖 371 格在 4× CPU 降速下互動不卡(DevTools Performance,寫進報告)。
8. `git diff --stat` 只有 §1「你負責」的檔案。

## 9. 交回 Claude 的事項

MR 說明加「交給 Claude」段落,逐條寫:需要的 API 欄位 / composable 回傳 / 型別調整 / 新權限或路由、發現的邏輯錯誤(附重現步驟與檔案行號)。Claude 改完後你再接著做畫面。

## 10. PA 精準查詢(C5,2026-11-12 交付)

「查詢該 IP 當下 PA 即時連線」按鈕依賴的功能已完成(`feature/c5-pa-precise-query`,API.md §3.3)。

| 交付 | 檔案 | 你怎麼用 |
| --- | --- | --- |
| Composable | `composables/usePaQuery.ts` | `canQuery`(按鈕權限 `netops.pa-live.query`,只給 admin;false 時按鈕不顯示)、`refreshState()` → `ready` / `waitSec` / `server.mgmtCpu`、`session(ip, 'src' \| 'dst')`、`recentLog(ip, 分鐘 ≤ 15, 'traffic' \| 'threat')`、`state`(idle / submitting / waiting / done / failed / rejected / busy / error)、`job.result.rows` |
| 最小介面 | `components/PaQueryPanel.vue`(即時監控頁) | 樸素版;**畫面由你改寫**(輸入 IP、兩個按鈕、等待中、結果表格),composable 不變 |
| 假資料 | `mock/paQuery.ts`(`MOCK=admin npm run dev`) | IP `10.0.0.98` → 429 倒數;`10.0.0.97` → rejected(CPU 過高);`10.0.0.96` → failed(逾時);其他約 3 秒後完成。`MOCK=viewer` 看不到面板 |

畫面要點:
- 等待中寫「查詢 PA-560 中…(最長 60 秒)」;`busy`(429)用中性提示並顯示倒數(`waitSec`),不是錯誤樣式;`rejected` 是「為保護設備沒有送出」(warning),`failed` 才是錯誤。
- 冷卻規則要寫在按鈕旁:全系統一次一個、每人每分鐘一次;`server.mgmtCpu` 可顯示當下管理平面 CPU。
- 熱力圖 / 儀表板抽屜裡的按鈕:V-b1(!78)合併後,Claude 會把 `useLivePaQuery` 改接 `usePaQuery`,你用同一個介面即可(`canQuery` 為 true 才顯示)。

