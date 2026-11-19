# Gemini 提示詞:防火牆 › 安全規則頁(PR-4)

> 給 Gemini 的工作提示詞(需求方 2026-11-19:「工作到畫面階段後停止,交接給 gemini」)。結構同 `GEMINI-PROMPT-SG.md`。
> 資料與邏輯(PR-2 後端、PR-3 前端邏輯、PR-5 排序檢查與 AI 判讀)已由 Claude 完成;這份只交代**畫面**。

---

你在 NetOps repo(`D:\檔案分享\程式碼\GigaNexusAI\NetOps`)做**前端頁面與元件**。

## 先讀

1. 工作區 `../AGENT.md` §7(Claude / Gemini 分工:你能改、不能改的範圍)、本 repo `AGENT.md`「AI 分工」。
2. `docs/WARROOM-DIRECTION-POLICY-PLAN.md` §3.3(PR-4 頁面需求)、§3.5(規則圖)、§3.6(規則搭配 IP 對照表)、§4 Q4–Q6(需求方原話)。
3. 下列 composable 檔案**開頭的說明註解**(用法寫在那裡;都回傳 reactive 物件,模板直接用 `p.rules`,不用 `.value`,也不要解構):
   - `frontend/src/composables/usePaPolicy.ts`:清單、篩選、規則詳細、手動重新整理、IP 對照、用名稱找規則、變更紀錄
   - `frontend/src/composables/usePaPolicyViz.ts`:規則圖三張圖的資料(純資料,不是 ECharts option)
   - `frontend/src/composables/usePaPolicyCheck.ts`:排序檢查與 AI 判讀
   - `frontend/src/api/paPolicy.ts`:欄位型別(只看型別,頁面不要直接呼叫 `paPolicyApi`)
4. 版面與風格參考:`frontend/src/pages/firewall/Search.vue`(表格與篩選)、`frontend/src/pages/firewall/Insight.vue`(圖表、AI 按鈕)、`frontend/src/pages/knowledge/IpNames.vue`;圖表元件 `frontend/src/ui/charts/`(`GEChart.vue`、`GSankey.vue`;`GHeatmap.vue` 是時間熱力圖,不適合 zone 矩陣,矩陣請用 `GEChart` 的 heatmap 或 CSS Grid)。

## 分支

- 若 MR(`feature/pa-policy-api`、`feature/pa-policy-check`)都已合併:從 `origin/develop` 最新開 `feature/pa-policy-page`。
- 若還沒合併:從 `origin/feature/pa-policy-check` 開,MR 描述寫「依賴 PR-2/3、PR-5 兩個 MR,須在其後合併」。
- 先 `git remote -v`,指向 `10.10.130.123` 的那個(這個 repo 是 `origin`)才是 GitLab。

## 頁面

`frontend/src/pages/firewall/Policies.vue`(取代目前的佔位頁;路由 `/netops/firewall/policies`、選單「安全規則」已接好)。頁面內用分頁(Tab 元件,看其他頁的做法)切換四個分頁:

| # | 分頁 | 內容 | 用哪個 composable / 欄位 |
| --- | --- | --- | --- |
| 1 | 清單 | 表格仿 PA GUI:編號 `position`(篩選後仍是原編號)、名稱、標籤、類型;來源(zone、位址、使用者、裝置)與目的(zone、位址、裝置)分組欄;應用、服務、動作、Profile(`profileGroup` 或 `profiles`)、選項(`logStart` / `logEnd` / `logSetting` / `schedule`);命中數與最後命中(`hits.hitCount`、`hits.lastHit`;`hits` 為 null 顯示「—」);**停用規則淡色**;`negateSource` / `negateDestination` 要標「反向」。物件可展開(`expanded.sources[].values` 等;`unresolved` 標「無法展開」,`kind` 為 `dynamic-group` / `region` / `unknown` 時另標)。表格下方列出預設規則 `p.defaults`(intrazone-default / interzone-default,只有命中數)。篩選:關鍵字 `q`、zone、IP(`p.ipError` 有值時顯示錯誤、不送出)、含 any 勾選 `includeAny`、應用、動作、長期未命中 N 天、停用;按「查詢」呼叫 `p.load()`。點列開抽屜:`p.openRule(name)` → `p.detail.rule`(同欄位,另有 `detail.fetchedAt`) | `usePaPolicy()`:`filters`、`load()`、`rules`、`total`、`defaults`、`info`、`loading`、`error`、`openRule`、`detail`、`detailLoading`、`detailError`、`closeRule` |
| 1a | 清單頁首 | 快照時間 `p.info.fetchedAt`、`p.info.stale` 為 true 時顯示警告「超過 2 小時沒更新」;`p.info.available === false` 時整頁用 GEmpty 顯示 `p.info.message`(不顯示空表格);收集狀態 `p.info.status.state`(ok / failed / rejected 管理平面 CPU 過高 / paused)與 `message`、`mgmtCpu`;「重新整理」按鈕只在 `p.canRefresh` 時顯示,`p.cooldownSec > 0` 時停用並顯示倒數,按下 `p.refresh()` 後顯示 `p.refreshNotice` | `usePaPolicy()` |
| 1b | IP 對照(§3.6) | **只有 `p.canNames` 為 true 才呼叫**:開抽屜或展開物件時呼叫 `p.resolveNames(rule)`,每個展開值用 `p.nameOf(value)` 顯示:`ip` → 「IP(姓名 / 部門 / 設備)」;`range` → 可展開列出 `items`(`truncated` 時註明「只列前 50 筆,共 total 筆」);`none` → 只顯示 IP;`unresolvable` → 標「無法對照」;`pending` → 載入中。`p.canNames` 為 false 時只顯示 IP,不顯示任何錯誤。另加「用姓名 / 部門 / 設備找規則」輸入框(只在 `p.canNames` 時顯示)→ `p.findByName(keyword)`,回傳 `truncated` 時提示「符合的對照太多,只用前 50 個 IP 篩選」。規則圖分頁**不顯示名稱** | `usePaPolicy()`:`canNames`、`resolveNames`、`nameOf`、`findByName`、`namesError` |
| 2 | 變更紀錄 | 版本清單(`p.loadVersions()` → `p.versions`:`savedAt`、`fetchedAt`、`ruleCount`;註明「收集器讀到的時間,不是 PA Commit 時間」);選一個版本 → `p.openDiff(id)` → `p.diff.rules`(`kind` added / removed / moved / changed,`position`、`basePosition`,`fields[].field / before / after`)與 `p.diff.objects`(各類物件新增 / 刪除 / 修改的名稱)。`p.diff.baseId` 為 null 時顯示「這是第一個版本,沒有可比較的前一版」。可選擇比較基準版本:`p.openDiff(id, baseId)` | `usePaPolicy()`:`versions`、`versionsLoading`、`versionsError`、`loadVersions`、`diff`、`diffLoading`、`diffError`、`openDiff` |
| 3 | 排序檢查 | 門檻輸入 `c.unusedDays`(預設 90)→ `c.load()`;依嚴重度(`SEVERITY_LABELS`)或項目(`CHECK_LABELS`)分組列出 `c.items`:規則編號、名稱、`message`、`related`(可點開對應規則)、`reasons`(undeterminable 的原因);`c.summary` 做摘要數字;`c.imprecise > 0` 時提示「有 N 條規則含無法精準比對的條件」。**「無法判定」不可顯示成沒問題**。AI 判讀按鈕只在 `c.canAi` 時顯示 → `c.runAi()`;回答區用 `c.ai`(`phase`、`statusText`、`text`(Markdown,照其他頁 AI 回答的顯示方式)、`error`、`notices`、`stop()`),回答區上方固定顯示 `AI_DISCLAIMER`(「AI 建議,需網通確認…」) | `usePaPolicyCheck()`;`CHECK_LABELS`、`SEVERITY_LABELS`、`AI_DISCLAIMER` |
| 4 | 規則圖(§3.5) | 三張圖共用篩選 `v.filters.action`(allow / deny)、`v.filters.zone`(選項 `v.zones`)、`v.filters.unusedDays`。① Zone × Zone 矩陣:`v.matrix.rows` × `v.matrix.cols`,格子 `cells[]`(`count` 深淺、`tone` allow / deny / mixed 決定顏色,`max` 做色階,tooltip 列 `positions`);圖旁註明「格子數字是規則出現次數,多 zone 規則會出現在多格」;② 規則順序條:`v.order` 由上往下(`position`;長條 = `logHits`,`zeroHits` 用記號、`hitCount` null 顯示無資料;`tone` 顏色、`disabled` 淡色、`isDefault` 放最後並標「預設規則」;`checks` 為 null 時**不顯示任何檢查標記也不顯示「無問題」**,有陣列時依 `severity` 加標記);規則多時用垂直捲動(ECharts dataZoom);③ Sankey:`v.sankey.nodes`(`layer` 0 來源 zone / 1 動作 / 2 目的 zone;`p:預設規則` 在第 0 層)與 `links`(`value`;`estimated` 為 true 時 tooltip 標「多 zone 規則平均分攤,為估算值」)。連動:點矩陣格 `v.select({ kind: 'cell', from, to })`、點 Sankey 線 `v.select({ kind: 'link', source, target })` → 順序條只強調 `v.highlighted` 內的編號;點順序條規則 → `p.openRule(name)` 開同一個詳細抽屜;清除選取 `v.select(null)` | `usePaPolicyViz(() => p.allRules, () => p.allDefaults, () => c.marks)`,進分頁時呼叫 `p.loadAll()`(`allLoading`、`allError`) |

另外(§3.3 PR-4 最後一句,**可以留到下一個 MR**):Log 明細與戰情室抽屜的規則名稱可點開規則內容。這需要跨頁開抽屜,做之前先在 MR 說明列出想怎麼接,需要新的 composable 交給 Claude。

- 按鈕顯示一律用 composable 給的 `canRefresh`、`canNames`、`canAi`,**不要自己寫權限判斷**。
- 時間顯示用 `@/api/format` 既有的格式函式;數字用 `fmtNum`。
- 文案繁體中文;PA 欄位名稱可保留英文(Source Zone、Profile 等),旁邊附中文。
- 元件測試可以用 `usePaPolicy({ backend, can })`、`usePaPolicyCheck({ backend, can })` 注入假資料(參考 `frontend/test/paPolicy.test.ts` 的 `rule()` 與 `fakeBackend`);開發時可在頁面元件測試或 storybook 式頁面用假資料,不要改 composable。

## 權限(已登記,不要改)

| 代碼 | 種類 | 給誰 | 用途 |
| --- | --- | --- | --- |
| `netops.pa-policy-page.read` | 選單 | admin、viewer | 進入頁面(includes `netops.pa-policy.read`) |
| `netops.pa-policy-page.refresh` | 按鈕 | admin | 手動重新整理(`p.canRefresh`) |
| `netops.pa-policy-page.ai` | 按鈕 | admin、viewer | AI 判讀(`c.canAi`) |
| `netops.ip-name.read` | API(IP 對照表選單帶入) | admin | 規則位址的姓名 / 部門(`p.canNames`) |

錯誤代碼(顯示用,`@/api/paPolicy` 的 `PA_POLICY_ERRORS`):`NETOPS_PA_POLICY_NOT_FOUND`(規則已刪除或改名)、`NETOPS_PA_POLICY_UNAVAILABLE`、`NETOPS_PA_POLICY_REFRESH_COOLDOWN`、`NETOPS_PA_POLICY_DISABLED`、`NETOPS_PA_POLICY_VERSION_NOT_FOUND`(只保留 50 份)。錯誤訊息用既有的 `describeError` / toast 顯示。

## 禁止(即使一行也不要改)

- `composables/`、`api/`、`router.ts`、store、權限判斷 —— 這些是 Claude 的範圍。需要新的資料、API、狀態或權限時,寫在 MR 說明交給 Claude。
- 後端、`package.json`、lock 檔、`vite.config.*`、`tsconfig*`、Dockerfile、`deploy/`、`.gitlab-ci.yml`、`.env*`、`pa-collector/`。
- 不推 `develop` / `main`,不 force push。

## 完成標準

1. 在 `frontend/` 執行 `npm run typecheck`、`npm test`、`npm run build` 都通過。失敗時**不要**為了讓它通過去改測試或邏輯,寫進報告。
2. 可以為自己的頁面 / 元件新增元件測試。
3. 寫測試報告 `docs/test-reports/YYYY-MM-DD-pa-policy-page.md`(環境、結果、失敗項目、可能問題、建議交給 Claude 的項目)。
4. 推 `origin` 和 `github`,在 GitLab 開 MR → `develop`,只開不合併。MR 說明列出:做了哪些畫面、截圖(四個分頁、沒有權限時、沒有快照時)、需要 Claude 補的邏輯。
5. 可以在 `docs/PROJECT-MAP.md` 補上新頁面 / 元件那一行,其他段落不動。
