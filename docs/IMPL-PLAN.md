# NetOps 接入 Gateway 實作計畫

> 工作項目與完成條件;決策見 [ARCHITECTURE.md](ARCHITECTURE.md)。**時程以 NexusPlan 甘特圖為準**,本文件只記狀態。

| 項目 | 內容 | 狀態 |
| --- | --- | --- |
| D0 | 文件與登記 | 完成 |
| B0 | 最小骨架部署 | 程式完成,待合併與測試區驗證 |
| B1 | 後端骨架 | 未開始 |
| B2 | 模組搬移 | 未開始 |
| F1 | 前端框架與畫面改寫 | 未開始 |
| D1 | 測試區部署 | 未開始 |
| D2 | 驗收與切換 | 未開始 |
| 後續 | 服務寫入資料庫 | 未排程(ARCHITECTURE §4.2) |
| 後續 | 接入 AI 中控台、停用舊版 IIS | 未排程;目前只有 PRD(ARCHITECTURE D17、D18) |

---

## D0 文件與登記

- NetOps:`AGENT.md`、`CLAUDE.md`、`GEMINI.md`、`.gitattributes`、MR 範本、`docs/`。
- 工作區:`AGENT.md` §3、`PROJECT-MAP.md`、`architecture/workspace.json`、`deployment.json`、甘特圖。
- Gateway:`AGENT.md` §10.2、§10.3,`BACKEND-GUIDE.md` §3.3,`PRD.md` SPA 路徑表。
- 建立 `develop`。

**完成條件**:`npm run arch:check` 通過;架構圖看得到 NetOps;三個 repo 的文件 MR 已合併(NetOps !1、giganexusai !20、giga-api-gateway-bff !18)。

## B0 最小骨架部署

D13:骨架直接留用;AI 不在這次範圍,不做串流驗證(D7、D17)。

- `backend/` 由 `samples/node-backend` 複製,`gateway.project = NetOps`、`SERVICE_CODE = netops-api`。
- 內部 Token 驗證、統一錯誤格式、`/healthz`、`/readyz`、`/openapi.json`、`setupGateway`。
- `deploy/`、`.gitlab-ci.yml`(只有 `netops-api`)、測試區上游與路由、API Key(機密腳本由使用者執行)。
- 一支驗證用路由:`GET /api/netops/ping`(後端 `/v1/ping`,權限 `netops.ping.read`),回傳登入者身分。

**狀態(2026-11-03)**:`backend/`、`deploy/docker-compose.yml`、`deploy/host2-set-secrets.sh`、`.gitlab-ci.yml` 已完成,`npm run typecheck`、`npm test`(11 項)、`npm run build` 通過;上游與路由由服務啟動時自動註冊為草稿,不另寫登記腳本。監控 Key 先留空檔(giga-observe 拓樸屬 D1)。待:使用者在主機 2 執行機密腳本 → 合併 `develop` → 發佈草稿、指派權限 → 驗證下列完成條件。

**完成條件**:`develop` 合併後 CI 部署成功;已登入的瀏覽器經 `Traefik → Nginx → BFF` 呼叫得到驗證路由;沒有權限回 403;直連服務沒有 Token 回 401。

## B1 後端骨架

- `infra/store`、`infra/jobs`、完整設定(`*_FILE`、缺少必要設定時啟動失敗)。
- `docs/API.md` 建立舊路徑 → 新路徑對照;移除 `auth`、`jump`、`ai` 與 `kb` 的 `learn-ips`、`vector-sync`,數量以實際盤點為準。

**完成條件**:`npm test` 通過;本機無 Token 回 401;OpenAPI 必填欄位檢查通過。

## B2 模組搬移

順序由低風險到高風險,每個模組先補測試再搬移:

1. `ftp`、`pa`(摘要、總覽、選項)
2. `pa-events`、`ad`
3. `kb`(筆記查詢、新增、修改、刪除、下載與匯整檔;關鍵字搜尋)
4. Log 明細查詢與匯出(改工作模式,D6)

**不搬移**(D17,留在舊版 IIS):`routes/ai.js`、`lib/evidence.js`、`lib/llm.js`、`lib/vector.js`、`lib/iplearn.js`。`lib/flows.js` 只搬匯入寫入的部分,連線組合統計照常產生。

**完成條件**:以同一批假 log 比對舊版與新版摘要完全一致(`SUMMARY_VERSION` 不變);模組內沒有直接讀寫資料檔;`security-auditor`、`code-reviewer` 審查完成;不再相依 `mssql`、`activedirectory2`、`jsonwebtoken`。

## F1 前端框架與畫面改寫

依 [UI-GUIDE.md](UI-GUIDE.md)(D5):

1. **框架**:`frontend/` 從入口網框架複製(TypeScript、`src/ui/`、外框、`base: '/netops/'`、`@giganexus/web-kit`),換上工程藍主題色,先跑通空頁與權限。
2. **畫面**:由低風險到高風險逐頁改寫,每頁對照舊版功能:FTP Log 檔案 → 明細查詢 → AD 事件總覽 → 安全事件 → 流量總覽 → 知識庫。
3. **收尾**:移除 `Login.vue`、`SyncLogin.vue`、`stores/token.js`、舊配色系統與 Element Plus、Tailwind。

- **不改寫**(D17):`PaAsk.vue`、`AiAnalysis.vue`、`TranslateBox.vue`,以及知識庫頁的語意搜尋與自動學習區塊。
- 頁面依權限顯示,下載帶 CSRF、不再帶 Bearer。
- 無權限導回 `/?denied=netops`。
- Veeam、舊版 AI 問答改一般連結(D11、D18)。

**完成條件**:`netops-admin`、`netops-viewer` 與無權限帳號各自看到正確畫面;舊版功能逐頁對照無遺漏;四種風格組合 × 1440px / 375px 都用瀏覽器看過;`vue-tsc` 通過;不再相依 `element-plus`、`tailwindcss`;無寫死 `/` 開頭的資源路徑。

## D1 測試區部署

- Gateway:`/netops/` Nginx location、`gw.app` 登記(跨 repo)。
- giga-observe:拓樸與 ingest Key。
- NetOps:CI 加上 SPA、`gateway-routes.yaml`、`gateway-rbac.yaml`、其餘機密腳本(使用者執行)。
- 容器內驗證 FTP;知識庫 NAS 備份(Q3)。

**完成條件**:`develop` 合併後 CI 部署成功;瀏覽器走完登入、總覽、明細、知識庫;架構觀測看得到心跳與紀錄。

## D2 驗收與切換

1. 使用者在測試區驗收。
2. 正式區部署,發佈路由;負責人在 GigaItApp 指派 `netops-admin`、`netops-viewer`(D15)。
3. 關閉舊版知識庫寫入與外部 IP 自動學習,全部複製資料(D14),核對檔數;舊版繼續同步 FTP(D18)。關閉寫入的做法在這步之前確認。
4. 新舊期間總覽數字核對後,通知使用者改用新網址;AI 問答與分析繼續用舊版(D18)。
5. 在 `main` 打標籤保留舊版程式。舊版 IIS 運作到 AI 中控台接入才停用,也作為回滾。

**完成條件**:正式區可用;舊版知識庫停止寫入、AI 功能仍可用;文件、架構資料與甘特圖更新。
