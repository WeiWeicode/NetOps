# GigaNexus 資訊網通管理系統(NetOps)— AI 協作準則(AGENT.md)

> 本文件是 AI 程式助手(Claude、Gemini 等)在本專案中的行為準則,所有 AI 協作開發必須遵守。
> Gateway 的規格(`../giga-api-gateway-bff/docs/`)是上位規範;本文件與之不一致時,**先指出差異,不要自行決定以哪一邊為準**。
> 本專案的設計決策(D1–D12)以 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** 為準,工作項目(D0–D2)見 **[docs/IMPL-PLAN.md](docs/IMPL-PLAN.md)**;跨專案規則見 `../giga-api-gateway-bff/AGENT.md` **§10 多專案工作區**。

---

## AI 分工(Claude / Gemini)— 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.8(有出入時以該節為準)。

寫程式、寫測試、寫文件由 **Claude** 負責;**Gemini** 只負責執行測試、撰寫測試報告,以及非邏輯性的修改。Gemini 開始動手前,先確認工作在下表 Gemini 欄是 ✅。

| 工作 | Claude | Gemini |
| --- | --- | --- |
| 寫程式(新功能、業務邏輯、API、權限、資料存取、狀態管理、修 bug、重構) | ✅ | ❌ |
| 寫測試(單元 / 整合 / E2E 測試碼、測試用 fixture 的邏輯) | ✅ | ❌ |
| 寫文件(`AGENT.md`、`README.md`、`docs/`、`PROJECT-MAP.md`、架構 JSON、修正紀錄) | ✅ | ❌(測試報告除外) |
| 執行測試(既有的 `npm test`、`test:int`、E2E 等)並撰寫測試報告 | ✅ | ✅ |
| 非邏輯性修改:前端 mock / 假資料、版面與樣式(CSS、間距、顏色、排版)、畫面文案錯字 | ✅ | ✅ |
| CI/CD 與容器、部署設定 | ✅ | ❌ **禁止** |

**Gemini 禁止修改**(即使只改一行):

- CI/CD:`.gitlab-ci.yml`、`ci-templates/`、Runner 設定。
- 容器與部署:`Dockerfile*`、`docker-compose*`、`.dockerignore`、`deploy/`、`nginx/`、部署腳本、`.env*`、`Web.config` / 發佈設定。
- 相依與建置設定:`package.json`(含 scripts)、lock 檔、`tsconfig*.json`、`vite.config.*`。
- 資料庫:schema、migration、seed。
- 測試程式碼:測試失敗時**不得**為了讓測試通過而修改測試或程式、跳過測試、調整門檻;把失敗寫進報告,交給 Claude 處理。

**測試報告**(Gemini 執行測試後必寫):

- 位置:`docs/test-reports/YYYY-MM-DD-<主題>.md`。
- 內容:1. 環境(分支 / commit、部署區、執行的指令)2. 結果(通過 / 失敗 / 略過數量)3. 失敗項目(測試名稱、錯誤訊息摘錄)4. **可能問題**:推測原因、相關檔案與行號、重現步驟、影響範圍 5. 建議交給 Claude 處理的項目。
- 測試全部通過也要寫,並列出觀察到的潛在風險(警告訊息、偶發失敗、執行過慢等)。

**判斷不了是否屬於「非邏輯性」時,一律視為邏輯修改**:不動程式,寫進報告交給 Claude。

---

## Claude 子代理 — 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.9(有出入時以該節為準)。**只適用 Claude Code**,Gemini 等其他 AI 略過本節。

子代理定義放在**使用者層級** `~/.claude/agents/`,所有專案共用;範本在 `../giga-api-gateway-bff/docs/claude-agents/`。

| 子代理 | 用途 | 模型 | 權限 |
| --- | --- | --- | --- |
| `explore` | 快速搜尋、分析大型程式碼庫結構 | `haiku` | 唯讀 |
| `code-reviewer` | 檢查程式碼品質、命名與最佳實踐 | `sonnet` | 唯讀 |
| `security-auditor` | 偵測安全漏洞(硬編碼密鑰、注入、權限缺漏、不安全的 API) | `opus` | 唯讀 |
| `debugger` | 追蹤錯誤日誌,做根本原因分析 | `sonnet` | 唯讀 |
| `test-runner` | 執行既有測試並分析覆蓋率 | `haiku` | 唯讀(只執行指令,不改檔) |
| `refactor-assistant` | 安全地重構與拆分模組 | `sonnet` | 可修改檔案 |

**開工前檢查**(每個工作階段一次):確認 `~/.claude/agents/` 有上表 6 個檔案;缺少時先列出並詢問使用者是否建立,未經同意不要建立,已存在的同名檔不覆蓋。

**本專案何時必用**:

| 情境 | 子代理 |
| --- | --- |
| 動到內部 Token 驗證、權限、機密與 `.env*`、對外 API、Log 明細與匯出、知識庫內容輸出、部署設定 | `security-auditor`(可與 `code-reviewer` 同時進行) |
| 一批修改完成、commit 前 | `code-reviewer` |
| 搬移 `server/lib/` 既有核心邏輯 | `refactor-assistant`(先建立測試基準) |
| 修改後跑 lint / 型別檢查 / 測試 | `test-runner` |

子代理的結果由主對話**檢查後**才採用或回報;子代理不經手密碼與機密值。

---

## Git 分支與推送 — 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.10 與工作區 `../AGENT.md` §9(有出入時以 §10.10 為準)。

- 本 repo 的 GitLab remote 是 `origin`(`giganexus/NetOps`);下指令前仍先看 `git remote -v`。
- 開發在工作分支(`feature/*`、`fix/*`、`docs/*`、`refactor/*`),從最新的 `origin/develop` 開;`develop` 建立前從 `origin/main` 開。開工第一步 `git fetch` 並回報落後基準分支幾個 commit。
- 只推送工作分支;`develop`、`main` **只透過 GitLab Merge Request 由 Maintainer 合併**。AI 不得推送 `develop` / `main`、不得 force push。
- **切換前 `main` 維持舊 IIS 版本**(ARCHITECTURE D12):接入 Gateway 的程式只進 `develop`;舊版緊急修正進 `main` 後,再合回 `develop`。
- 合併遇到衝突時 AI 立即停止,依 `../AGENT.md` §9.3 列出影響,不自行解衝突。
- 提交前確認 diff 只含本次任務的檔案,不提交 `.env*` 與任何機密;提交訊息用 `<type>(<scope>): <中文說明>`。

---

## 0. 專案定位(先讀)

| 項目 | 內容 |
| --- | --- |
| 做什麼 | 資訊網通管理系統:PA-560 防火牆 log(流量總覽、安全事件、明細查詢)、AD 事件記錄、AI 問答與分析、網通知識庫(含向量搜尋、外部 IP 自動學習) |
| 狀態 | **D0 規劃中**。目前程式仍是舊架構:根目錄 `server/`(Express + 自建登入)、`src/`(Vue),部署於 IIS `/NetOps`;尚未接入 Gateway |
| 系統代碼 / SPA 子路徑 | `netops` / `/netops/` |
| 服務代碼 / port | `netops-api` / **51292**(Gateway BACKEND-GUIDE §3.3 登記中,不可自行換 port) |
| API | 對外 `/api/netops/*`,後端 `/v1/*` |
| 登入 | **後端不實作登入**,只信任 Gateway 的 `X-Internal-Token`;前端用 `@giganexus/web-kit`,未登入導向入口網 `/login`(§7.1) |
| 資料 | 第一版存檔案,經 `infra/store` 存取,**未來規劃改由服務直接寫入資料庫**(§7.2、ARCHITECTURE D8) |
| 外部相依 | FTP `10.10.130.66`(log 來源,唯讀)、vLLM `10.10.130.45`、Qdrant `10.10.130.46` |
| 負責人 | **待確認**(目前 commit 作者為 eric);確認前跨人修改依 Gateway `AGENT.md` §10.5 |
| 工作區 | 與 `../giga-api-gateway-bff/`(上位規範、SDK、web-kit、路由表)、`../GigaItApp/`(權限設定、畫面範本)、`../giga-observe/`(監控)同層 |
| 上位規範 | 前端 `../giga-api-gateway-bff/docs/FRONTEND-GUIDE.md`;後端 `../giga-api-gateway-bff/docs/BACKEND-GUIDE.md` |
| 專案地圖 | `docs/PROJECT-MAP.md`;**開發新功能後必須更新**(§9) |

---

## 1. 先思考再動手

- **動手之前,先說明你的理解與假設**:用 1–3 句話摘要打算做什麼、為什麼這樣做。
- **有疑問先問,不要猜**;需求有多種解讀時,列出選項讓人類選擇。ARCHITECTURE「待確認事項」**未定案前不要自行決定**。
- 程式與規格不一致時先指出差異。

## 2. 簡單優先

- 用最少的程式碼解決當前問題,不寫「未來可能用到」的程式碼。
- **資料庫是未來階段**:現在只保留 `infra/store` 邊界,不要先寫資料庫實作、不要做通用 ORM 或多後端切換框架。
- 新增套件前先說明理由(Gateway `docs/TECH-STACK.md` 已列的優先)。

## 3. 外科手術式修改

- **只改必須改的地方**;不順手整理、重構、改名不相關的程式碼。
- 搬移 `server/lib/` 時**不順便改研判邏輯**;搬移與行為變更分開提交,用同一批樣本確認摘要結果不變(`SUMMARY_VERSION` 不動)。
- 修改 Gateway 專案(`nginx/`、`docs/`)只動必要的幾行,在 Gateway 的 `docs/DevelopmentProcess/` 留紀錄;其他 repo 先說明並取得同意。

## 4. 目標導向執行

- 先定義成功標準,**對應 IMPL-PLAN 的工作項目與完成條件**,自己迭代到達成為止;遇到阻塞(缺資訊、權限不足、缺帳密)才停下來回報。
- 行為變更時同步更新:`docs/API.md` → OpenAPI `x-gherkin` → 測試。
- 完成工作項目後依工作區慣例更新 NexusPlan 甘特圖;文件本身不列排程日期。

## 5. 失敗要明確說

- **失敗就說失敗**,不把靜默跳過包裝成完成;附上錯誤訊息與 `requestId`。
- **查無紀錄不等於沒有發生**:FTP 連不上、掃描逾時、檔案尚未分析時,回應與 AI 內容都要明確標示資料不完整,不可回傳看起來正常的空結果。
- AI 回答只能根據附上的資料;連不到 Qdrant 降級為關鍵字比對時要記 log。
- 不要刪除或放寬失敗的測試來讓測試通過。

---

## 6. 部署區與設定

| 項目 | `dev`(本機開發) | `test`(測試區,主機 2) | `prod`(正式區,主機 3) |
| --- | --- | --- | --- |
| `GW_ENV` | `dev` | `test` | `prod` |
| 自動註冊 API | 不註冊 | 註冊為 Gateway **草稿** | 註冊為 Gateway **草稿** |
| 機密 | 可由 `.env` 給值 | `*_FILE`(Docker secret) | **只接受** `*_FILE` |
| 資料目錄 | 本機暫存目錄 | `/srv/giga-netops/test` | `/srv/giga-netops/prod` |
| Qdrant collection | 測試專用 | `NetOpsKb_test` | `NetOpsKb` |
| FTP 同時連線 | 1 | 1 | 2 |
| 外部 IP 自動學習 | 關閉 | 手動 | 確認對外連線後才開啟(D10) |

- 部署區只有這三個值。缺少必要設定時**啟動失敗**,不要加預設值繞過檢查(例如舊版的 `JWT_SECRET='change-me'` 不可重現)。
- 部署沿用 Gateway 的 GitLab 流程(`../giga-api-gateway-bff/docs/DEPLOYMENT.md`):`develop` → 主機 2 測試區;`main` → 主機 2 建置推送 Registry、主機 3 手動部署。主機 3 WSL 查不到外部 DNS,不能在主機上建置。
- 資料目錄放 WSL 檔案系統,不放 `/mnt/c`。
- 主機連線見 `../AGENT.md` §5;需要 root 或含機密的指令請本人執行。

---

## 7. NetOps 專屬規則

### 7.1 登入與權限

- **不實作登入、不發 Token、不讀 Cookie**;舊的 AD 驗證、`JWT_*`、`SyncLogin`、`VIEW_USERS`、`VIEW_DEPTS`、`KB_ADMINS` 不再使用,不要保留相容路徑。
- 身分只從 `X-Internal-Token`(`req.identity`)取得,**dev 也不略過驗證**,除非明確設定 `DEV_SKIP_TOKEN=1` 直連本機。
- API 層權限由 BFF 依 `x-permission` 檢查,後端不重複實作;作者欄位等使用 `emp` + `name`。
- 這些 log 不分公司或部門,第一版不依 `cos` 過濾;若之後要分範圍,先改 ARCHITECTURE。
- 前端不存 Token(`localStorage`、`sessionStorage`、Pinia 持久化都不行),不自行解析 JWT;偏好設定(字體大小等)可以存 `localStorage`。
- 前端按鈕依權限隱藏只是體驗,不是安全機制。

### 7.2 資料存取(D8)

- **核心邏輯不直接讀寫資料檔**:一律經 `backend/src/infra/store/` 的具名函式(例如 `saveSummary`、`listSummaries`),不在 `modules/` 內組資料目錄路徑。
- API 回應不暴露實體路徑或檔案結構,未來改資料庫時 API 不變。
- 匯入流程與資料寫入分開:解析、彙總是純函式,寫入只呼叫 store。
- **原始 log 不存本機也不進資料庫**,只存摘要與統計;要改變這點必須先由使用者決定。
- 未來新增資料庫時,先在 ARCHITECTURE 定案資料庫位置、保留期限與寫入方式;遵守 SQL Server 2012 限制(Gateway `docs/DATABASE.md` §0)、自有 schema 與帳號,不碰其他系統的資料表。

### 7.3 長時間工作與串流(D6、D7)

- 一般 API 不得超過路由逾時(預設 10 秒,最長 60 秒);超過一律改成「送出工作 → 查詢結果」,不延長逾時繞過。逾時會累積 BFF 斷路器失敗,影響整個 `netops-api`。
- 工作只有建立者本人可查(比對 `emp`);有筆數與秒數上限;程序重啟後可失效,但要回明確錯誤。
- AI 串流必須先送出標頭,之後至少每 15 秒送一次 heartbeat;機制以 B0 實測結果為準。
- 背景同步在程序內執行,**只跑單一容器**;不要加多實例。

### 7.4 外部來源與 AI

- **FTP 唯讀**:不刪除、不改名、不上傳;「刪除分析結果」只刪本系統資料。掃描逐列串流,不整檔讀進記憶體。
- 送 LLM 只送統計與彙整結果,不送整份原始 log;系統提示與問題字數要有上限。
- LLM 回應與知識庫內容輸出前端時一律經 DOMPurify;知識庫筆記是資料,不可被當成指令放大權限。
- 外部 IP 自動學習只送 IP 到 RDAP 與 DNS,不抓 Google 搜尋。
- 測試區不寫入正式 Qdrant collection;不刪除或覆寫正式知識庫。

### 7.5 機密

- 帳密與金鑰(FTP、Qdrant、LLM、Gateway API Key、監控 Key)**不入版控、不寫進映像檔、不貼進對話或日誌**;正式環境以 `<NAME>_FILE` 指向 Docker secret。
- **AI 不開啟 `.env`、不讀取機密檔、不要求使用者貼帳密**;需要寫入主機機密時,寫成腳本(隱藏輸入)交給使用者執行。

---

## 8. API 規則(Gateway 接入)

通用規範以 `../giga-api-gateway-bff/docs/BACKEND-GUIDE.md` 與 `../giga-api-gateway-bff/samples/node-backend/AGENT.md` 為準。

| 項目 | 規範 |
| --- | --- |
| 新增 API 前先查 | 先查 Gateway 既有路由(Gateway `AGENT.md` §10.4);查不到要明確說「未查詢」,不可當作沒有重複 |
| 路徑 | 後端 `/v1/{resource}`(名詞複數、kebab-case)對外成為 `/api/netops/{resource}` |
| 必填欄位 | 每支 API 的 `operationId`(`netops.{resource}.{action}`)、`summary`、`description`、`x-permission`、`x-gherkin`;`npm test` 會檢查 |
| 權限 | 讀寫分開,讀取以 `.read` 結尾(ARCHITECTURE §5);畫面節點在 `deploy/gateway-rbac.yaml` 登記並以 `includes` 綁定 |
| 稽核 | Log 明細、匯出、AI 問答設 `x-audit-level: meta` |
| 錯誤 | `{ code, message, requestId, details? }`;自訂代碼以 **`NETOPS_`** 開頭,不可使用 Gateway 專用代碼;不回傳堆疊或內部路徑 |
| 時間 | ISO 8601 含時區;舊版本地時間字串的 `json replacer` 不沿用 |
| 冪等 | `GET` / `PUT` / `DELETE` 必須冪等 |
| 分頁 | `page`、`pageSize`(上限 100),回應 `{ items, total, page, pageSize }` |
| 標頭 | 不回 `Set-Cookie`、CORS、`Server`、`X-Powered-By` |
| 日誌 / 監控 | 寫入 `X-Request-Id`;以 `setupGateway` 接 giga-observe;遮罩 password、token、secret、key |

### 前端

依 FRONTEND-GUIDE:`base: '/netops/'`、History 模式、`createWebKit({ router })`、路由 `meta.permission`、應用層守衛、應用切換;API 寫在 `api/`,頁面不直接 `fetch`(AI 串流封裝於 `api/` 內,同樣帶 CSRF);不寫死 `/` 開頭的資源路徑。

---

## 9. 專案慣例

| 項目 | 規範 |
| --- | --- |
| 後端 | TypeScript(ESM、`strict`)+ Fastify 5;Gateway 共用功能用 `@giganexus/backend-sdk`。既有核心 JS 以 `allowJs` 沿用,動到再逐步轉型 |
| 前端 | Vue 3 + Vite + Element Plus + Tailwind v4,沿用 JavaScript;外框與配色對齊 GigaItApp |
| 命名 | 變數 / 函式 `camelCase`,型別 `PascalCase`,常數 `UPPER_SNAKE_CASE`,後端檔名 `kebab-case` |
| 註解語言 | 繁體中文,必要時註明規格章節 |
| 測試資料 | 用假 log、暫存目錄與假 FTP / LLM;不對正式 FTP、知識庫做寫入測試;不在瀏覽器輸入真實帳密 |

### 專案地圖與設計原則

- **`docs/PROJECT-MAP.md`**:開發新功能、搬移目錄或主要檔案、新增對外介面時,在同一個變更內更新,並更新「最後更新」。
- 核心設計原則依 Gateway `AGENT.md` §10.7.2:

| 原則 | 本專案做法 |
| --- | --- |
| 程式目錄 | 前後端各放子目錄 `frontend/`、`backend/`;repo 根目錄只放文件、`deploy/` 與 CI |
| 職責分離 | `modules/<功能>/routes.ts` 只做驗證、權限宣告與格式轉換;解析、彙總、研判放模組核心,不依賴 Fastify;FTP、LLM、Qdrant、store、jobs 放 `infra/` |
| 原始碼根目錄 | `backend/src/`、`frontend/src/`;建置輸出不進版控 |
| 集中測試 | `backend/test/{unit,integration}/`、`frontend/test/`,與 `src/` 平行 |

既有程式與原則不同之處列在專案地圖「已知差異」。

---

## 10. 參考文件

| 文件 | 路徑 | 說明 |
| --- | --- | --- |
| 架構與決策 | `docs/ARCHITECTURE.md` | 目標架構、決策 D1–D12、權限草案、待確認事項 |
| 實作計畫 | `docs/IMPL-PLAN.md` | D0–D2 工作項目與完成條件 |
| 專案地圖 | `docs/PROJECT-MAP.md` | 目錄與職責、已知差異 |
| 交接 | `docs/HANDOFF.md` | 目前進度與下一步 |
| 功能現況 | `README.md` | 舊版頁面、資料流程與設定(切換前仍有效) |
| Gateway 開發手冊 | `../giga-api-gateway-bff/AGENT.md` | §10 多專案工作區 |
| 後端 / 前端規範 | `../giga-api-gateway-bff/docs/BACKEND-GUIDE.md`、`FRONTEND-GUIDE.md` | 接入規範 |
| 後端樣本 | `../giga-api-gateway-bff/samples/node-backend/` | Fastify + SDK 範本 |
| 前端範本 | `../GigaItApp/deploy/gateway-rbac.yaml`、`../GigaItApp/docs/UI-GUIDE.md` | 畫面權限與外觀 |
| 工作區入口 | `../AGENT.md`、`../PROJECT-MAP.md` | 導航、主機連線、Git 協作 |

---

## 11. 修正紀錄

每次修正都要留紀錄,**新紀錄加在檔案最上方**。

| 文件 | 路徑 | 說明 |
| --- | --- | --- |
| Bug 修改紀錄 | `docs/DevelopmentProcess/BugFix.md` | Bug 修改 |
| 新增功能紀錄 | `docs/DevelopmentProcess/NewFeatures.md` | 新功能與規劃異動 |
| 後端修改紀錄 | `docs/DevelopmentProcess/BackendCorrection.md` | `backend/`、`deploy/` |
| 前端修改紀錄 | `docs/DevelopmentProcess/FrontendCorrection.md` | `frontend/` |

動到其他 repo 時,**在那個 repo** 另留紀錄;每個 repo 各自 commit,訊息註明配合的 repo 與 commit。

### 紀錄格式
```
## YYYY-MM-DD 標題
- 工作項目:D0–D2(無則省略)
- 內容:改了什麼、為什麼
- 檔案:主要修改的檔案
- 驗證:執行的指令與結果
```
