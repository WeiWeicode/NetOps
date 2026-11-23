# Gemini 提示詞:網段設定頁(SG-3)與搭配 A–D 畫面

> 這份是給 Gemini 的工作提示詞(需求方 2026-11-18)。不要提交這份檔案。

---

你在 NetOps repo(`D:\檔案分享\程式碼\GigaNexusAI\NetOps`)做**前端頁面與元件**。

## 先讀
1. 工作區 `../AGENT.md` §7(Claude / Gemini 分工:你能改、不能改的範圍)、本 repo `AGENT.md`。
2. `docs/SEGMENT-SETTINGS-PLAN.md` 全部(§2 頁面功能、§3 搭配 A–D、§6 / §7 需求方決定)。
3. 下列 composable 檔案**開頭的說明註解**(用法寫在那裡):
   - `frontend/src/composables/useSegmentSettings.ts`(回傳 reactive 物件,模板直接用 `s.canSave`,不用 `.value`)
   - `frontend/src/composables/useSegmentPairing.ts`(`useUnmatchedAssist`、`useIpNameCidrImport`、`useSegmentLookup`、`useSegmentDeviceNames`)
   - `frontend/src/composables/segmentsMock.ts`(假資料,開發用)
4. 版面與風格參考:`frontend/src/pages/knowledge/IpNames.vue`(同群組的設定頁)、`frontend/src/components/warroom/`。

## 分支
- 若 MR !131 已合併:從 `origin/develop` 最新開 `feature/segment-settings-ui`。
- 若還沒合併:從 `origin/feature/segment-pairing-logic` 開,MR 描述寫「依賴 !131,須在其後合併」。
- 先 `git remote -v`,指向 `10.10.130.123` 的那個(這個 repo 是 `origin`)才是 GitLab。

## 要做的畫面
| # | 位置 | 內容 | 用哪個 composable |
| --- | --- | --- | --- |
| SG-3 | `frontend/src/pages/settings/Segments.vue`(取代目前的佔位頁) | 網段清單(名稱、類型 VLAN / 核心服務、圖示、多個 CIDR、排序;新增 / 修改 / 刪除 / 拖曳排序);儀表滿格值(吞吐量、連線數);即時驗證錯誤與網段重疊標示;流量預覽(近 5 分鐘各網段連線數、未分類內部 IP Top 20);儲存;版本衝突提示(重新載入 / 保留草稿重套);匯入 / 匯出 JSON | `useSegmentSettings()` |
| A | 網段設定頁的預覽區 | 未分類 IP 表格旁顯示設備名稱 / 部門(有權限才有資料),按鈕「加入某網段」、「依此 IP 建 /24 網段」 | `useUnmatchedAssist` |
| B | 網段設定頁 | 「從 IP 對照表匯入」對話框:列出 IP 對照表中的網段列,勾選後匯入成網段 | `useIpNameCidrImport` |
| C | `frontend/src/pages/knowledge/IpNames.vue` | 加一欄「網段」(唯讀) | `useSegmentLookup` |
| D | 戰情室右側網段節點 | 滑過節點時顯示該網段 Top 內部 IP(`topIps`),有權限的人多看到設備名稱,沒權限只看 IP | `useSegmentDeviceNames` |

- 寫入相關按鈕依 `netops.segment-page.write` 顯示 / 停用,用既有的權限判斷方式(看其他頁怎麼做),**不要自己寫權限判斷**。
- 文案用繁體中文,用詞跟 IP 對照表頁一致。
- D 的提示框不要改動 Canvas 的繪製邏輯;如果需要從 Canvas 拿「滑過哪個節點」的事件而目前沒有,停下來寫進 MR 說明交給 Claude。

## 禁止(即使一行也不要改)
- `composables/`、`api/`、`router.ts`、store、權限判斷 —— 這些是 Claude 的範圍。需要新的資料、API、狀態或權限時,寫在 MR 說明交給 Claude。
- 後端、`package.json`、lock 檔、`vite.config.*`、`tsconfig*`、Dockerfile、`deploy/`、`.gitlab-ci.yml`、`.env*`。
- 不推 `develop` / `main`,不 force push。

## 完成標準
1. 在 `frontend/` 執行 `npm run typecheck`、`npm test`、`npm run build` 都通過。失敗時**不要**為了讓它通過去改測試或邏輯,寫進報告。
2. 可以為自己的頁面 / 元件新增元件測試。
3. 寫測試報告 `docs/test-reports/2026-11-18-segment-settings-ui.md`(環境、結果、失敗項目、可能問題、建議交給 Claude 的項目)。
4. 推 `origin` 和 `github`,在 GitLab 開 MR → `develop`,只開不合併。MR 說明列出:做了哪些畫面、截圖、需要 Claude 補的邏輯。
5. 可以在 `docs/PROJECT-MAP.md` 補上新頁面 / 元件那一行,其他段落不動。
