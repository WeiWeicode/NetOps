# NetOps 接入 Gateway 實作計畫

> 工作項目與完成條件;決策見 [ARCHITECTURE.md](ARCHITECTURE.md)。**時程以 NexusPlan 甘特圖為準**,本文件只記狀態。

| 項目 | 內容 | 狀態 |
| --- | --- | --- |
| D0 | 文件與登記 | 完成 |
| B0 | 串流驗證 | 未開始 |
| B1 | 後端骨架 | 未開始 |
| B2 | 模組搬移 | 未開始 |
| F1 | 前端接入 | 未開始 |
| D1 | 測試區部署 | 未開始 |
| D2 | 驗收與切換 | 未開始 |
| 後續 | 服務寫入資料庫 | 未排程(ARCHITECTURE §4.2) |

---

## D0 文件與登記

- NetOps:`AGENT.md`、`CLAUDE.md`、`GEMINI.md`、`.gitattributes`、MR 範本、`docs/`。
- 工作區:`AGENT.md` §3、`PROJECT-MAP.md`、`architecture/workspace.json`、`deployment.json`、甘特圖。
- Gateway:`AGENT.md` §10.2、§10.3,`BACKEND-GUIDE.md` §3.3,`PRD.md` SPA 路徑表。
- 建立 `develop`。

**完成條件**:`npm run arch:check` 通過;架構圖看得到 NetOps;三個 repo 的文件 MR 已合併(NetOps !1、giganexusai !20、giga-api-gateway-bff !18)。

## B0 串流驗證

用最小 Fastify 服務(內部 Token + SSE)部署到測試區,經真實路徑 `瀏覽器 → Nginx → BFF → 服務` 驗證:

1. POST 串流逐段到達,不是最後一次送達。
2. 閒置 55 秒不斷線、超過 60 秒無資料會斷,heartbeat 可維持超過 5 分鐘。
3. 標頭 `X-Accel-Buffering: no` 有經過 BFF 傳到 Nginx;不足時提出 Gateway 修改(跨 repo,先取得同意)。
4. 連線中斷時後端能停止呼叫 LLM。

**完成條件**:D7 定案為串流或輪詢,結果寫回 ARCHITECTURE。

## B1 後端骨架

- `backend/` 由 `samples/node-backend` 複製,`gateway.project = NetOps`、`SERVICE_CODE = netops-api`。
- 內部 Token 驗證、統一錯誤格式、`/healthz`、`/readyz`、`/openapi.json`、`setupGateway`。
- `infra/store`、`infra/jobs`、設定(`*_FILE`、缺少必要設定時啟動失敗)。
- `docs/API.md` 建立舊路徑 → 新路徑對照(39 支,移除 `auth` 3 支與 `jump` 1 支)。

**完成條件**:`npm test` 通過;本機無 Token 回 401;OpenAPI 必填欄位檢查通過。

## B2 模組搬移

順序由低風險到高風險,每個模組先補測試再搬移:

1. `ftp`、`pa`(摘要、總覽、選項)
2. `pa-events`、`ad`
3. `kb`(含 Qdrant、外部 IP 自動學習)
4. Log 明細查詢與匯出(改工作模式,D6)
5. `ai`(依 B0 結果)

**完成條件**:以同一批假 log 比對舊版與新版摘要完全一致(`SUMMARY_VERSION` 不變);模組內沒有直接讀寫資料檔;`security-auditor`、`code-reviewer` 審查完成;不再相依 `mssql`、`activedirectory2`、`jsonwebtoken`。

## F1 前端接入

- 移到 `frontend/`,`base: '/netops/'`,接 `@giganexus/web-kit`。
- 移除 `Login.vue`、`SyncLogin.vue`、`stores/token.js`、`/theme.css` 與 `/__themes`。
- 頁面依權限顯示,AI 串流與下載帶 CSRF、不再帶 Bearer。
- 外框加應用切換、無權限導回 `/?denied=netops`;配色對齊 GigaItApp。
- Veeam 改一般連結(D11)。

**完成條件**:`netops-admin`、`netops-viewer` 與無權限帳號各自看到正確畫面;無寫死 `/` 開頭的資源路徑。

## D1 測試區部署

- Gateway:`/netops/` Nginx location、API Key、`gw.app` 登記(跨 repo)。
- giga-observe:拓樸與 ingest Key。
- NetOps:`deploy/`、`.gitlab-ci.yml`、`gateway-routes.yaml`、`gateway-rbac.yaml`、機密腳本(使用者執行)。
- 容器內驗證 FTP、LLM、Embedding、Qdrant;確認外部 IP 自動學習的對外連線(D10);知識庫 NAS 備份(Q3)。

**完成條件**:`develop` 合併後 CI 部署成功;瀏覽器走完登入、總覽、明細、AI 問答、知識庫;架構觀測看得到心跳與紀錄。

## D2 驗收與切換

1. 使用者在測試區驗收。
2. 正式區部署,發佈路由、授權角色。
3. 凍結舊版知識庫寫入,複製 `knowledge/` 並核對;摘要複製或重新分析。
4. 新舊期間數字核對後,通知使用者改用新網址,停用 IIS `/NetOps`。
5. 保留舊版一段時間作為回滾。

**完成條件**:正式區可用;舊版停止寫入;文件、架構資料與甘特圖更新。
