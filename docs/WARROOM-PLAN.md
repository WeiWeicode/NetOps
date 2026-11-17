# PA 即時監控戰情室(WR)規劃

> 狀態:規劃(需求方 2026-11-17 定稿樣稿 v5)。樣稿:[`docs/mockups/warroom-v5.html`](mockups/warroom-v5.html)(瀏覽器直接開,資料全為假資料)。
> 頁面:`/netops/firewall/live`(正式區 `https://giganexus.gigasolar.com.tw/netops/firewall/live`)。
> 上位文件:`docs/PA-LIVE-PLAN.md`(R1 即時監控)、`docs/PA-LOG-CLICKHOUSE-GUIDE.md`、`docs/ARCHITECTURE.md`。本文件的待決事項定案後,決策併入 ARCHITECTURE。

## 1. 目標

把即時監控做成「戰情室」畫面:參考 Vizceral 的視覺邏輯,防火牆在中央、外部來源在左、內部網段在右,用**粒子密度 + 顏色**表示流量與阻擋,取代折線圖。現有 R1 的收集器、Redis、SSE 串流沿用,不改收集器。

## 2. 畫面區塊與資料來源

| # | 區塊(樣稿位置) | 內容 | 資料來源 | 現況 |
| --- | --- | --- | --- | --- |
| A | 頂部 KPI | 吞吐量、連線數、新連線/秒、阻擋/分、威脅/5 分、DP CPU | `GET /pa-live/snapshot`(既有)+ WR-1 | 阻擋/分、威脅/5 分要新增 |
| B | 左側節點 | 外部來源:依**國家**聚合 + Top 攻擊 IP;大小=5 分鐘連線數,顏色=阻擋比例 | WR-1 | **新增**;國家欄位見 Q2 |
| C | 中央核心 | 六角盾 + DP 負載環、吞吐量弧(滿格 1 Gbps)、連線數弧(滿格 64K)、阻擋/新連線、log 類型衛星、擴散波(頻率=新連線/秒)、阻擋時閃紅 | snapshot + WR-1 | 滿格值改設定(Q5) |
| D | 右側節點 | 內部網段(VLAN / 核心服務);大小=5 分鐘連線數 | WR-1 | **新增**;網段對照見 Q3 |
| E | 連線與粒子 | 每條「來源→防火牆→網段」的每秒連線數、允許/阻擋/威脅比例;前端依比例產生粒子 | WR-1(比例)+ SSE(實際事件抽樣) | **新增** |
| F | 右欄即時事件 | 阻擋 / 允許 / 威脅事件逐筆 | SSE `/pa-live/stream`(既有) | 沿用 |
| G | 上方 AI 分析框 | 每整點自動分析近一小時;可手動「立即分析」;顯示時間、自動/手動、模型 | WR-3 | **新增** |
| H | 下方高風險統計 | 近一小時:威脅數、阻擋數、攻擊來源 IP 數、Critical 數;Top 威脅類型、Top 攻擊來源 | WR-2 | **新增** |
| I | 底部 TRAFFIC LOG | 完整欄位表格(時間、動作、來源、國家、目的、區段、Port、App、規則、Bytes、Session);篩選全部/阻擋/允許/威脅、暫停;點節點同步篩選;最多 200 筆 | SSE(既有)+ WR-1 的區段對照 | 區段、國家欄位要補 |
| J | 左側說明 | 圖例與操作說明,可收摺(記在 localStorage),收摺後中央圖放大 | 前端 | 純畫面 |

互動:滑過節點顯示明細(5 分鐘連線、阻擋比例、Top 目的、Top App);點節點聚焦(其他淡出、Log 同步篩選);點空白取消。

## 3. 後端工作(Claude)

API 都掛在既有模組,權限沿用 `netops.pa-realtime.read`(AI 手動執行見 WR-3)。行為變更依 AGENT §4:`docs/API.md` → OpenAPI `x-gherkin` → 測試。

### WR-1 戰情室聚合 `GET /v1/pa-live/warroom?minutes=5`

- 回應:`{ generatedAt, minutes, partial, sources[], segments[], links[], kpis }`
  - `sources[]`:`{ id, kind: 'country'|'ip'|'other', label, conn, deny, threat, topDst[], topApp[] }`;國家取前 N(預設 8)、Top 攻擊 IP 取前 2–3(阻擋比例 ≥ 門檻),其餘併成「其他」。
  - `segments[]`:`{ id, kind: 'vlan'|'service', label, icon, conn, bytes, threat }`。
  - `links[]`:`{ source, segment, conn, allow, deny, threat }`(每秒速率,前端用來決定粒子密度與顏色)。
  - `kpis`:`{ denyPerMin, threat5m }`(其他 KPI 用 snapshot)。
- 資料:Redis TRAFFIC 統計(1 天)+ threat 統計;國家依 Q2、網段依 Q3。
- 快取 2–5 秒(多人同時開戰情室不重算);Redis 不可用時回 `partial: true`,不回假資料(AGENT §5)。
- SSE 事件補 `segment`、`country` 兩個衍生欄位(後端計算,不改收集器欄位,符合 D28)。

### WR-2 近一小時高風險統計 `GET /v1/pa-live/risk?minutes=60`

- 回應:`{ threats, denies, attackSources, critical, topThreats[{name,severity,count}], topSources[{key,label,count,denyRatio}], partial }`。
- 資料:Redis threat / traffic 統計(threat 保留 2 天,足夠);ClickHouse 不可用時不影響。快取 60 秒(畫面每分鐘更新)。

### WR-3 AI 每小時分析

- 排程:程序內每整點(`HH:00`,台北時間)跑一次,分析「上一個整點到現在」;沿用 `modules/ai` 與 `infra/llm`(AI 主機 `LLM_URL`),只送 WR-1 / WR-2 的**彙整統計**,不送原始 log(AGENT §7.4)。
- 結果經 `infra/store` 存檔(只留最新一筆,Q4),日誌不寫內容(比照 daily-summary)。
- API:
  - `GET /v1/ai/hourly-insight`(只有最新一筆,Q4):`{ hour, text, model, trigger: 'auto'|'manual', partial, status }`。
  - `POST /v1/ai/hourly-insight/run`:手動執行,送出工作 → 查結果 / SSE 逐字回傳(沿用 `ai/sse.ts`);同一時間只跑一個、冷卻 5 分鐘;權限 `netops.ai.use`(畫面按鈕節點見 Q4)。
- AI 主機不可用:存 `failed`,畫面顯示「本小時分析失敗」,不影響其他區塊。

### WR-4 前端邏輯層(Claude)

- `frontend/src/api/warroom.ts`:WR-1、WR-2、WR-3 的呼叫與型別。
- `frontend/src/composables/useWarroom.ts`:輪詢 WR-1(5 秒)/ WR-2(60 秒)、整合 snapshot 與 SSE;輸出畫面要的 `nodes`、`links`、`rates`、`events`、`logs`(含篩選、暫停、聚焦狀態);頁面不直接 fetch。
- `useWarroomAi.ts`:讀最新分析、手動執行、逐字串流狀態;依權限決定按鈕是否可用。
- **mock 模式**:composable 提供假資料來源(對應樣稿的隨機資料),讓 Gemini 在後端完成前就能做畫面。
- 測試:composable 單元測試(篩選、聚焦、速率換算、斷線重連、partial 標示)。

## 4. 前端畫面(Gemini)

依樣稿 v5 實作,只用 WR-4 的 composable,不自行 fetch、不寫權限判斷(AGENT「Gemini 寫前端頁面與元件」)。

| 元件 | 內容 |
| --- | --- |
| `pages/firewall/Live.vue`(或 Q1 決定的新頁) | 版面組合 |
| `components/warroom/WarroomCanvas.vue` | Canvas 繪製:節點(線條圖示、六角/圓、旋轉光弧、危險脈衝)、連線、粒子拖尾、阻擋火花、中央核心全部動畫;只讀 composable 給的資料與速率 |
| `components/warroom/AiPanel.vue` | 上方 AI 分析框(光球、逐字顯示、立即分析按鈕) |
| `components/warroom/RiskPanel.vue` | 下方高風險統計 |
| `components/warroom/EventFeed.vue`、`TrafficLogTable.vue`、`LegendPanel.vue` | 右欄事件、底部 Log 表、左側可收摺說明 |
| 元件測試 | 自己負責的元件 |

注意:Canvas 動畫要在分頁不可見時暫停(`requestAnimationFrame` 本來就會)、粒子數設上限(建議 ≤ 1500),長時間掛在電視牆不可記憶體成長。需要新資料或狀態時寫在 MR 說明交給 Claude。

## 5. 批次與順序

| 批 | 內容 | 負責 | 依賴 |
| --- | --- | --- | --- |
| WR-0 | 本計畫 + 樣稿;待決事項定案 | Claude 主串 / 需求方 | — |
| WR-1 | 聚合 API、網段對照、SSE 衍生欄位 | Claude(Opus 子任務) | Q2、Q3 |
| WR-2 | 高風險統計 API | Claude(與 WR-1 同一子任務、堆疊分支) | WR-1 |
| WR-4 | 前端 api / composable + mock 模式 | Claude | WR-1 介面定稿(可先依本文件) |
| WR-5 | 戰情室畫面與元件 | **Gemini** | WR-4 的 mock 模式 |
| WR-3 | AI 每小時分析(排程、存檔、API) | Claude | Q4 |
| WR-6 | 整合、測試區驗收、測試報告 | Gemini 執行測試寫報告;Claude 修正 | 全部 |
| WR-7 | 文件(API.md、PROJECT-MAP、HANDOFF、ARCHITECTURE 決策) | Claude(Sonnet 子任務) | 全部 |

WR-4 完成後即可交給 Gemini;WR-3 與 WR-5 可並行。

## 6. 決定(需求方 2026-11-17)

| # | 問題 | 決定 |
| --- | --- | --- |
| Q1 | 戰情室取代現有 `/firewall/live` 還是另開頁面? | **取代現頁**;現有的收集器狀態、測試區暫停開關移到收摺的「系統狀態」抽屜,明細查詢改連到既有 Log 頁 |
| Q2 | 國家資料來源(Redis 即時 log 沒有國家欄位) | **離線 GeoIP 資料庫**(GeoLite2 或 DB-IP Lite,放映像內、不連外),後端查詢並快取;不改收集器、無 migration;資料庫定期更新,授權標示依官方規定 |
| Q3 | 內部網段(VLAN / 服務)對照 | **設定檔,網通提供**:CIDR → 名稱、類型、圖示,經 `infra/store` 讀取;畫面維護之後再說 |
| Q4 | AI 每小時分析保留與權限 | **只留最新一筆**(不留歷史,`GET /ai/hourly-insight` 不帶 `hour` 參數);新增按鈕節點 `netops.pa-live.ai`(includes `netops.ai.use`);手動同一時間一個、冷卻 5 分鐘 |
| Q5 | 吞吐量 / 連線數儀表的滿格值 | 設定值(預設 1 Gbps / 64K,依 PA-560 規格調整)— 未另外詢問,照建議 |

待辦(需求方 / 網通):提供內部網段清單(CIDR、名稱、是否為核心服務)。

## 7. 驗收後的流暢度改善(2026-11-17,已上測試區)

需求方驗收 !120 後希望「畫面更流暢」,接著回報「字太模糊」「Log 表每秒重排仍會卡」「連線數會被近一小時風險擋住」。依序做了四個 MR,都已合併到 develop 並上測試區。

| MR | 內容 |
| --- | --- |
| !121 | 資料更新不再重設 Canvas(節點補間、粒子依 id 對應);粒子上限 400、每秒產生預算 80;粒子光暈改預繪貼圖;移除 `shadowBlur` 與疊在 Canvas 上的 `backdrop-filter`;網格靜態層;畫布超過約 210 萬像素降解析;自動降級 0–2 級;Log / 事件欄每秒最多更新一次;窄版面;mock `?mock=1&load=high` |
| !122 | 兩層畫布 + `transferControlToOffscreen`:頁面上的 canvas 設 `ctx.font` 會強制整頁樣式重算(Log 表持續改 DOM 時每次約 5ms,每幀 54 次共 20ms → 降級 → 字糊);文字與圖示畫在文字層(每幀清空、依 dpr 上限 2) |
| !123 | Log 表虛擬捲動(固定列高 25、`table-layout: fixed`、只渲染可見列);Log 表 / 即時事件 / 近一小時風險可收摺(localStorage `wr-log` / `wr-feed` / `wr-risk`,收摺時內容卸載);寬版面核心依 AI 框與風險框實際高度置中縮放 |
| !124 | Log 表內 IP 對照名稱強制單行(原本換行把列撐到 48px,虛擬捲動位置會偏) |

### 測試區量測(真實流量,1080p 等級視窗,dpr 1)

| 指標 | 改善前 | !121 | !122 | !123 |
| --- | --- | --- | --- | --- |
| Canvas 每幀 JS 平均 / p95 | 25.2 / 49.4 ms | 21.1 / 44.7 ms | 1.7 / 2.6 ms | 2.4 / 3.9 ms |
| 粒子 | ≈1117 | ≈120(已降級) | ≈120(已降級) | ≤400(未降級) |
| fps | 20–40 | 27 | 23–29 | **71** |
| 長任務(50ms 以上) | — | 15 秒 46 次 | 10 秒 27 次(全來自 Log 表) | **20 秒 0 次** |
| DOM 變動 / 秒 | 394 | 369 | 372–392 | 104 |
| 自動降級 | — | 第 2 級 | 第 2 級 | 第 0 級 |
| 文字 | — | 糊 | 清晰 | 清晰 |

10 分鐘 heap(!121 時量):9.9 → 9.5 MB,在 8.9–14.6 MB 間來回,沒有持續成長。

### 回歸量測方式

- 本機 `MOCK=admin npm run dev`,開 `/netops/firewall/live?mock=1&load=high`(流量約為測試區的量,粒子會到上限)。
- 自動降級等級在主畫布的 `data-degrade` 屬性(0–2)。
- 量測腳本(每幀 JS、rAF 間隔、longtask、MutationObserver)用 DevTools 主控台即可,不提交。**瀏覽器面板 / 分頁隱藏時 rAF 會被節流,FPS 數字不可信**。

### 驗收時看到、尚未處理

- 系統狀態抽屜同時顯示「輪詢中 / 接收中」與「測試區開關 輪詢:停用 / 接收:停用」,實機也矛盾(後端狀態或文案待確認)。
- Log 表篩選「威脅」時常為空:近 200 筆被 TRAFFIC 擠滿(是否要讓威脅另外保留,待需求方決定)。
- 資料平面 CPU 一直顯示 0%(管理平面 3%),是否為真值待確認。
- 1080p 下 AI 框與風險框都展開時核心偏小(R 下限 48);收摺任一框會自動放大。
- 後續選項(未做):粒子改 typed array、OffscreenCanvas 搬到 Worker。
