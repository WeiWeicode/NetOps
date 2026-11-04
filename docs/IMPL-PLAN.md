# NetOps 接入 Gateway 實作計畫

> 工作項目與完成條件;決策見 [ARCHITECTURE.md](ARCHITECTURE.md)。**時程以 NexusPlan 甘特圖為準**,本文件只記狀態。

| 項目 | 內容 | 狀態 |
| --- | --- | --- |
| D0 | 文件與登記 | 完成 |
| B0 | 最小骨架部署 | 完成 |
| B1 | 後端骨架 | 完成 |
| B2 | 模組搬移 | 完成 |
| F1 | 前端框架與畫面改寫 | 完成 |
| D1 | 測試區部署 | 完成(有未驗項目) |
| D2 | 驗收與切換 | 未開始 |
| S0 | 串流驗證(SSE 經 Nginx / BFF) | 未開始(ARCHITECTURE D7) |
| A1 | AI 搬進 `netops-api`、停用舊版 IIS | 未開始(D23、D18) |
| R0 | PA 即時監控前置:設備帳號、Log Forwarding、網路、容量量測 | 未開始(PA-LIVE-PLAN §5、§11) |
| R1 | PA 即時監控(唯讀):`netops-pa`、`netops-redis`、即時監控頁 | 未開始(D19、D21、D24) |
| R2 | 封鎖 IP(DAG 動態標籤) | 未排程(D22) |
| ~~後續~~ | ~~服務寫入資料庫~~ | 取消(D20) |
| ~~後續~~ | ~~接入 AI 中控台~~ | 取消(D17 → D23) |

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

**狀態:完成(2026-11-03)**。NetOps !4 合併(`develop` e53f8da)。上游與路由由服務啟動時自動註冊為草稿,不另寫登記腳本;監控 Key 先留空檔(giga-observe 拓樸屬 D1)。驗證結果:

| 完成條件 | 結果 |
| --- | --- |
| `develop` 合併後 CI 部署成功 | Pipeline #629 成功;容器 healthy,日誌「API 已註冊為草稿」,路由發佈後生效 |
| 已登入的瀏覽器經 Gateway 呼叫得到驗證路由 | `GET /api/netops/ping` 回 200,帶出 S112009 的工號、姓名、部門與角色 |
| 沒有權限回 403 | 指派 `netops.ping.read` 前同一帳號回 403 `PERMISSION_DENIED` |
| 直連服務沒有 Token 回 401 | 容器內 `GET /v1/ping` 回 401 `NETOPS_INTERNAL_TOKEN_INVALID` |

**完成條件**:`develop` 合併後 CI 部署成功;已登入的瀏覽器經 `Traefik → Nginx → BFF` 呼叫得到驗證路由;沒有權限回 403;直連服務沒有 Token 回 401。

## B1 後端骨架

- `infra/store`、`infra/jobs`、完整設定(`*_FILE`、缺少必要設定時啟動失敗)。
- `docs/API.md` 建立舊路徑 → 新路徑對照;移除 `auth`、`jump`、`ai` 與 `kb` 的 `learn-ips`、`vector-sync`,數量以實際盤點為準。

**完成條件**:`npm test` 通過;本機無 Token 回 401;OpenAPI 必填欄位檢查通過。

**狀態:完成(2026-11-03 合併 !7,測試區 #640 部署)**。盤點舊版 41 支 API:搬移 27、移除 14([API.md](API.md) §9)。`docs/API.md` 寫完全部模組的路徑與格式(B2 各批照此實作);設定新增資料目錄 `NETOPS_DATA_DIR` 與 FTP(`FTP_PASSWORD_FILE`),test / prod 缺少時啟動失敗;`/readyz` 檢查資料目錄;`infra/jobs` 工作只有本人可查、有上限與保留時間。測試區需先執行 `deploy/host2-set-secrets.sh` 補 FTP 密碼與資料目錄才能部署。

## B2 模組搬移

順序由低風險到高風險,每個模組先補測試再搬移:

1. `ftp`、`pa`(摘要、總覽、選項)
2. `pa-events`、`ad`
3. `kb`(筆記查詢、新增、修改、刪除、下載與匯整檔;關鍵字搜尋)
4. Log 明細查詢與匯出(改工作模式,D6)

**不搬移**(D17,留在舊版 IIS):`routes/ai.js`、`lib/evidence.js`、`lib/llm.js`、`lib/vector.js`、`lib/iplearn.js`。`lib/flows.js` 只搬匯入寫入的部分,連線組合統計照常產生。

**狀態**(分批 MR,堆疊):

| 批次 | 內容 | 狀態 |
| --- | --- | --- |
| `feature/netops-b2-pa` | `infra/ftp`(唯讀、連線上限)、PA TRAFFIC 與其他類型 log 的匯入、流量總覽、FTP Log 檔案(PA) | 已合併(!8) |
| `feature/netops-b2-ad` | 安全事件總覽、AD 匯入與總覽、AD 明細與匯出、FTP Log 檔案(AD) | 已合併(!9) |
| `feature/netops-b2-kb` | 知識庫 | 已合併(!10) |
| `feature/netops-b2-logs` | PA Log 明細查詢與匯出(工作模式) | 已合併(!11),測試區驗證通過 |

其他類型 log 的**匯入**放在 b2-pa(FTP Log 檔案頁同時列 TRAFFIC 與其他類型目錄),總覽 API 在 b2-ad。

**狀態:完成(2026-11-03,!8–!11 合併並部署測試區)**。四批都以同一批假 log 與舊版 `server/lib` 比對一致(`SUMMARY_VERSION` = 4);模組只經 `infra/store` 讀寫;每批都經 `security-auditor`、`code-reviewer` 審查並修正(含兩個 High:IP 萬用字元 ReDoS、知識庫標籤換行偽造記錄人);`backend/` 從未相依 `mssql`、`activedirectory2`、`jsonwebtoken`(只在舊版根目錄 `package.json`,D12 不動)。後續修正:!20(DELETE 在 OpenAPI 宣告 204)、FTP 錯誤訊息不外露主機(!22,待合併)。行為規格見 `docs/Gherkin/`(!18)。

**完成條件**:以同一批假 log 比對舊版與新版摘要完全一致(`SUMMARY_VERSION` 不變);模組內沒有直接讀寫資料檔;`security-auditor`、`code-reviewer` 審查完成;不再相依 `mssql`、`activedirectory2`、`jsonwebtoken`。

## F1 前端框架與畫面改寫

依 [UI-GUIDE.md](UI-GUIDE.md)(D5):

1. **框架**:`frontend/` 從入口網框架複製(TypeScript、`src/ui/`、外框、`base: '/netops/'`、`@giganexus/web-kit`),換上工程藍主題色,先跑通空頁與權限。
2. **畫面**:由低風險到高風險逐頁改寫,每頁對照舊版功能:FTP Log 檔案 → 明細查詢 → AD 事件總覽 → 安全事件 `feature/netops-f1-pa-events` → 流量總覽 → 知識庫。
3. **收尾**:移除 `Login.vue`、`SyncLogin.vue`、`stores/token.js`、舊配色系統與 Element Plus、Tailwind。

- **不改寫**(D17):`PaAsk.vue`、`AiAnalysis.vue`、`TranslateBox.vue`,以及知識庫頁的語意搜尋與自動學習區塊。
- 頁面依權限顯示;寫入(`POST` / `PUT` / `DELETE`)經 web-kit 帶 CSRF,下載(`GET`)經 web-kit、不需 CSRF,都不帶 Bearer。
- 無權限導回 `/?denied=netops`。
- Veeam、舊版 AI 問答改一般連結(D11、D18)。

**狀態:完成**(2026-11-03 開 MR,2026-11-04 全部合併進 `develop`)。① 框架 `feature/netops-f1-frame`(!6,已合併);② 畫面逐頁,每頁一個堆疊 MR:FTP Log 檔案 !12 → AD 事件總覽 !13 → 安全事件 !14 → 流量總覽 !15 → Log 明細查詢 !16(PA 工作模式、AD)→ 知識庫 !17;③ 收尾 !19:只清 `frontend/` 的佔位頁;舊版 `src/`、`server/`、Element Plus / Tailwind 依 D12、D18 保留到舊版停用(UI-GUIDE §4)。全部頁面串接後端(B2 各批已合併),AI 功能改連結到舊版(D17)。

**完成條件**(以本機假 Gateway 驗證;測試區於 D1 驗證時用真實帳號再看一次):`netops-admin`、`netops-viewer` 與無權限帳號各自看到正確畫面;舊版功能逐頁對照無遺漏;四種風格組合 × 1440px / 375px 都用瀏覽器看過;`vue-tsc` 通過;`frontend/` 不相依 `element-plus`、`tailwindcss`;無寫死 `/` 開頭的資源路徑。

## D1 測試區部署

- Gateway:`/netops/` Nginx location、`gw.app` 登記(跨 repo)。
- giga-observe:拓樸與 ingest Key。
- NetOps:CI 加上 SPA、`gateway-rbac.yaml`、其餘機密腳本(使用者執行)。路由由服務啟動時自動註冊為草稿(B0),不另寫 `gateway-routes.yaml`(`apply` 會把已發佈路由打回草稿)。
- 容器內驗證 FTP;知識庫 NAS 備份(Q3)。

**狀態:完成(有未驗項目)(2026-11-04)**。Gateway !20、!21,giga-observe !3,NetOps !24–!26 合併並部署測試區;驗收報告見 `docs/test-reports/2026-11-04-d1-uat.md`(!27)。未驗:Log 明細查詢的送出 / 結果 / 取消 / 匯出(測試區要先分析一個 TRAFFIC 檔,寫入操作需使用者同意)、安全事件頁無資料時的重驗(!26)、知識庫備份還原;移到 D2 開頭(HANDOFF「2026-11-04 收工」)。指派 `netops-*` 角色前,`gw-super-admin` 要先補 `netops.*`(Gateway !21,DEPLOYMENT §3.5.1)。原合併順序:Gateway !20(Nginx `/netops/`、`deploy/gateway-apps.yaml`)→ giga-observe !3(拓樸 `netops-web`、`netops-api`、FTP、資料目錄)→ NetOps !24(合併前在主機 2 執行 `host2-set-secrets.sh` 建 ingest Key、`host2-setup-kb-backup.sh` 建 NAS 目錄)→ 套用 `gateway-apps.yaml` → GigaItApp 指派測試帳號。各 MR 的前後步驟與驗證寫在 MR 描述。

| 項目 | 做法 |
| --- | --- |
| SPA | `deploy-web-test`:`spa-netops` 映像以一次性容器發佈到 `gw_www/netops`(同 GigaItApp、giga-Portal),冒煙測試確認 `/netops/` 回本系統 index.html |
| 畫面權限 | `deploy/gateway-rbac.yaml`(ARCHITECTURE §5),`rbac-test` 每次 develop 套用;套用前檢查只動 `netops.*` / `netops-*`;角色不指派成員(D15) |
| 應用切換 | `gw.app` 由 Gateway `deploy/gateway-apps.yaml` 登記,Gateway 負責人手動套用 |
| 監控 | giga-observe ingest Key(服務 `netops-api`),由 `host2-set-secrets.sh` 建立;前端 `installMonitor({ app: 'netops-web' })` |
| 知識庫備份(Q3) | `netops-kb-backup` 每天 2 點打包 `knowledge/` 到 NAS `docker-folder/giga-netops/<區>`,核對檔數、`.sha256`、保留 30 份;沒有標記檔不寫入 |

**完成條件**:`develop` 合併後 CI 部署成功;瀏覽器走完登入、總覽、明細、知識庫;架構觀測看得到心跳與紀錄。

## D2 驗收與切換

1. 使用者在測試區驗收。
2. 正式區部署,發佈路由;負責人在 GigaItApp 指派 `netops-admin`、`netops-viewer`(D15)。
3. 關閉舊版知識庫寫入與外部 IP 自動學習,全部複製資料(D14),核對檔數;舊版繼續同步 FTP(D18)。關閉寫入的做法在這步之前確認。
4. 新舊期間總覽數字核對後,通知使用者改用新網址;AI 問答與分析繼續用舊版(D18)。
5. 在 `main` 打標籤保留舊版程式。舊版 IIS 運作到 A1 完成才停用,也作為回滾。

**完成條件**:正式區可用;舊版知識庫停止寫入、AI 功能仍可用;文件、架構資料與甘特圖更新。

---

> 以下 S0、A1、R0–R2 為 2026-11-04 新增,架構與細節見 [PA-LIVE-PLAN.md](PA-LIVE-PLAN.md)。順序以甘特圖為準;S0 是 A1 與 R1 的共同前提。

## S0 串流驗證

1. `netops-api` 加一支 SSE 驗證路由(heartbeat 每 15 秒),經 Nginx 與 BFF 在測試區連線超過 5 分鐘。
2. 確認不被緩衝、不因 60 秒閒置逾時中斷、斷線可重連、不累積斷路器失敗。
3. 需要改 Gateway 設定時,先說明並取得同意(Gateway repo)。

**完成條件**:測試區 SSE 連線 5 分鐘以上穩定;或確認不可行、改用輪詢並記錄原因。

## A1 AI 搬移

1. 替舊版 AI 核心(`evidence.js`、`llm.js`、`vector.js`、`iplearn.js`)補測試基準,再搬進 `backend/`(D4,`refactor-assistant`)。
2. 設定改連 `10.10.130.46`(`LLM_URL`、`LLM_MODEL`、`EMBED_URL`);Qdrant 與翻譯依 PA-LIVE-PLAN P6 定案。
3. API 補 `x-permission`、`x-gherkin`;`gateway-rbac.yaml` 加 AI 權限;前端加回 AI 分析、問答、翻譯、整理筆記、語意搜尋。
4. 確認主機 2、3 容器可連 AI 主機與 RDAP;測試區驗收。
5. 正式區上線後停用舊版 IIS(`main` 已打標籤)。

**完成條件**:新版 AI 功能與舊版一致並通過驗收;舊版 IIS 停用;文件、架構資料與甘特圖更新。

## R0 即時監控前置

1. 網通提供 PA-560 管理 IP、PAN-OS 版本,建立唯讀管理角色與 API Key、HTTP 與 Syslog Server Profile(P1、P2)。
2. ~~量 log 量與主機記憶體(P3)~~:2026-11-04 完成,見 PA-LIVE-PLAN §5。
3. ~~接收 port 與 Python 在 Gateway 文件登記(P4)~~:Gateway MR 已開;網通放行 `netops-pa` → PA-560 `:443` 與 PA-560 → 51293 / 51294。
4. 機密(API Key、HTTP 接收 Token)寫成腳本交給使用者在主機執行。
5. 轉送設好後核對實際每秒筆數與管理平面 CPU,必要時調整 PA-LIVE-PLAN §5 的保留時間。

**完成條件**:P1–P7 定案(P3–P7 已於 2026-11-04 定案);網路放行;轉送量核對寫回 PA-LIVE-PLAN §5。

## R1 即時監控(唯讀)

1. `pa-collector/`:SDK 輪詢寫快照與心跳;HTTP(其他類型)與 Syslog(TRAFFIC)接收,寫 Stream 與每分鐘統計;依 D21 修剪(TRAFFIC 明細 1 小時、統計 1 天;其他 2 天)。
2. `netops-redis` 加入 Compose 與 CI(測試區先;`maxmemory` 2 GB、RDB)。
3. `netops-api`:`infra/redis`、`modules/pa-live`(快照、排行、log、SSE),補 API.md、OpenAPI、Gherkin。
4. 前端「即時監控」頁;`gateway-rbac.yaml` 登記節點與權限。
5. 測試區驗收後上正式區;上線一週觀察 Redis 用量並檢討保留時間。

**完成條件**:即時監控頁在兩區可用;收集器停止時畫面明確顯示;Redis 用量在上限內;文件、架構資料與甘特圖更新。
