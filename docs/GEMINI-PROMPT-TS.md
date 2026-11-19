# Gemini 提示詞:威脅特徵碼(TS-1 ~ TS-4)

> 給 Gemini 的工作提示詞。需求方 2026-11-19 決定:TS-1 ~ TS-4 **全部交 Gemini**(邏輯 + 畫面),原話「我這次全給gemini做看看」;每個 MR 由 Claude 審查。結構同 `GEMINI-PROMPT-SG.md`、`GEMINI-PROMPT-PR.md`。
> 計畫書:`docs/THREAT-SIGNATURE-PLAN.md`(以計畫書為準;本檔只交代怎麼做與規則)。

---

你在 NetOps repo(`D:\檔案分享\程式碼\GigaNexusAI\NetOps`)實作「防火牆 › 威脅特徵碼」:收集器、後端 API、前端邏輯與頁面。

## 先讀

1. 工作區 `../AGENT.md` §4、§7、§9(Git 協作);本 repo `AGENT.md` 全部(特別是「AI 分工」、「Git 分支與推送」、§2、§5、§7.2 ~ §7.5、§8)。
2. `docs/THREAT-SIGNATURE-PLAN.md` 全部;**§1.2 是需求方決定,照做**;§2.3、§2.4 是 TS-0 實測結果(2026-11-19),**特徵欄位依實測**:弱點(`/predefined/threats/vulnerability`,約 2.5 萬筆)與間諜軟體(`/predefined/threats/phone-home`,約 1 萬筆,無 CVE)的 entry `name` 是數字 ID,子欄位 `threatname`、`severity`、`category`、`affected-host`、`engine-version`(每筆都有)、`default-action`、`cve`、`vendor`、`disable`、`time-attribute`(部分有);**沒有每筆發布日**。Profile Group 與 VP / AS profile **只讀 vsys1**(shared 沒設定,不讀)。`tests/fake_pa.py` 的假資料照這些欄位做。
3. `docs/ARCHITECTURE.md` D6、D20、D22、D23、D27;`docs/PA-LIVE-PLAN.md` §4(Redis 鍵名慣例);`docs/API.md` 開頭的通用規則與 PR 相關段落。
4. 照著仿的既有實作(安全規則 PR,結構幾乎相同):
   - 收集器:`pa-collector/netops_pa/policies.py`(白名單 `ALLOWED_CMDS`、`PolicyApi`、CPU 保護、手動請求與冷卻、失敗保留上一份快照)、`keys.py`、`config.py`(`PA_POLICY_*`、`read_secret` 的 `*_FILE`)、`__main__.py`(啟動執行者)、`tests/fake_pa.py`、`tests/test_policies.py`。
   - 後端:`backend/src/modules/pa-policy/`(`routes.ts` 只做驗證與權限宣告,邏輯在 `core.ts` / `service.ts`;版本歷史存 `infra/store`)、`backend/src/infra/{redis,store,clickhouse}/`、`modules/ai/`(AI 呼叫與 SSE)、`modules/pa-live/warroom.ts`、`modules/ip-names/`。
   - 前端:`frontend/src/api/paPolicy.ts`、`composables/usePaPolicy.ts`、`usePolicyRuleDrawer.ts`、`useWarroom.ts`;頁面 `pages/firewall/Policies.vue`、`Events.vue`、`Search.vue`;圖表 `ui/charts/`。
   - 權限:`deploy/gateway-rbac.yaml` 的 `netops.pa-policy-page.*` 三行。
5. 程式碼位置先用 CodeGraph(`codegraph explore "<符號或問題>"`),找不到再看 `docs/PROJECT-MAP.md`。

## 分支與開發方式

- 在原 repo 目錄開發,**不開 worktree**。
- 先 `git remote -v`(`origin` 是 GitLab,`github` 是備份),`git fetch origin`,回報落後 `origin/develop` 幾個 commit。
- 每批從 `origin/develop` 最新開 `feature/ts-<批>`(`feature/ts-1` … `feature/ts-4`)。前一批還沒合併時從前一批分支開(堆疊),**MR 描述寫依賴順序**(例如「依賴 !xxx(TS-1),須在其後合併」)。
- 推 `origin` 和 `github`,在 GitLab 開 MR → `develop`,只開不合併。

## 分批

| 批次 | 內容(細節見計畫書) |
| --- | --- |
| TS-1 | `pa-collector/netops_pa/signatures.py`:每 30 分鐘讀 `show system info`,`threat-version` 變了 / 手動 / 沒快照才讀全清單;讀 Profile Group 與 VP / AS profile(§4.1、§5.2);白名單完全比對;CPU > 50% 或輪詢暫停不送;寫 Redis 快照與狀態;設定 `PA_SIGNATURE_*`(預設關閉) |
| TS-2 | 後端 API(計畫書 §7)、版本差異存 `infra/store`(保留 90 份)、命中比對(ClickHouse `pa_threat_logs`)、規則覆蓋、戰情室 `newSignatureHits`;`deploy/gateway-rbac.yaml` 登記;前端 `api/paSignature.ts`、`composables/usePaSignature.ts`、`usePaSignatureDrawer.ts` |
| TS-3 | AI 摘要(§5.3):組統計、prompt、API;權限綁 `netops.ai.use` + `netops.pa-signature.read` |
| TS-4 | 頁面「防火牆 › 威脅特徵碼」(清單、版本差異、命中、規則覆蓋、AI);安全事件 / Log 明細 / 戰情室的威脅名稱開特徵碼抽屜;戰情室新特徵碼命中提示列 |

## 需求方決定(2026-11-19,照做,不要重新討論)

1. 資料來源:兩者都做,本機為主。第一階段 netops-pa 用唯讀 op 讀 PA 本機特徵庫,內容版本變動時比對新增 / 變更 / 停用並保存版本歷史(Redis 或 `infra/store`,不用關聯式資料庫)。第二階段 Threat Vault(TS-5)等需求方申請到 Key 再做,**這次不做**。
2. 結合範圍四項都做:a. 命中比對 b. 規則覆蓋 c. AI 摘要 d. 戰情室 / 安全事件連結。
3. 頁面:**防火牆 › 威脅特徵碼**;權限代碼 `netops.pa-signature.read`(檢視)、`netops.pa-signature.refresh`(手動更新)。
4. TS-1 ~ TS-4 全部交 Gemini(邏輯 + 畫面);TS-0 已完成(計畫書 §2.4)。
5. 每個 Gemini MR 都由 Claude 審查(`docs/reviews/YYYY-MM-DD-ts-<批>.md` 或 MR 評論,只提問題、不改你的分支);compose / env 範本 / `gateway-rbac.yaml` / CI 屬敏感變更,MR 描述要寫審查者與紀錄位置。
6. 計畫 MR !161 由需求方合併後,從 `origin/develop` 開分支。
7. Q2:畫面可選 **7 / 30 / 90 天,預設 30**;API `days` 只接受這三個值。
8. Q3:版本歷史保留 **90 份**,存差異,不存每版完整清單。
9. Q5:規則覆蓋第一版**只看有沒有掛**弱點防護 / 間諜軟體 profile。
10. Q7:Threat Vault 由 `netops-pa` 收集器呼叫,`netops-api` 不出外網,Key 用 `*_FILE`。
11. Q8:命中比對的 IP / 名稱要有 **Log 明細權限**才顯示;只有 `netops.pa-signature.read` 只看筆數與動作分布(後端依權限決定回不回 IP,不只靠前端隱藏)。
12. Q9:`read` 給 `netops-admin`、`netops-viewer`;`refresh` 只給 `netops-admin`。
13. Q1:不適用;`show predefined` 可用,走計畫書 §4 原設計(每 30 分鐘只讀 `show system info`,`threat-version` 變了 / 手動 / 沒快照才讀全清單)。
14. **基準**:第一次讀到的清單當基準,**不算新增**;之後每次內容版本更新才算新增 / 變更 / 停用。畫面選 30 / 90 天而歷史不足時,標示「自 YYYY-MM-DD 起統計」(基準日)。官方發布日等 TS-5 Threat Vault 再補。
15. Q4:AV / WildFire 第一版**只顯示版本與發布時間**(`show system info` 的 `av-version`、`av-release-date`、`wildfire-version`、`wildfire-release-date`),不讀清單。
16. 抽屜:快照沒有的 ID 可按需查 `show threat id <ID>`(回 description / subtype / severity),**經收集器、限流**,`netops-api` 不碰 PA(計畫書 §2.3、§5.4)。
17. 未定(計畫書 §9):Q6、Q10 上線前決定。碰到這些或計畫書沒寫的事**停下回報**,不要自己決定。

## 規則

- **D22 只讀**:只送唯讀 op 指令,白名單完全比對;不送 `type=config`、不 Commit、不寫 PA。`netops-api` 不連 PA。
- **D20**:不用關聯式資料庫;版本歷史經 `infra/store`,即時資料經 Redis。
- **AGENT §7.2**:ClickHouse、Redis、檔案只經 `infra/clickhouse`、`infra/redis`、`infra/store` 的具名函式;ClickHouse 條件一律 `query_params`,`netops-api` 用唯讀帳號。
- **D6 逾時**:一般 API ≤ 10 秒(最長 60 秒),可能超過的查詢改「送出工作 → 查詢結果」;外部依賴(Redis / ClickHouse)失敗不回 5xx(避免 BFF 斷路器累積),回明確 `NETOPS_PA_SIGNATURE_*` 代碼。
- **AI 只送統計**(AGENT §7.4):不送 IP、姓名、原始 log;單元測試要驗證送出內容。
- **機密**:Key 只用 `*_FILE`;不寫進程式、文件、MR、日誌;不讀 `.env` 與機密檔。
- **AGENT §5**:失敗就標失敗;空清單 / 解析失敗保留上一份快照;查不到資料不可回看起來正常的空結果。
- API 規則照 AGENT §8:`operationId`、`summary`、`description`、`x-permission`、`x-gherkin` 必填;含 IP 的回應 `x-audit-level: meta`。
- 不推 `develop` / `main`、不 force push;不寫測試區(不改主機上的 env、不重啟容器、不開 `PA_SIGNATURE_ENABLED`)。
- **功能 MR 不改** `docs/API.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`;改在 MR 描述列「要寫進文件的變更」。
- 測試失敗**不得**刪除、放寬、跳過測試或調整門檻;修程式本身可以,修不好就寫進測試報告。
- 合併 / rebase 遇衝突立即停下,依 `../AGENT.md` §9.3 列影響,不自己解。
- 遇到需求方要決定的事(計畫書沒寫、規則衝突、§9 未定項目)**停下回報**,不要猜。

## 完成標準(每批)

1. 依動到的部分執行並通過:
   - `pa-collector/`:`python -m pytest`、`ruff check .`
   - `backend/`:`npm run typecheck`、`npm test`、`npm run test:int`
   - `frontend/`:`npm run typecheck`、`npm test`、`npm run build`
2. 測試報告 `docs/test-reports/YYYY-MM-DD-ts-<批>.md`(環境、結果、失敗項目、可能問題、建議)。
3. MR 描述:做了什麼、測試結果、影響範圍(API、權限代碼、Redis 鍵、`.env` 設定、CI)、依賴順序、「要寫進文件的變更」;有敏感檔案時寫「審查者:Claude,紀錄:`docs/reviews/…` 或 MR 評論」。
4. 開 MR 後**通知需求方請 Claude 審查**;審查意見處理完再請需求方合併。
