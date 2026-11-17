# NetOps WR-5 PA 即時監控戰情室畫面與元件測試報告(2026-11-17)

> **結論**:`frontend/` 型別檢查(`npm run typecheck`)、正式建置(`npm run build`)、插槽名稱檢查(`test/slots.test.ts`)與新增戰情室掛載測試(`test/warroom.mount.test.ts` 9 項)全部通過。
> 全體測試(`npm test`)共 34 個測試檔、245 個測試項目:其中 **33 檔 / 238 項通過**;唯一失敗的 1 檔(`test/live.mount.test.ts` 7 項)為舊版 R1 即時監控頁(`Live.vue` 改寫前「即時排行 / 即時 log / 介面流量」卡片結構)的既有掛載測試,依 `AGENT.md`「AI 分工」與交接文件 §4 規定**未修改既有測試檔**,完整記錄於本報告 §3、§4 交由 Claude 後續處理。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 分支 / 基底 Commit | `feature/warroom-ui`(基於 `origin/feature/warroom-frontend-logic` `3d660fe`) |
| 部署區 / 模式 | 本機開發與單元測試環境(`dev`,瀏覽器驗證使用 `MOCK=admin` + `?mock=1`) |
| 測試框架 | Vitest 5.0.2(`happy-dom`)+ `@vue/test-utils` 2.5.1 + Vite 8.3.1 + `vue-tsc` |
| 執行指令 | `cd frontend && npm run typecheck && npm test && npm run build` |

## 2. 結果摘要

| 檢查項目 | 執行指令 | 結果 | 通過 / 失敗 / 略過 |
| --- | --- | --- | --- |
| TypeScript 與 Vue 模板型別檢查 | `npm run typecheck` | **通過** | 0 errors |
| 前端單元與元件掛載測試 | `npm test` | **部分失敗**(舊頁測試 1 檔) | 測試檔:33 通過 / 1 失敗 / 0 略過(共 34 檔)<br>測試項:**238 通過 / 7 失敗 / 0 略過**(共 245 項) |
| 戰情室元件掛載測試 + 插槽檢查 | `npx vitest run test/warroom.mount.test.ts test/slots.test.ts` | **通過** | 2 檔 / 11 項全數通過 |
| 前端正式建置 | `npm run build` | **通過** | 2641 modules transformed,`dist/assets/Live-*.js`(68.12 kB / gzip 24.96 kB) |

## 3. 失敗項目

唯一失敗檔案為 `frontend/test/live.mount.test.ts`(共 7 項測試):

1. `即時監控頁(掛載) > 即時排行的類型下拉、5 / 15 / 60 分鐘切換顯示在卡片標題右側;切換會重新查詢`
   - 錯誤訊息摘錄:`Error: 找不到卡片「即時排行」 (at card test/live.mount.test.ts:89:17)`
2. `即時監控頁(掛載) > 即時 log 的暫停 / 繼續按鈕顯示在卡片標題右側,按下切換`
   - 錯誤訊息摘錄:`Error: 找不到卡片「即時 log」 (at card test/live.mount.test.ts:89:17)`
3. `即時監控頁(掛載) > 接收未啟用:排行與即時 log 都說明「接收端點未啟用,沒有 log 來源」,不寫成這段期間沒有收到`
   - 錯誤訊息摘錄:`Error: 找不到卡片「即時排行」 (at card test/live.mount.test.ts:89:17)`
4. `即時監控頁(掛載) > 輪詢暫停:介面流量顯示「停止更新」,不顯示暫停前最後一輪的值`
   - 錯誤訊息摘錄:`Error: 找不到卡片「介面流量」 (at card test/live.mount.test.ts:89:17)`
5. `即時監控頁(掛載) > 輪詢中:介面流量照常顯示`
   - 錯誤訊息摘錄:`Error: 找不到卡片「介面流量」 (at card test/live.mount.test.ts:89:17)`
6. `即時監控頁(掛載) > URL 過濾的 log 不顯示「名稱」欄(固定 9999),改顯示 URL 類別`
   - 錯誤訊息摘錄:`Error: 找不到卡片「即時 log」 (at card test/live.mount.test.ts:89:17)`
7. `即時監控頁(掛載) > 威脅 log 有「來源 Port」欄:有值顯示 Port,缺值或 0 顯示「—」;TRAFFIC 不變`
   - 錯誤訊息摘錄:`Error: 找不到卡片「即時 log」 (at card test/live.mount.test.ts:89:17)`

## 4. 可能問題與根因分析

- **推測原因**:
  - 依 `docs/WARROOM-PLAN.md` §6 Q1 決策與 `docs/WARROOM-GEMINI-HANDOFF.md` §2 指示,WR-5 將 `frontend/src/pages/firewall/Live.vue` **直接改寫為戰情室畫面(取代現頁)**,原頁面的「收集器狀態、介面流量、測試區開關」移至收摺的 `SystemStatusDrawer.vue`,原本的「即時排行」與舊版「即時 log」`GCard` 卡片已被戰情室 Canvas、右欄 `EventFeed.vue` 與底部 `TrafficLogTable.vue` 取代。
  - 然而 `frontend/test/live.mount.test.ts`(第 87–91 行)仍掛載 `Live.vue` 並在頂層尋找標題為 `「即時排行」`、`「即時 log」`、`「介面流量」` 的 `section.g-card`,因此在 `Live.vue` 改寫為戰情室後必然找不到舊版卡片。
- **相關檔案與行號**:
  - `frontend/test/live.mount.test.ts#L87-L189`
  - `frontend/src/pages/firewall/Live.vue#L1-L290`
  - `frontend/src/components/warroom/SystemStatusDrawer.vue#L1-L165`
- **重現步驟**:
  1. 在 `frontend/` 執行 `npx vitest run test/live.mount.test.ts`
  2. 觀察 `card(w, '即時排行')`、`card(w, '即時 log')`、`card(w, '介面流量')` 拋出找不到卡片錯誤。
- **影響範圍**:
  - 僅影響舊版 `test/live.mount.test.ts` 測試腳本本身;新戰情室頁面與 `SystemStatusDrawer.vue` 的功能已由新增的 `frontend/test/warroom.mount.test.ts`(9 項測試)完整涵蓋並驗證通過。
- **潛在風險與其他觀察**:
  1. **測試執行期間的 `AggregateError (ECONNREFUSED 127.0.0.1:3000)` 警告輸出**:在 `test/ipNames.mount.test.ts` 等測試執行期間,終端機印出數筆連線 `127.0.0.1:3000` 被拒的非致命錯誤(測試本身皆通過),推測為部分元件未 mock 到的背景請求打向預設開發 port,不影響測試判定但建議留意。
  2. **建置 Chunk 大小提醒**:`npm run build` 提示 `echarts-*.js`(905.49 kB,gzip 302.69 kB)超過 500 kB;此為 V-b1 既有獨立動態載入 chunk,未進入戰情室或首頁 bundle。

## 5. 建議交給 Claude 處理的項目

1. **移除或改寫舊版 `frontend/test/live.mount.test.ts`**:
   - 因 `Live.vue` 已依 Q1 定案改寫為戰情室,舊版「即時排行 / URL 過濾名稱欄 / 來源 Port 欄」已不在 `Live.vue` 中,而「介面流量 / 收集器狀態 / 測試區開關」已移入 `SystemStatusDrawer.vue`(並已在 `test/warroom.mount.test.ts` 測試)。請 Claude 移除過時的 `test/live.mount.test.ts` 或將其整併至 `test/warroom.mount.test.ts`。
2. **確認沒有需要新增的後端欄位或前端套件**:
   - 目前 `useWarroom()` 與 `useWarroomAi()` 提供的欄位(`nodes`、`links`、`particleRate`、`rates`、`kpis`、`snapshot`、`gauge`、`risk`、`geoAttribution`、`notices`、`events`、`logs`、`filter`、`paused`、`focus`、`toggleFocus`、`setControl` 等)已完全滿足樣稿 `warroom-v5.html` 所需,無須新增額外 API 欄位或 npm 套件。
