# 戰情室畫面交接(給 Gemini,WR-5)

> 計畫:[`WARROOM-PLAN.md`](WARROOM-PLAN.md)。樣稿(定稿 v5):[`mockups/warroom-v5.html`](mockups/warroom-v5.html),用瀏覽器直接開。
> 你負責 **頁面與元件**;資料、狀態、權限一律用 Claude 寫好的 composable,不自行 fetch、不自寫權限判斷(`AGENT.md`「AI 分工」)。

## 1. 分支

```bash
git fetch origin
git switch -c feature/warroom-ui origin/feature/warroom-frontend-logic
```

- 基底是 `feature/warroom-frontend-logic`(MR !113,前端邏輯層,含 mock 模式)。**不要從 develop 開**,develop 還沒有這些 composable。
- 只推 `feature/warroom-ui`,開 MR → `develop`,描述寫「依賴 !113,!113 合併後再合」。不推 develop / main、不 force push。
- !113 之後還會小改(對齊 AI 每小時分析的後端格式);有新 commit 時用 `git merge origin/feature/warroom-frontend-logic` 跟上,衝突就停下回報。

## 2. 要做的檔案

| 檔案 | 內容(對照樣稿) |
| --- | --- |
| `pages/firewall/Live.vue` | **改寫為戰情室**(取代現頁);版面:頂部 KPI、左說明、中央 Canvas、右事件、上 AI 框、下高風險統計、底部 Log 表 |
| `components/warroom/WarroomCanvas.vue` | 節點(線條圖示、服務六角 / 其他圓、旋轉光弧、阻擋比例高的紅色脈衝)、連線、粒子拖尾、阻擋火花、中央核心(六角盾、分段負載環、刻度環、雷達掃描、log 類型衛星、擴散波、電弧、吞吐量/連線數儀表弧);滑過明細、點擊聚焦 |
| `components/warroom/AiPanel.vue` | AI 分析框:光球、逐字顯示、自動/手動與時間、立即分析(冷卻倒數) |
| `components/warroom/RiskPanel.vue` | 近一小時高風險統計:總覽 4 數字 + Top 威脅類型 + Top 攻擊來源長條 |
| `components/warroom/EventFeed.vue` | 右欄即時事件 |
| `components/warroom/TrafficLogTable.vue` | 底部 Log 表、篩選、暫停 |
| `components/warroom/LegendPanel.vue` | 左側說明,可收摺(localStorage 記住);收摺後 Canvas 放大 |
| `components/warroom/SystemStatusDrawer.vue` | 收摺抽屜:收集器狀態、測試區暫停開關(原 Live.vue 的內容搬來) |
| `components/warroom/Notices.vue` | 提示橫幅(`notices[]`)與 DB-IP 授權字樣 |

## 3. composable 使用說明

### `const w = useWarroom()`

- 節點:`w.nodes.sources[]`(`id` 為 `cc:<國家>`、`ip:<IP>`、`other`、`lan`=內部互連;`label`、`country`、`conn`、`deny`、`threat`、`topDst`/`topApp` `[{key,count}]`、`denyRatio`、`tone` allow/warn/deny、`size` 0–1、`rates`)。`w.nodes.segments[]`(`kind` vlan/service/other,`label`、`icon`、`conn`、`bytes`、`threat`、`size`、`rates`;`unmatched`=未分類)。
- 連線:`w.links[]`(每秒 `conn`/`allow`/`deny`/`threat`、`denyRatio`、`tone`、`dimmed`=聚焦外要淡出)。粒子數用匯出的 `particleRate(link, w.rates.value.conn)`,已有總量上限。
- KPI:`w.rates`(每秒總量)、`w.kpis` `{denyPerMin, threat5m}`(partial 時為 null,顯示「—」)、`w.snapshot`(吞吐量、連線數、新連線/秒、DP CPU)。
- 儀表滿格:`w.gauge` `{throughputMaxBps, sessionMax}`,**不要寫死**。
- 高風險:`w.risk`(`threats`/`denies`/`attackSources`/`critical` partial 時 null;`attackSourcesLowerBound` 為 true 時數字前加「≥」;`topThreats[{name,severity,count}]`、`topSources[{key,label,country,count,denyRatio}]`)。
- **必顯示**:
  - `w.geoAttribution` 不為 null 時,畫面要顯示「IP Geolocation by DB-IP」並連到 `https://db-ip.com`(授權規定;用回應的 `text`、`url`,放頁尾或說明區)。
  - `w.notices[]` `{key,tone,text}` 全部顯示成橫幅或標籤(`segments-example` 範例網段、`segments-invalid`、`estimated` / `risk-estimated` 推估值、`partial` / `risk-partial`、`geo-unavailable`)。
- 事件與 Log:`w.events`(最新 30 筆 `{log,kind}`,不受篩選影響);`w.logs`(底部表最多 200 筆,受 `w.filter` `'all'|'deny'|'allow'|'threat'`、`w.paused`、聚焦控制;欄位 `src`、`dst`、`dport`、`app`、`rule`、`bytes`、`action`、`severity`/`name`、`country`、`segment`)。
- 聚焦:`w.toggleFocus({ side: 'source'|'segment', id })`,再點同一個取消;點空白 `w.toggleFocus(null)`。
- 狀態:`w.stale`(超過 15 秒沒更新)、`w.partial`、`w.connected`、`w.streamError`、`w.warroomError`、`w.riskError`,都要有對應的畫面提示。
- 系統狀態抽屜:`w.snapshot` + `composables/paLive.ts` 既有的 `collectorView`、`collectorBadges`、`controlView`;暫停開關呼叫 `w.setControl({ pollPaused, receivePaused })`(正式區會拒絕,照既有畫面顯示)。

### `const a = useWarroomAi()`

- `a.text`(執行中是逐字串流,否則是最新分析)、`a.insight` `{hour, model, trigger, status, partial}`、`a.running`、`a.failed`(顯示「本小時分析失敗」)、`a.runError`。
- 按鈕:`v-if="a.allowed"`、`:disabled="!a.canRun"`(已含權限 `netops.pa-live.ai`、執行中、冷卻);`a.cooldownSec` 做倒數;點擊呼叫 `a.run()`。
- 後端 WR-3 格式還在對齊,欄位名稱以 composable 為準,不要直接讀 API。

### mock 模式(只在開發用)

- 網址加 `?mock=1`(例如 `http://localhost:5173/netops/firewall/live?mock=1`),或在 `.env.development.local` 設 `VITE_WARROOM_MOCK=1`(這個檔不進版控)。正式建置一律關閉。

## 4. 規則

- 不改:`api/`、`composables/`、`router.ts`、`package.json`、lock 檔、`vite.config.*`、`deploy/`、CI、後端。需要新欄位、新狀態或新套件時寫在 MR 說明交給 Claude。
- Canvas:粒子用 `particleRate`(已有上限);分頁隱藏時暫停;元件卸載時取消 `requestAnimationFrame`、移除事件監聽;長時間掛在電視牆不可記憶體成長。
- 主題色與元件依 `docs/UI-GUIDE.md`;深色戰情室配色可沿用樣稿的 CSS 變數。
- 元件測試:你負責的元件可以新增測試;測試失敗**不得**為了通過而改測試或程式,寫進報告。
- 完成後執行 `npm run typecheck`、`npm test`、`npm run build`(在 `frontend/`),寫測試報告 `docs/test-reports/YYYY-MM-DD-warroom-ui.md`(AGENT「測試報告」格式)。
- 可在 `docs/PROJECT-MAP.md` 補新元件那幾行;其他文件不改。
