# GigaNexus 資訊網通管理系統(NetOps)— AI 協作準則(AGENT.md)

> 本文件是 AI 程式助手(Claude、Gemini 等)在本專案中的行為準則,所有 AI 協作開發必須遵守。
> Gateway 的規格(`../giga-api-gateway-bff/docs/`)是上位規範;本文件與之不一致時,**先指出差異,不要自行決定以哪一邊為準**。
> 本專案的設計決策(D1–D33)以 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** 為準,工作項目(D0–D2、S0、A1、R0–R2、C0–C6)見 **[docs/IMPL-PLAN.md](docs/IMPL-PLAN.md)**;跨專案規則見 `../giga-api-gateway-bff/AGENT.md` **§10 多專案工作區**。

---

## AI 分工(Claude / Gemini)— 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.8(有出入時以該節為準)。

**Claude** 負責前後端,著重在邏輯、框架、架構規劃與寫計畫:後端全部、前端的邏輯層、測試、技術文件。**Gemini** 負責前端的頁面與元件、寫需求企劃,以及執行測試、撰寫測試報告。Gemini 開始動手前,先確認工作在下表 Gemini 欄是 ✅。

| 工作 | Claude | Gemini |
| --- | --- | --- |
| 後端程式(API、業務邏輯、權限、資料存取、排程、修 bug、重構) | ✅ | ❌ |
| 前端邏輯層:`composables/`(狀態與邏輯)、`api/`(HTTP)、store、路由與路由守衛、權限判斷、`@giganexus/*` 共用套件 | ✅ | ❌ |
| 前端頁面與元件:`pages/`、`components/` / `ui/` 的畫面組合、版面、樣式、互動、文案、mock / 假資料 | ✅ | ✅ |
| 架構與框架:新模組、目錄慣例、選用套件、共用元件與 composable 的介面設計 | ✅ | ❌ |
| 寫計畫與技術文件:`ARCHITECTURE.md`、`IMPL-PLAN.md`、`HANDOFF.md`、`PROJECT-MAP.md`、`AGENT.md`、`README.md`、架構 JSON、修正紀錄 | ✅ | ❌ |
| 寫需求企劃:`docs/PRD.md`、功能企劃、`docs/Gherkin/*.feature` 驗收場景 | ✅ | ✅ |
| 後端測試、前端邏輯層測試、整合 / E2E 測試、測試用 fixture 的邏輯 | ✅ | ❌ |
| 前端元件測試(Gemini 負責的頁面 / 元件) | ✅ | ✅ |
| 執行測試(既有的 `npm test`、`test:int`、E2E 等)並撰寫測試報告 | ✅ | ✅ |
| CI/CD 與容器、部署設定 | ✅ | ❌ **禁止** |

**Gemini 寫前端頁面與元件**:

- 資料與狀態一律用既有的 `composables/`、`api/`;頁面不直接 `fetch`、不自己寫權限判斷(Gateway `AGENT.md` §10.7.2)。需要新的 API 呼叫、狀態、權限代碼或路由時,寫在 MR 說明交給 Claude。
- 權限代碼、路由、錯誤代碼以 Gateway `docs/` 為準,不自創。
- 新增頁面或元件時,可在 `docs/PROJECT-MAP.md` 補上該頁面 / 元件那一行;其他段落由 Claude 維護。

**Gemini 寫需求企劃**:只描述需求、畫面與驗收行為。API 介面、權限代碼、錯誤代碼、資料表屬技術設計,企劃中需要時列為「待決事項」交給 Claude,不直接定案。

**Gemini 禁止修改**(即使只改一行):

- CI/CD:`.gitlab-ci.yml`、`ci-templates/`、Runner 設定。
- 容器與部署:`Dockerfile*`、`docker-compose*`、`.dockerignore`、`deploy/`、`nginx/`、部署腳本、`.env*`、`Web.config` / 發佈設定。
- 相依與建置設定:`package.json`(含 scripts)、lock 檔、`tsconfig*.json`、`vite.config.*`。
- 資料庫:schema、migration、seed。
- 後端程式與前端邏輯層(見上表)。
- 測試:只能新增 / 修改自己負責頁面的元件測試。測試失敗時**不得**為了讓測試通過而修改測試或程式、跳過測試、調整門檻;把失敗寫進報告,交給 Claude 處理。

**測試報告**(Gemini 執行測試後必寫):

- 位置:`docs/test-reports/YYYY-MM-DD-<主題>.md`。
- 內容:1. 環境(分支 / commit、部署區、執行的指令)2. 結果(通過 / 失敗 / 略過數量)3. 失敗項目(測試名稱、錯誤訊息摘錄)4. **可能問題**:推測原因、相關檔案與行號、重現步驟、影響範圍 5. 建議交給 Claude 處理的項目。
- 測試全部通過也要寫,並列出觀察到的潛在風險(警告訊息、偶發失敗、執行過慢等)。

**判斷不了屬於頁面 / 元件還是邏輯時,一律視為邏輯**:不動程式,寫進 MR 說明或報告交給 Claude。

---

## 找程式碼:CodeGraph 優先 — 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.7(有出入時以該節為準)。

- repo 根目錄有 `.codegraph/`(CodeGraph 索引)時,找檔案、符號、呼叫關係與修改的影響範圍**先用 CodeGraph**:Claude Code 用 MCP 工具 `codegraph_explore`;其他 AI 或人在 repo 根目錄執行 `codegraph explore "<符號名稱或問題>"`。
- CodeGraph 找不到(剛新增尚未索引的檔案、設定檔與文件不在索引內),或要看目錄職責與「要改 X → 看哪裡」時,再看 `docs/PROJECT-MAP.md`。
- 沒有 `.codegraph/` 時直接看專案地圖;是否建立索引由使用者決定。`.codegraph/` 是本機索引,不進版控(列在 `.gitignore`)。

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
- 開發在工作分支(`feature/*`、`fix/*`、`docs/*`、`refactor/*`),從最新的 `origin/develop` 開。開工第一步 `git fetch` 並回報落後基準分支幾個 commit。
- 只推送工作分支;`develop`、`main` **只透過 GitLab Merge Request 由 Maintainer 合併**。AI 不得推送 `develop` / `main`、不得 force push。
- **切換前 `main` 維持舊 IIS 版本**(ARCHITECTURE D12):接入 Gateway 的程式只進 `develop`;舊版緊急修正進 `main` 後,再合回 `develop`。
- 合併遇到衝突時 AI 立即停止,依 `../AGENT.md` §9.3 列出影響,不自行解衝突。
- 提交前確認 diff 只含本次任務的檔案,不提交 `.env*` 與任何機密;提交訊息用 `<type>(<scope>): <中文說明>`。

---

## 0. 專案定位(先讀)

| 項目 | 內容 |
| --- | --- |
| 做什麼 | 資訊網通管理系統:PA-560 防火牆 log(流量總覽、安全事件、明細查詢、**即時監控**)、AD 事件記錄、網通知識庫、AI 分析與問答。2026-11-04 取消 AI 中控台:**AI 搬進新版**(A1,D23);PA 即時監控用 pan-os-python + Redis(R1,D19);不寫關聯式資料庫(D20)。**2026-11-10 核准 PA log 寫 ClickHouse**(C0–C6,D27–D33):TRAFFIC 與威脅類原始 log 存 NetOps 自有的 `netops-clickhouse`,冷資料歸檔 NAS。細節見 `docs/PA-LIVE-PLAN.md`、`docs/PA-LOG-CLICKHOUSE-GUIDE.md` |
| 狀態 | **D1 已上測試區**(`backend/`、`frontend/` 經 Gateway);舊版根目錄 `server/`、`src/` 仍在 IIS `/NetOps` 運作。進度看 `docs/HANDOFF.md` |
| 系統代碼 / SPA 子路徑 | `netops` / `/netops/` |
| 服務代碼 / port | `netops-api` / **51292**(Gateway BACKEND-GUIDE §3.3 登記中,不可自行換 port) |
| API | 對外 `/api/netops/*`,後端 `/v1/*` |
| 登入 | **後端不實作登入**,只信任 Gateway 的 `X-Internal-Token`;前端用 `@giganexus/web-kit`,未登入導向入口網 `/login`(§7.1) |
| 資料 | 摘要、統計、知識庫存檔案,經 `infra/store` 存取;即時資料存 `netops-redis`(TRAFFIC 明細 1 小時 / 統計 1 天,其他 2 天);PA TRAFFIC 與威脅類原始 log 存 `netops-clickhouse`(TRAFFIC 30 天、威脅類 90 天),只經 `infra/clickhouse` 存取;**其他資料不寫入資料庫**(§7.2、ARCHITECTURE D20、D21、D27) |
| 外部相依 | FTP `10.10.130.66`(log 來源,唯讀);AI 主機 `10.10.130.46`(`:8080` 模型 `Qwen3.6-35B-A3B-FP8`、`:8081` embedding;`10.10.130.45` 配置相同作為備用)、Qdrant;PA-560 管理介面(R1,SDK 唯讀) |
| 負責人 | 佳緯 |
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
- **不寫入關聯式資料庫**(D20):只保留 `infra/store`、`infra/redis`、`infra/clickhouse` 邊界,不做通用 ORM 或多後端切換框架。唯一的例外是 PA log 的 ClickHouse(D27,2026-11-10 核准):只寫 TRAFFIC 與威脅類,SQL 直接寫在 `infra/clickhouse`,不加 ORM。
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
- 不要刪除或放寬失敗的測試來讓測試通過。

---

## 6. 部署區與設定

| 項目 | `dev`(本機開發) | `test`(測試區,主機 2) | `prod`(正式區,主機 3) |
| --- | --- | --- | --- |
| `GW_ENV` | `dev` | `test` | `prod` |
| 自動註冊 API | 不註冊 | 註冊為 Gateway **草稿** | 註冊為 Gateway **草稿** |
| 機密 | 可由 `.env` 給值 | `*_FILE`(Docker secret) | **只接受** `*_FILE` |
| 資料目錄 | 本機暫存目錄 | `/srv/giga-netops/test` | `/srv/giga-netops/prod` |
| FTP 同時連線 | 1 | 1 | 2 |

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
- 前端不存 Token(`localStorage`、`sessionStorage`、Pinia 持久化都不行),不自行解析 JWT;偏好設定(明暗、風格等)可以存 `localStorage`。
- 前端按鈕依權限隱藏只是體驗,不是安全機制。

### 7.2 資料存取(D8)

- **核心邏輯不直接讀寫資料檔**:一律經 `backend/src/infra/store/` 的具名函式(例如 `saveSummary`、`listSummaries`),不在 `modules/` 內組資料目錄路徑。
- API 回應不暴露實體路徑、檔案結構或 Redis 鍵,換儲存時 API 不變。
- 匯入流程與資料寫入分開:解析、彙總是純函式,寫入只呼叫 store。
- **原始 log 不存本機檔案、不進資料庫**,只存摘要與統計。例外(保留時間或範圍要改,先由需求方決定):
  - PA 即時 log 存進 `netops-redis`,**TRAFFIC 明細 1 小時、統計 1 天;其他類型 2 天**(2026-11-04 決定,ARCHITECTURE D21)。
  - **PA TRAFFIC 與威脅類(threat、url、data、wildfire)原始 log 存進 `netops-clickhouse`**:原始 TRAFFIC 30 天、威脅類 90 天、每小時彙總 13 個月、來源 IP 彙總 90 天;測試區 TTL 2–3 天只驗功能(需求方 2026-11-10 核准,ARCHITECTURE D27、手冊 `docs/PA-LOG-CLICKHOUSE-GUIDE.md` §12 CQ1、CQ2、CQ12)。decryption、globalprotect、userid 不進 ClickHouse。
  - **冷資料 Parquet 歸檔**到 NAS `/mnt/nas-docker/giga-netops/{env}/pa-archive/YYYY/`,只經 `netops-ingest` 寫入(D30);歸檔原始 log 還是只歸檔彙總,依 FTP 保留期限決定(CQ3,待確認)。
- **不寫入關聯式資料庫**(D20):即時用 Redis,PA log 歷史用 ClickHouse(D27、D29),FTP 降為補漏與對帳(D33)。要再引入其他資料庫或擴大 ClickHouse 的範圍,先由需求方決定並改 ARCHITECTURE。
- **轉送欄位例外**:PA log 欄位沿用舊版已在用的欄位,不新增;**例外是 `seqno`、`sessionid`**(補漏去重用,2026-11-10 核准,D28 / CQ9)。
- ClickHouse 只經 `infra/clickhouse` 的具名函式存取:查詢條件一律用 `query_params`,表名只用程式內常數;`netops-api` 用唯讀帳號,寫入與歸檔用 `netops-ingest` 的帳號(手冊 §10.2)。
- Redis 只經 `infra/redis` 的具名函式讀取,模組不自行組鍵;`netops-pa` 寫入的鍵格式見 `docs/PA-LIVE-PLAN.md` §4。

### 7.3 長時間工作(D6)

- 一般 API 不得超過路由逾時(預設 10 秒,最長 60 秒);超過一律改成「送出工作 → 查詢結果」,不延長逾時繞過。逾時會累積 BFF 斷路器失敗,影響整個 `netops-api`。
- **SSE 串流例外**(S0):連線可以一直開著,因為 BFF 的逾時是資料塊之間的閒置時間;條件是立即送出第一個事件、心跳間隔小於 `x-timeout-ms`(設 60000)、回 `X-Accel-Buffering: no`。細節見 `docs/API.md` §3.1。
- 工作只有建立者本人可查(比對 `emp`);有筆數與秒數上限;程序重啟後可失效,但要回明確錯誤。
- 背景同步在程序內執行,**只跑單一容器**;不要加多實例。

### 7.4 外部來源與 AI

- **FTP 唯讀**:不刪除、不改名、不上傳;「刪除分析結果」只刪本系統資料。掃描逐列串流,不整檔讀進記憶體。
- **AI 搬進新版**(A1,D23,2026-11-04 取代 D17):`routes/ai.js`、`lib/evidence.js`、`lib/llm.js`、`lib/vector.js`、`lib/iplearn.js` 依 D4 先補測試基準再搬;模型與 embedding 只經 `infra/` 呼叫,主機位址只從設定讀(`LLM_URL`、`EMBED_URL`),不寫死。只送統計與彙整結果給模型,不送原始 log 檔。
- **PA-560 第一版只讀**(D22):SDK 只執行 operational 查詢;封鎖 IP、DAG 標籤、設定變更排在 R2,未經使用者同意不實作寫入防火牆的程式。
- 知識庫內容輸出前端時一律經 DOMPurify。
- 不刪除或覆寫正式知識庫。

### 7.5 機密

- 帳密與金鑰(FTP、Gateway API Key、監控 Key)**不入版控、不寫進映像檔、不貼進對話或日誌**;正式環境以 `<NAME>_FILE` 指向 Docker secret。
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
| 稽核 | Log 明細、匯出設 `x-audit-level: meta` |
| 錯誤 | `{ code, message, requestId, details? }`;自訂代碼以 **`NETOPS_`** 開頭,不可使用 Gateway 專用代碼;不回傳堆疊或內部路徑 |
| 時間 | ISO 8601 含時區;舊版本地時間字串的 `json replacer` 不沿用 |
| 冪等 | `GET` / `PUT` / `DELETE` 必須冪等 |
| 分頁 | `page`、`pageSize`(上限 100),回應 `{ items, total, page, pageSize }` |
| 標頭 | 不回 `Set-Cookie`、CORS、`Server`、`X-Powered-By` |
| 日誌 / 監控 | 寫入 `X-Request-Id`;以 `setupGateway` 接 giga-observe;遮罩 password、token、secret、key |

### 前端

依 FRONTEND-GUIDE:`base: '/netops/'`、History 模式、`createWebKit({ router })`、路由 `meta.permission`、應用層守衛、應用切換;API 寫在 `api/`,頁面不直接 `fetch`;不寫死 `/` 開頭的資源路徑。

---

## 9. 專案慣例

| 項目 | 規範 |
| --- | --- |
| 後端 | TypeScript(ESM、`strict`)+ Fastify 5;Gateway 共用功能用 `@giganexus/backend-sdk`。既有核心 JS 以 `allowJs` 沿用,動到再逐步轉型 |
| 前端 | Vue 3 + Vite + TypeScript + `src/ui/` 全域元件,比照入口網與 GigaItApp,視覺只換主題色(`docs/UI-GUIDE.md`,ARCHITECTURE D5);舊畫面在 F1 改寫前仍是 Element Plus + Tailwind |
| 命名 | 變數 / 函式 `camelCase`,型別 `PascalCase`,常數 `UPPER_SNAKE_CASE`,後端檔名 `kebab-case` |
| 註解語言 | 繁體中文,必要時註明規格章節 |
| 測試資料 | 用假 log、暫存目錄與假 FTP;不對正式 FTP、知識庫做寫入測試;不在瀏覽器輸入真實帳密 |

### 專案地圖與設計原則

- **`docs/PROJECT-MAP.md`**:開發新功能、搬移目錄或主要檔案、新增對外介面時,在同一個變更內更新,並更新「最後更新」。
- 核心設計原則依 Gateway `AGENT.md` §10.7.2:

| 原則 | 本專案做法 |
| --- | --- |
| 程式目錄 | 前後端各放子目錄 `frontend/`、`backend/`;repo 根目錄只放文件、`deploy/` 與 CI |
| 職責分離 | `modules/<功能>/routes.ts` 只做驗證、權限宣告與格式轉換;解析、彙總、研判放模組核心,不依賴 Fastify;FTP、store、jobs 放 `infra/` |
| 原始碼根目錄 | `backend/src/`、`frontend/src/`;建置輸出不進版控 |
| 集中測試 | `backend/test/{unit,integration}/`、`frontend/test/`,與 `src/` 平行 |

既有程式與原則不同之處列在專案地圖「已知差異」。

---

## 10. 參考文件

| 文件 | 路徑 | 說明 |
| --- | --- | --- |
| 架構與決策 | `docs/ARCHITECTURE.md` | 目標架構、決策 D1–D33、權限草案、待確認事項 |
| 流程架構 | `docs/FLOW-ARCHITECTURE.md` | 資料與 AI 流程:現況、過渡期、未來目標 |
| 實作計畫 | `docs/IMPL-PLAN.md` | D0–D2、S0、A1、R0–R2、C0–C6 工作項目與完成條件 |
| PA log 高吞吐架構 | `docs/PA-LOG-CLICKHOUSE-GUIDE.md` | ClickHouse、Parquet 冷歸檔、PA 精準查詢(2026-11-10 核准) |
| PA 即時監控與 AI 搬移 | `docs/PA-LIVE-PLAN.md` | pan-os-python、Redis、串流、AI 主機(2026-11-04 規劃) |
| 專案地圖 | `docs/PROJECT-MAP.md` | 目錄與職責、已知差異 |
| 交接 | `docs/HANDOFF.md` | 目前進度與下一步 |
| 功能現況 | `README.md` | 舊版頁面、資料流程與設定(切換前仍有效) |
| Gateway 開發手冊 | `../giga-api-gateway-bff/AGENT.md` | §10 多專案工作區 |
| 後端 / 前端規範 | `../giga-api-gateway-bff/docs/BACKEND-GUIDE.md`、`FRONTEND-GUIDE.md` | 接入規範 |
| 後端樣本 | `../giga-api-gateway-bff/samples/node-backend/` | Fastify + SDK 範本 |
| UI 規範 | `docs/UI-GUIDE.md` | 本專案差異:框架來源、主題色、舊畫面對應 |
| 前端範本 | `../giga-Portal/docs/UI-GUIDE.md`、`../GigaItApp/docs/UI-GUIDE.md`、`../GigaItApp/deploy/gateway-rbac.yaml` | 外觀、元件與畫面權限 |
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
