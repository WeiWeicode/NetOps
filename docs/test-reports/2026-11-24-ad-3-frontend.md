# 測試報告:AD-3 前端畫面(DC Agent 狀態列、IP 名稱、明細查詢、對帳與補漏)

## 1. 環境

- 分支:`feature/ad-3-frontend`(從修正後的 `origin/feature/ad-3-api-reconcile` `87c63de` 開出,依賴 !184、!186、!187)
- 部署區:**本機**(Windows 10 開發機,`MOCK=admin` 本機 dev server 預覽與截圖;沒有部署到測試區或正式區,沒有連主機 2 / 主機 3)
- 執行的指令(`frontend/`):
  - `npm run typecheck`(`vue-tsc --noEmit -p tsconfig.json`)
  - `npm test`(`vitest run`)
  - `npm run build`(`vite build`)
  - 本機 `MOCK=admin PORT=5181 npm run dev` + 內建瀏覽器(1440×900)巡檢 `/netops/ad/events`、`/netops/ad/search`、`/netops/ad/files`、`/netops/ad/ask`

## 2. 結果

| 項目 | 通過 | 失敗 | 略過 |
| --- | --- | --- | --- |
| `npm run typecheck` | 通過 | — | — |
| `npm test`(全部 47 測試檔) | 374 | 0 | 0 |
| ├ 新增 `test/ad3.test.ts`(純函式、輪詢生命週期、`GSourceBadge`) | 7 | 0 | 0 |
| ├ 新增 `test/ad3.mount.test.ts`(4 個畫面掛載與錯誤 / 權限 / XSS 測試) | 9 | 0 | 0 |
| `npm run build` | 通過 | — | — |
| 本機 `MOCK=admin` 瀏覽器 4 畫面巡檢與截圖 | 通過(0 console error) | 0 | — |

涵蓋的驗收條件:
- **clickhouse / ftp 兩種來源**:`ftp` 來源不顯示 `AgentBar`、不呼叫 `/ad/agents`、DC 篩選為自由輸入框;`clickhouse` 來源顯示 `AgentBar`、DC 下拉選項來自 `agents` 與 `days[].computers`。
- **空資料**:`AgentBar` 顯示「尚未有 DC Agent 回報」;`ReconCard` `window === null` 顯示「沒有可對帳的日子」。
- **錯誤處理(不顯示成空資料,附 `requestId`)**:`424 NETOPS_REDIS_UNAVAILABLE`(狀態列提示不擋總覽)、`503 NETOPS_CLICKHOUSE_UNAVAILABLE`(總覽與明細顯示錯誤、對帳卡片提示不影響原 FTP 檔案清單)、`400 VALIDATION_FAILED`(`details[].field === 'name'` 顯示於名稱輸入框下方)、`409`(`NETOPS_RECON_PENDING` / `NETOPS_BACKFILL_NOTHING` / `NETOPS_BACKFILL_BUSY`)、`422 NETOPS_EXPORT_TOO_LARGE`。
- **輪詢停止**:`useAdAgents`(30 秒)與 `useAdReconcile`(2 秒)在 `document.hidden === true` 時完全停止排程、重新顯示時立刻查詢,元件卸載 / scope 結束時清除計時器與事件監聽。
- **安全性**:DC 送來的 `lastError` 與 `events[].detail` 驗證僅以純文字插值呈現,惡意 `<script>` / `<img>` 字串不產生任何 DOM 元素。
- **權限**:無 `netops.ad-files.manage` 時對帳卡片隱藏「立即對帳」與「補漏」按鈕。

## 3. 失敗項目

最終版本沒有失敗。開發過程中抓到並修正 1 項程式問題:
- 第一次跑 `test/ad3.mount.test.ts` 時,「展開 DC × 記錄、送出補漏並輪詢至 done」失敗:補漏完成後呼叫 `runDay()` 刷新該日對帳列時,`updateDayRow()` 直接覆蓋整個列,把本頁剛寫入的 `backfills` 工作 id 洗掉,導致工作結果卡片(`waitingAgent` / `ambiguous`)消失。已於 `frontend/src/composables/adReconcile.ts` 改為合併保留既有 `backfills` id,重跑全部 372 項測試通過。

## 4. 可能問題

- **與交接規格的小幅差異(以後端程式為準)**:
  1. `dcDomain` 長度上限:交接規格 §6.3 寫 `≤ 128 字`,後端 !187 審查 L1 已放寬至 DNS 上限 `253 字`(`9f8ed84`),前端驗證已對齊後端為 `253 字`。
  2. `GSourceBadge.vue` 原本僅接受 PA 時段明細的 `SliceSource` (`'hot' | 'cold' | 'mixed'`),本批擴充支援 AD 的 `'agent' | 'ftp'` 並保留原有 PA 樣式與語意不變。
- **既有警告(非本批引入)**:
  - vitest 執行既有 `dailySync` / `warroom` 等測試時 stderr 會印出 `ECONNREFUSED 127.0.0.1:3000`(既有行為,全部測試仍通過)。
  - `vite build` 產出 `echarts` chunk > 500 kB 警告(既有)。
- **尚未連真測試區後端驗證**:本批以本機 `MOCK=admin` 與 Vitest 驗證;待 !184 → !186 → !187 → 本 MR 依序合併後,於測試區(主機 2)連真實 ClickHouse / Redis 實測一次。

## 5. 建議的處理項目

1. 依序合併 !184 → !186 → !187 → 本 MR 後,在測試區驗證真後端的 4 個畫面(特別確認 `NETOPS_AD_SOURCE=ftp` 預設模式與切換 `clickhouse` 後的畫面切換、對帳補漏與 IP 名稱顯示)。
2. 後續 docs MR 補記 `docs/PROJECT-MAP.md` 中本次新增的 `AgentBar.vue`、`ReconCard.vue`、`adAgents.ts`、`adReconcile.ts`。
