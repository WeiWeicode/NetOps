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
| S0 | 串流驗證(SSE 經 Nginx / BFF) | 完成(2026-11-05,不改 Gateway;ARCHITECTURE D7) |
| A1 | AI 搬進 `netops-api`、停用舊版 IIS | 測試區完成(2026-11-09);正式區上線與停用 IIS 併入 D2(D23、D18、D25) |
| R0 | PA 即時監控前置:設備帳號、Log Forwarding、網路、容量量測 | 完成(2026-11-10) |
| R1 | PA 即時監控(唯讀):`netops-pa`、`netops-redis`、即時監控頁 | **測試區完成(2026-11-10)**;正式區上線併入 D2(D19、D21、D24、D26) |
| R2 | 封鎖 IP(DAG 動態標籤) | 未排程(D22) |
| C0–C6 | PA log 高吞吐架構(ClickHouse + Parquet 冷歸檔 + PA 精準查詢) | **已核准(2026-11-10)**,C0 外部前置事項進行中;**C1 實測完成、MR 待合併**(D27–D33,[PA-LOG-CLICKHOUSE-GUIDE.md](PA-LOG-CLICKHOUSE-GUIDE.md)) |
| ~~後續~~ | ~~服務寫入資料庫~~ | 取消(D20;PA log 改寫 ClickHouse 見 C0–C6,D27) |
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

- **不改寫**(D17):`PaAsk.vue`、`AiAnalysis.vue`、`TranslateBox.vue`,以及知識庫頁的語意搜尋與自動學習區塊。(已由 D23 取代,於 A1 改寫;`TranslateBox` 與「請 AI 記錄」依 2026-11-09 決定不搬,D25)
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
2. 正式區部署,發佈路由;負責人在 GigaItApp 指派 `netops-admin`、`netops-viewer`(D15)。部署前**確認正式區 FTP 目錄**:測試區 `FTP_LOG_DIR=/my-data` 寫在 CI `deploy-api-test`(TRAFFIC 不在 FTP 根目錄);正式區的 `FTP_LOG_DIR`(與 `FTP_ROOT`、`FTP_AD_DIR`、各類型目錄)要對照舊版 IIS 實際使用的值,由負責人確認後寫進正式區的 `netops.env` 或部署設定,不要沿用預設值 `/`。
   - **正式區發佈 A1、R1 路由草稿**:`netops-api` 啟動時只註冊為草稿,沒發佈前畫面顯示「功能尚未啟用(路由未發佈)」(測試區 2026-11-09 驗收 §3.1、§4.4)。要發佈的:`netops.ai.*`、`kb/semantic-search`、`kb/vector-*`、`kb/ip-learning*`、`pa-live/*`(串流 `pa-live/stream` 逾時 60000 ms;`pa-live/collector-control` 在正式區回 403,可以不發佈)。
   - **API Key 改用專用帳號**:目前 API Key 由管理員帳號 `netops` 產生,這個帳號也能登入 Web UI 並 Commit(2026-11-10 確認;角色 `netops` 的 XML API 只開 Operational Requests、Log)。正式區前請網通另建只開 XML API(Operational Requests、Log)、不開 Web UI / CLI 的帳號,用它重新產生 API Key,再用 `deploy/host2-set-pa-secrets.sh`(主機 3 對應腳本)更新機密並以 `NETOPS_PA_RECREATE=1` 重建 `netops-pa`。
   - **正式區 PA-560 管理介面要換成公司 CA 簽發的憑證**:正式區不能用 `PA_TLS_INSECURE`(`netops-pa` 啟動會失敗);測試區目前用出廠自簽憑證 + `PA_TLS_INSECURE=1`。換好後以 `PA_CA_FILE` 指定公司 CA(PA-FORWARDING-SPEC 附錄 F)。
   - **正式區開好接收後,請網通對 Syslog Server Profile 再 Commit 一次**:PA-560 連 Syslog TCP 失敗後(System log `syslog connection failed … error: 110`)不會自動重試,接收若晚於 PA-560 的 Commit 開好,TRAFFIC 會一直進不來(2026-11-10 測試區實測;PA-FORWARDING-SPEC E 節、附錄 F.3 第 7 步)。核對:即時監控的 TRAFFIC 排行與即時 log 有資料。
   - 角色節點:`rbac-prod` 套用 `gateway-rbac.yaml` 後,`netops.pa-live.manage`(測試區收集器開關)也會出現在正式區的 `netops-admin`;正式區 API 回 403、畫面不顯示按鈕,不影響使用。
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

**狀態:完成(2026-11-05)**。測試區驗證全部通過:單一連線 375 秒不中斷、心跳間隔最大 15.0 秒、斷線後以 `Last-Event-ID` 重連序號接續、BFF 與 `netops-api` 沒有逾時或斷路器紀錄(報告 §3)。A1、R1 依報告 §3.6 實作,不需輪詢。原狀態說明:`GET /api/netops/pa-live/stream-test`(`netops.ping.read`,`x-timeout-ms: 60000`,心跳 15 秒,回 `X-Accel-Buffering: no`)與驗證腳本 `backend/scripts/sse-probe.mjs` 已完成(`feature/s0-sse`)。檢查 Gateway `develop` 後判定**不需改 Gateway**:Nginx 依回應標頭關閉緩衝、`proxy_read_timeout` 與 BFF undici `bodyTimeout` 都是閒置時間、BFF 串流轉送且斷路器只計標頭前的失敗(細節與測試區驗證步驟見 `docs/test-reports/2026-11-05-s0-sse.md`)。合併部署、發佈路由後依報告 §3 驗證。驗證完成後由需求方在 GigaItApp 停用驗證路由 `netops.pa-live.stream-test`(程式留在 repo 當 A1、R1 的範本)。

## A1 AI 搬移

1. 替舊版 AI 核心(`evidence.js`、`llm.js`、`vector.js`、`iplearn.js`)補測試基準,再搬進 `backend/`(D4,`refactor-assistant`)。
2. 設定改連 `10.10.130.46`(`LLM_URL`、`LLM_MODEL`、`EMBED_URL`);Qdrant 依 PA-LIVE-PLAN P6 定案(沿用舊版 `NetOpsKb`)。
3. API 補 `x-permission`、`x-gherkin`;`gateway-rbac.yaml` 加 AI 權限;前端加回 AI 分析、問答、語意搜尋、外部 IP 自動學習。翻譯與整理筆記依 2026-11-09 決定不搬(ARCHITECTURE D25、[AI-FEATURE-INVENTORY.md](AI-FEATURE-INVENTORY.md))。
4. 確認主機 2、3 容器可連 AI 主機與 RDAP;測試區驗收。
5. 正式區上線後停用舊版 IIS(`main` 已打標籤)。

**完成條件**:新版 AI 功能與舊版一致並通過驗收;舊版 IIS 停用;文件、架構資料與甘特圖更新。

**狀態:測試區完成(2026-11-09)**。!34–!36 合併,翻譯與整理筆記不搬(D25);測試區驗收見 `docs/test-reports/2026-11-09-a1-r1-uat.md`(!44、!45、!47)。主機 3 容器到 AI 主機(`.46` / `.45` 的 8080、8081、6333)與 5 個 RDAP 登記處已實測可連(2026-11-09)。剩下:正式區發佈路由(D2 第 2 步)、舊版 IIS 停用(D2 第 5 步)。

## R0 即時監控前置

1. 網通提供 PA-560 管理 IP、PAN-OS 版本,建立唯讀管理角色與 API Key、HTTP 與 Syslog Server Profile(P1、P2)。
2. ~~量 log 量與主機記憶體(P3)~~:2026-11-04 完成,見 PA-LIVE-PLAN §5。
3. ~~接收 port 與 Python 在 Gateway 文件登記(P4)~~:Gateway MR 已開;網通放行 `netops-pa` → PA-560 `:443` 與 PA-560 → 51293 / 51294。
4. 機密(API Key、HTTP 接收 Token)寫成腳本交給使用者在主機執行。
5. 轉送設好後核對實際每秒筆數與管理平面 CPU,必要時調整 PA-LIVE-PLAN §5 的保留時間。

**完成條件**:P1–P7 定案(P3–P7 已於 2026-11-04 定案);網路放行;轉送量核對寫回 PA-LIVE-PLAN §5。

**狀態:完成(2026-11-10)**。PA-560 `10.10.115.35`(PAN-OS 12.1.7-h3)唯讀 API Key、HTTP Server Profile `netops-http`(51293)、Syslog `netops-syslog`(51294,TRAFFIC)、Log Forwarding Profile `netops-forward` 套用 155 條規則(`docs/test-reports/2026-11-10-pa560-forwarding.md`,!49);主機 2 portproxy 51293 / 51294 與防火牆只放行 `10.10.115.35`。實測 TRAFFIC 約 107–117 筆/秒,已寫回 PA-LIVE-PLAN §5。

## R1 即時監控(唯讀)

1. `pa-collector/`:SDK 輪詢寫快照與心跳;HTTP(其他類型)與 Syslog(TRAFFIC)接收,寫 Stream 與每分鐘統計;依 D21 修剪(TRAFFIC 明細 1 小時、統計 1 天;其他 2 天)。
2. `netops-redis` 加入 Compose 與 CI(測試區先;`maxmemory` 2 GB、RDB)。
3. `netops-api`:`infra/redis`、`modules/pa-live`(快照、排行、log、SSE),補 API.md、OpenAPI、Gherkin。
4. 前端「即時監控」頁;`gateway-rbac.yaml` 登記節點與權限。
5. 測試區驗收後上正式區;上線一週觀察 Redis 用量並檢討保留時間。

**完成條件**:即時監控頁在兩區可用;收集器停止時畫面明確顯示;Redis 用量在上限內;文件、架構資料與甘特圖更新。

**狀態:測試區完成(2026-11-10)**。!37–!40、!46、!48、!51、!56、!57 合併並部署測試區;驗收報告 `docs/test-reports/2026-11-09-a1-r1-uat.md`、`2026-11-10-pa-live-uat.md`(!50、!59)全部項目通過:輪詢、HTTP 與 Syslog 接收、測試區收集器開關(D26)、排行 5 / 15 / 60 分鐘、即時 log 與篩選、暫停、5 分鐘重連以 `Last-Event-ID` 接續、串流每人 3 條上限、Redis `MINID` 修剪(TRAFFIC 1 小時穩態約 291 MB,離 2 GB 上限遠)。已知限制:TRAFFIC 量大時即時 log 依設計捨棄一部分並標示 `dropped` / `skipped`(!57 已提高上限,PA-LIVE-PLAN §8);登出後換發回 403 屬 Gateway web-kit(`docs/test-reports/2026-11-10-refresh-403.md`,未排程)。剩下:正式區上線(D2 第 2 步:發佈 `pa-live/*`、PA-560 換公司 CA 憑證、主機 3 portproxy 與防火牆、接收開好後請網通再 Commit Syslog Profile)與上線一週觀察 Redis 用量;長期保存與查詢改由 C0–C6 處理。

---

> 以下 C0–C6 為 2026-11-10 新增,**需求方 2026-11-10 核准**(「全部照建議」;ARCHITECTURE §3.1 D27–D33、手冊 §12 CQ1–CQ14)。架構、DDL 與範例程式見 [PA-LOG-CLICKHOUSE-GUIDE.md](PA-LOG-CLICKHOUSE-GUIDE.md)。順序以甘特圖為準;C4 與 C5 可平行。各階段的外部前置條件沒完成前,不開工該階段。

**負責人**:Claude 寫程式、測試、文件;**需求方**核准、執行含機密的主機腳本、合併 MR、對外聯絡;**網通**改 PA-560;**IT / NAS 管理者**處理 NAS 空間與主機資源。

## C0 外部前置事項(已核准,進行中)

決策已在 2026-11-10 核准並寫回文件(ARCHITECTURE D27–D33、AGENT §0 / §2 / §7.2、手冊 §12)。剩下要由需求方去找網通與 IT 處理的事:

| # | 誰 | 做什麼 | 卡住哪個階段 | 對應決策 |
| --- | --- | --- | --- | --- |
| E1 | 需求方 → **FTP 管理者 / IT** | 問 FTP `10.10.130.66` 上的 PA log(`/my-data` 等目錄)**保留多久**、會不會自動刪 | C4(決定歸檔原始 log 還是只歸檔彙總) | CQ3 |
| E2 | 需求方 → **IT / NAS 管理者** | E1 的答案不夠長時,申請 NetOps 歸檔空間:一年約 150–370 GB(原始 log Parquet 至少 1 年);現有 `docker-folder` 只剩 18 GB | C4 | CQ3、CQ12 |
| E3 | 需求方 → **網通** | PA-560 的 Syslog Custom Log Format(TRAFFIC)與 HTTP Payload(威脅類)**加 `$seqno`、`$sessionid`**,然後 Commit;改完回報實際變數名稱(PAN-OS 12.1.7-h3) | C2 | CQ9 |
|  |  | **E3 結果(2026-11-10 完成)**:需求方在 PA-560 把 `,"seqno":"$seqno","sessionId":"$sessionid"` 加到 Syslog `netops-syslog` 的 Traffic 格式與 HTTP `netops-http` 的 Threat、URL、Data、Wildfire Payload 並 Commit(變數名稱與文件相同)。主機 2 抓封包:51294 與 51293 都帶到值(例:seqno `7688588907462574142`、sessionId `288580`),TRAFFIC 持續接收。PA-FORWARDING-SPEC B.3、C.2 已更新;Decryption / GlobalProtect / User-ID 沒有加 |  |  |
| E4 | 需求方 → **網通** | NetOps API Key 的管理角色**加 XML API「Log」權限**;先在離峰手動試查 3–5 次(單一 IP、15 分鐘、500 筆),看 `show system resources` 的管理平面 CPU,給一個可接受的門檻 | C5 | CQ6 |
|  |  | **E4 結果(2026-11-10 完成)**:需求方在 PA-560 Admin Role `netops` 的 XML API 加開 Log(其他維持只有 Operational Requests)並 Commit。上班時段 15:40 從主機 2 `netops-pa` 容器試查 3 次(TRAFFIC、單一 IP `10.10.130.124`、15 分鐘、`nlogs` 500):每次 1.5 秒、109–117 筆,管理平面 CPU 查詢前後與查詢中都在 3.0–6.2%,沒有上升。**門檻**:維持 C5 的上限(15 分鐘、500 筆、逾時 60 秒、全域一次一個);送出前取樣管理平面 CPU,**超過 50% 不送、回 429**;較大範圍(1–24 小時)在 C5 開發時再實測,實測前不放寬 |  |  |
| E5 | 需求方 → **IT**(主機 3) | 正式區上線前確認主機 3 資源:WSL `ext4.vhdx` 在哪個磁碟、剩餘空間(要 40 GB);記憶體不夠時能否把 WSL 加到約 10 GB(要重啟 WSL,舊系統一起中斷,要排時間)或改放其他主機 | C6(C1 實測後再確認數字) | CQ2 |
| E6 | 需求方 | 同意 C1 在主機 2 測試區新增 `netops-clickhouse` 容器(記憶體上限 1.5 GB、TTL 3 天)——**2026-11-10 同意,C1 已完成(!62)** | C1 | CQ2 |

**E6 已同意(2026-11-10)**。C1 實測後的建議數字(`docs/test-reports/2026-11-10-clickhouse-c1.md` §8):**E2** 原始 log Parquet 一年約 80–122 GB,申請 **150 GB / 年**(只歸檔每小時彙總約 0.1 GB / 年);**E5** 主機 3 vhdx 所在磁碟預留 **20 GB**、ClickHouse 容器上限 **2 GB**,不必先加大 WSL。FTP `/my-data` 目前只看得到 25 天(2026-10-16 起,`2026_10_19` 缺檔),E1 仍要 FTP 管理者確認保留規則。

**完成條件**:E1–E6 都有結果並寫回本節;E1 決定 CQ3 的分支後更新 ARCHITECTURE D30 狀態。

## C1 POC 與容量實測(已核准)

1. 測試區起 `netops-clickhouse`(記憶體上限 1.5 GB、TTL 3 天)。
2. 從 FTP 匯入**一整天** TRAFFIC,量壓縮後大小、匯入時間、Parquet 每天大小。
3. 跑總覽、Top N、明細、冷查詢的代表查詢,記錄回應時間與記憶體;確認 `IPv6` 的 skip index 與 Parquet 讀回條件、低記憶體設定名稱。

**前置**:E6。**負責人**:Claude;需求方同意與合併。**完成條件**:手冊 §4 的估算換成實測值;主機 2 測試區其他服務沒有受影響。

**狀態:實測完成(2026-11-10),MR 待合併**。報告 `docs/test-reports/2026-11-10-clickhouse-c1.md`:一天 1,043 萬筆(FTP CSV 6.55 GB)匯入 228 秒,ClickHouse **205 MiB / 天(20.6 bytes / 筆)**、Parquet **200 MB / 天**;總覽與 Top N 查彙總表 7–119 ms,一天明細 30–284 ms,冷查詢(NAS)0.1–1.3 秒;記憶體最高 479 MiB(上限 1.15 GB),WSL available 最低 2.5 GB,其他服務沒有受影響。`dst` 用 `bloom_filter`、網段查詢用 `BETWEEN`。`netops-clickhouse`(26.3.62.3)、`deploy/clickhouse/`(設定、DDL、`apply-schema.sh`)、CI 啟動與建表進 develop;**合併前需求方在主機 2 執行 `sudo sh deploy/host2-set-clickhouse-secrets.sh`**。手冊 §4 已換成實測值。

## C2 寫入管線(已核准)

1. `netops-ingest`:consumer group 讀 `netops:pa:log:{type}`、每 3–5 秒批次寫入、成功才 ACK、啟動時偵測缺口、心跳。不過濾雜訊(CQ8)。
2. DDL 與 migration(依 `GW_ENV` 套 TTL:測試區 2–3 天;正式區 TRAFFIC 30 天、威脅類 90 天)、三個 ClickHouse 帳號、機密腳本(使用者執行)、Compose、CI。
3. `pa-collector/` 欄位加 `seqno`、`sessionid`(CQ9),PA-FORWARDING-SPEC 同步更新。

**前置**:C1;E3(網通改轉送格式)。**負責人**:Claude 寫;需求方執行機密腳本、合併;網通改 PA-560。**完成條件**:測試區連續 3 天每小時筆數和 Redis 接收計數差 < 0.5%;重啟不漏、重複有修正;Redis 記憶體在上限內。

**狀態:測試區運作中,3 天觀察進行中(2026-11-11 起)**。!67(收集器 `seqno`、`sessionId`)、!68(`netops-ingest`、migration 001 / 002、`netops-ch` 網路、CI)已合併,pipeline 830;網通已對 `netops-syslog` 再 Commit。第一次核對(報告 `docs/test-reports/2026-11-10-clickhouse-c2.md` §4):Stream 涵蓋範圍內 TRAFFIC 差 0.004%、威脅類 0%,無缺口、無重複,記憶體在上限內;連續 3 天每小時核對補在 §5。需求方決定(2026-11-11):Redis ACL、`netops_writer` 縮權限都不做。

## C3 查詢切換(已核准)

1. `netops-api` 新增 `infra/clickhouse`(唯讀帳號、`query_params`)。
2. 流量總覽、安全事件、Top N 改查每小時彙總 + Redis 快取(CQ11);Log 明細 ≤ 30 天改查 ClickHouse(工作模式,D6)。
3. FTP 每日對帳(每小時筆數)與補漏;**並行 2 週後**切換明細來源(CQ10);API.md、OpenAPI、Gherkin。

**前置**:C2。**負責人**:Claude;需求方驗收。**完成條件**:與 FTP 摘要數字誤差 < 0.5%;一天範圍明細 < 10 秒;並行對帳 2 週無未處理缺口。

**狀態:開發中(2026-11-11)**。第 1 批 `feature/clickhouse-c3-query`:`netops-api` 唯讀查詢(`infra/clickhouse/reader.ts`,帳號 `netops_reader`)、總覽 / 篩選選項 / 安全事件加 `source`(ftp / clickhouse / auto,設定 `NETOPS_PA_OVERVIEW_SOURCE` 預設 auto)、Redis 快取 60 秒;排行改由 ClickHouse 每小時摘要提供(ARCHITECTURE D42;彙總表只涵蓋 App、區域、來源 IP,不新增表)。驗收(誤差、明細秒數)等 C2 觀察完成後做。

## C4 冷歸檔(已核准,待 FTP 保留期限)

1. 每天 02:30 匯出前一天 Parquet(本機暫存 → NAS `/mnt/nas-docker/giga-netops/{env}/pa-archive/YYYY/`)、SHA-256、manifest、重試到 D+25。歸檔原始 log 或只歸檔每小時彙總,依 E1 的結果(CQ3)。
2. ClickHouse 唯讀掛載歸檔目錄,冷查詢(工作模式,最多 7 天)。

**前置**:C2;**E1(FTP 保留期限)**,需要時 E2(NAS 空間);NAS 目錄與標記檔。**負責人**:Claude 寫;IT / NAS 管理者處理空間;需求方建目錄。**完成條件**:連續 7 天歸檔成功、雜湊核對通過;`file()` 查得到 7 天前資料;拔掉 NAS 時寫入不受影響、恢復後補歸檔。

## C5 PA 精準查詢(已核准)

1. `netops-pa` 查詢執行者(視窗 ≤ 15 分鐘、`nlogs` ≤ 500、逾時 60 秒、全域鎖;送出前管理平面 CPU > 50% 不送,E4 結果)。
2. `netops-api` 送出 / 結果 API(冷卻、429)、權限 `netops.pa-query.read`、按鈕節點 `netops.pa-live.query`,**只給 `netops-admin`**(CQ7);即時監控頁加按鈕;Session Browser。

**前置**:C3;**E4(網通開 Log 權限並離峰試查,給管理平面 CPU 門檻)**。**負責人**:Claude 寫;網通改角色並觀察;需求方驗收。**完成條件**:上限無法繞過;同時第 2 個請求回 429;viewer 呼叫回 403;執行時管理平面 CPU 在網通門檻內;結果與 PA Monitor 一致。

## C6 正式區上線(已核准)

1. 主機 3 依 E5 的資源部署;確認舊系統 port 不受影響。
2. 上線一週觀察記憶體、磁碟、歸檔;一個月後看雜訊佔比(CQ8);依 CQ10 降級 FTP。
3. 其他 repo 文件與架構資料(手冊 §10.5,跨 repo 先取得同意)。

**前置**:C2–C5 測試區驗收;**E5(主機 3 資源)**。**負責人**:Claude;需求方部署與合併;IT 處理主機資源。**完成條件**:正式區可用;`npm run arch:check` 通過;文件與甘特圖更新。
