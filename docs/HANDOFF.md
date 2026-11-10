# NetOps 交接

> 接手時先讀 `AGENT.md`,再讀 `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`。

## 2026-11-10 C1 ClickHouse POC 與容量實測(`feature/clickhouse-c1-poc`)

- **結果**:報告 `docs/test-reports/2026-11-10-clickhouse-c1.md`。一天 TRAFFIC(2026-11-09,FTP 6.55 GB、1,043 萬筆)匯入 228 秒;ClickHouse 205 MiB / 天(20.6 bytes / 筆)、Parquet 200 MB / 天;彙總查詢 7–119 ms、一天明細 30–284 ms、NAS 冷查詢 0.1–1.3 秒;記憶體最高 479 MiB。手冊 §4 已換成實測值,IMPL-PLAN C0 寫入 E2(申請 150 GB / 年)、E5(磁碟 20 GB、容器 2 GB)建議。
- **進 develop 的內容**:`netops-clickhouse`(`clickhouse/clickhouse-server:26.3.62.3`,1536m、uid 101、只在 `netops-internal`)、`deploy/clickhouse/`(低記憶體設定、`default` 只限容器本機、查詢設定檔、DDL、`apply-schema.sh` 依部署區套 TTL)、`deploy/host2-set-clickhouse-secrets.sh`(三個帳號)、CI `deploy-api-test` 起容器與建表、POC 工具 `deploy/clickhouse/poc/`。
- **合併前**:需求方在主機 2 WSL 執行 `sudo sh deploy/host2-set-clickhouse-secrets.sh`(沒跑時 CI 在 ClickHouse 步驟停下:前面的服務已更新,但冒煙測試、前端發佈與 RBAC 不會執行,補跑腳本後重跑 pipeline)。
- **TRAFFIC Syslog 從 2026-11-10 13:45 起沒有進來**(`netops-pa` 重啟後 PA-560 沒重連,error 110):請網通對 `netops-syslog` 再 Commit。
- **下一步**:C2 等 E3(`$seqno`、`$sessionid`);C2 建議見報告 §9。POC 容器與資料已刪除,合併後的測試區 ClickHouse 是空的。

## 2026-11-10 R1 PA 即時監控收尾(測試區完成)

**接手方式**:新討論串說「從 `NetOps/docs/HANDOFF.md`「2026-11-10 R1 收尾」接手」,用主討論串協調模式。子任務已全部結束;工作分支與 worktree 已清理,只留 `develop`、`main` 與未合併 MR 的分支。

### 現況

| 工作 | 狀態 |
| --- | --- |
| A1 AI 搬移 | 測試區完成(2026-11-09);正式區併入 D2 |
| R0 前置 | 完成:PA-560 轉送設定 !49、主機 2 portproxy 與防火牆 |
| R1 即時監控 | **測試區完成**:驗收 !50、!59 全部通過;修正 !51、!56、!57 已合併(IMPL-PLAN R1 狀態) |
| C0–C6 ClickHouse | 已核准(CQ1–CQ14「全部照建議」);決策寫回文件 !60(待合併);C0 外部事項 E1–E6 進行中 |
| D2 正式區 | 未開始;PA 相關步驟已寫在 IMPL-PLAN D2 第 2 步 |

### 測試區目前設定(主機 2)

- `/srv/giganexus/deploy/netops.env`:`PA_POLL_ENABLED=1`、`PA_RECEIVE_ENABLED=1`、`PA_HOST=10.10.115.35`、`PA_ALLOWED_SOURCES=172.26.0.1`、`PA_TLS_INSECURE=1`(備份 `.bak-20261109`、`.bak-20261110`)。收集器保持開啟(需求方 2026-11-10 決定);要暫停用即時監控頁的「輪詢 / 接收」按鈕(`netops-admin`)。
- 接收路徑:PA-560 → `10.10.130.124:51293/51294`(Windows portproxy → WSL)→ `netops-pa`;容器看到的來源是 Docker 閘道 `172.26.0.1`。
- PA-560 Syslog TCP 斷線(error 110)後**不會自動重連**:主機 2 重開機、`netops-pa` 長時間停機後 TRAFFIC 沒進來,請網通對 `netops-syslog` 再 Commit 一次。

### 下一步(依序)

1. 需求方合併 !60(ClickHouse 決策寫回文件),再合併本 MR。
2. C0:需求方向 FTP 管理者 / IT 問 E1、E2、E5,向網通提 E3、E4;E6 同意後派 C1(主機 2 測試區 `netops-clickhouse`,1.5 GB、TTL 3 天)。
3. D2 正式區:發佈 A1 / R1 路由、PA-560 換公司 CA 憑證、主機 3 portproxy 與防火牆、接收開好後網通再 Commit Syslog Profile;上線一週觀察 Redis 用量。
4. 待決定:登出後換發 403(Gateway web-kit,`docs/test-reports/2026-11-10-refresh-403.md`),建議延後。
5. 階段結束更新工作區架構資料與甘特圖 W12。

## 2026-11-09 驗收修正與測試區收集器開關(`feature/pa-live-uat-1109`)

依驗收報告 `docs/test-reports/2026-11-09-a1-r1-uat.md`(§3.1、§3.7、§4、§6、§7.4、§7.5)與需求方 2026-11-09 的決定(MR 描述有細節):
- **測試區收集器開關**:即時監控頁「收集器」區加「輪詢:開啟 / 停用」「接收:開啟 / 停用」(`netops.pa-live.manage` → `netops.pa-realtime.write`,只給 `netops-admin`)。環境變數仍是總開關;按鈕只切換暫停 / 繼續,存在 Redis `netops:pa:control`(PA-LIVE-PLAN §4)。正式區 API 回 403、不顯示按鈕。決定記為 ARCHITECTURE D26。
- 頁首分開顯示輪詢 / 接收狀態;接收未啟用時排行與即時 log 寫「接收端點未啟用,沒有 log 來源」;設備狀態顯示最後更新時間。
- 串流 429:畫面寫「串流連線數已達上限,請關閉其他即時監控分頁」,重試間隔 30 秒起倍增到 5 分鐘。
- 404 `ROUTE_NOT_FOUND` 顯示「功能尚未啟用(路由未發佈)」(全站)。
- `GET /v1/ping` 401 的來源是 CI `deploy-api-test` 的冒煙測試(故意不帶 Token),改打 `/healthz`;401 改由單元測試涵蓋。
- R1-1~R1-4 接受、viewer 可以匯出 Log 明細(j):記在 ARCHITECTURE D26,下方待決定表已移除。

**合併後要做**:1. CI 通過;2. GigaItApp「服務與路由」發佈草稿 `netops.pa-live.collector-control`;3. `rbac-test` 套用後確認 `netops-admin` 有 `netops.pa-live.manage`(重新登入);4. 依 MR 描述重驗。

## 2026-11-06 收工(週額度用完,下週接續)

**接手方式**:新討論串說「從 `NetOps/docs/HANDOFF.md`「2026-11-06 收工」接手」,用主討論串協調模式(只派工、核對、收尾)。

### 現況

| 工作 | 狀態 | MR(都是 → `develop`,**都還沒合併**) |
| --- | --- | --- |
| D1 驗收修正 | 已合併(!30 報告、!31 修正);重驗延後到 A1、R1 完成後一起做 | — |
| S0 串流驗證 | **完成**(!32、!33;Gateway !23 文件已合併) | — |
| A1 AI 搬移 | 三批程式完成,本機測試通過(backend 165、frontend 79、Gherkin 74/74);**功能盤點完成(!42),等需求方決定**(需求方要求「重新盤點新舊功能差異,功能不用全部搬」) | !34 核心 → !35 API → !36 前端 |
| R1 PA 即時監控 | 四批程式完成(用假 PA 開發);**!40 的 `security-auditor` 還沒補跑**(額度中斷) | !37 收集器 → !38 部署 → !39 API → !40 前端 |
| R0 前置 | 等網通:PA-560 管理 IP、PAN-OS 版本、唯讀 API Key、轉送設定、網路放行;給網通的規格在 !38 的 `docs/PA-FORWARDING-SPEC.md` | — |

子任務(Claude Desktop):`netops-a1-ai`(A1,盤點完成)、`netops-r1-pa-live`(R1)。下週可以接續同一個子任務,脈絡太長就新開,brief 指向本段與各 MR 描述。

### 需求方的決定(2026-11-05 / 11-06,不要重新討論)

- `netops.ai.use` 給 `netops-admin`、`netops-viewer`;維持一個權限,不拆成 PA / AD。
- 向量同步(`VECTOR_SYNC`)與每天 IP 自動學習(`IPLEARN_HOUR`):**舊版 IIS 停用後才開**(正式區);測試區一直關。
- 問答送給模型的範例列(最多 15 筆)與 AD 訊息前 400 字:**接受,照舊版**(AGENT §7.4 例外,寫進 ARCHITECTURE)。
- 整理筆記等功能:先盤點新舊 AI 功能差異,再決定哪些不搬(盤點文件由 A1 子任務產出,等需求方決定)。
- 測試區 PA 收集器預設關閉,測試時才開(`PA_POLL_ENABLED`、`PA_RECEIVE_ENABLED` 預設 0)。
- R1:Redis 連不上時 API 回 **424**(2026-11-06)。
- PA SDK 用唯讀角色的 **API Key**(XML API 只開 Operational Requests),不存帳號密碼;需求方向網管申請中。

### 下一步(依序)

1. **A1 盤點**:盤點已完成,見 !42 `docs/AI-FEATURE-INVENTORY.md`(決定記為 ARCHITECTURE D25)。建議:分析、PA / AD 問答、語意搜尋、向量同步、IP 學習都搬;**整理筆記改成先回草稿**(§2.1 選項 B);翻譯可以搬,或確認沒人用就不搬;`/ai/context`、獨立翻譯模型、`vec-probe` 不搬。請需求方決定 #5 翻譯和 #6 整理筆記,再由子任務改 !35 / !36。舊版使用量沒查到,查法見盤點 §3。
2. **R1 補資安審查**:`netops-r1-pa-live` 對 !40 補跑 `security-auditor` 並修正。
3. **合併**:A1 與 R1 兩組 MR 互相衝突(主討論串 2026-11-06 模擬合併:`backend/src/app.ts`、`config.ts`、`test/helpers.ts`、`test/unit/config.test.ts`、`deploy/docker-compose.yml`、`docs/API.md`、`DevelopmentProcess/*Correction.md`、`docs/Gherkin/README.md`、`frontend/mock/gateway.ts`)。建議先合併 R1(!37 → !40),A1 盤點修改後 `git merge origin/develop`,依工作區 AGENT §9.3 先回報衝突、需求方同意後再解(多半是雙方新增的段落都保留)。
4. 合併後在測試區:發佈路由草稿、確認角色節點,再把 D1 修正、純 viewer 帳號、知識庫筆記備份、A1、R1 一起驗收(D1 修正的重驗清單見下方「2026-11-05 D1 驗收修正」)。
5. R0:網通回覆後放入 API Key、填 `PA_HOST`,依 `PA-FORWARDING-SPEC.md` 附錄 F 開啟輪詢與接收。
6. 階段結束整理一次 `PROJECT-MAP.md`、`IMPL-PLAN.md`、本檔,更新架構資料(工作區 repo)與甘特圖。

### 合併前需求方要在主機 2 執行

- **合併 !38 前**:用 `feature/r1-deploy` 分支的 `deploy/host2-set-pa-secrets.sh`,在主機 2 WSL 以 root 執行。會產生 HTTP Token,API Key 還沒拿到可以直接按 Enter。
- **合併 !35 前**:用 `feature/a1-ai-api` 分支的 `deploy/host2-set-secrets.sh`,在主機 2 WSL 以 root 執行,隱藏輸入 Qdrant API Key(和舊版 IIS `server/.env` 的 `QDRANT_API_KEY` 相同)。已存在的機密不會重建。

### 待需求方決定

| # | 事項 | 來源 |
| --- | --- | --- |
| A1-1 | 哪些 AI 功能不搬(盤點後決定) | A1 盤點 |
| A1-2 | 主機 3 容器內到 AI 主機與 RDAP 的連線還沒驗證(D2 前要補);RDAP 的 LACNIC、AFRINIC 從主機 2 逾時 | !34–!36 描述 |
| — | 2026-11-04 收工段的 a–l 仍有效(k:Gateway 防提權缺口 High,屬 Gateway repo) | 本檔下方 |

## 2026-11-05 S0 完成(測試區驗證通過)

- NetOps !32 合併(`develop` cce67e0,pipeline #702),路由已發佈。測試區驗證全部通過(報告 `docs/test-reports/2026-11-05-s0-sse.md` §3):SSE 經 Nginx 與 BFF 穩定長連線,**不改 Gateway、不改輪詢**。
- 需求方決定(2026-11-05):① 驗證完成後在 GigaItApp **停用**驗證路由 `netops.pa-live.stream-test`(需求方操作;程式留在 repo 當範本);② R1 單一連線最長 **5 分鐘**(PA-LIVE-PLAN §8);③ Gateway `docs/MONITORING-PLAN.md` 中「SSE 經 BFF 會被切斷」的說法另開 Gateway 文件 MR 更正。
- `netops.ping.read` 已由需求方指派給 S112009(驗證用)。
- **下一步**:A1、R1 依報告 §3.6 的規則實作串流。

## 2026-11-05 S0 串流驗證(`feature/s0-sse`)

- **狀態:程式與文件完成,待合併部署後在測試區驗證**。結論先寫在這:**不需改 Gateway**,只靠 NetOps 回應標頭與路由逾時(理由見 `docs/test-reports/2026-11-05-s0-sse.md` §4)。
- 驗證路由 `GET /api/netops/pa-live/stream-test`(`netops.ping.read`;`x-timeout-ms: 60000`;立即送 `open`,每 15 秒 `heartbeat`;`X-Accel-Buffering: no`;`Last-Event-ID` 接續;單一連線 10 分鐘;每人 2 條、全系統 20 條,滿了回 429)。介面見 `docs/API.md` §3.1。
- 驗證腳本 `backend/scripts/sse-probe.mjs`:Cookie 由需求方在提示時貼上(不回顯、不留歷史),腳本不印 Cookie、只送到 GigaNexus 網域;或在 `/netops/` 頁 Console 用 `EventSource`(報告 §3.3)。
- **合併後要做**:1. CI `deploy-api-test` 通過;2. 需求方在 GigaItApp「服務與路由」確認草稿 `netops.pa-live.stream-test` 逾時 60000 ms 後發佈;3. 驗證帳號有 `netops.ping.read`;4. 依報告 §3 跑 6 分鐘(含一次斷線重連)並查 giga-observe 斷路器;5. 結果填回報告,IMPL-PLAN S0 改為完成或改輪詢。
- **給 A1、R1**:SSE 路由一定要設 `x-timeout-ms` 大於心跳間隔(預設 10 秒會在第一次心跳前被切斷)、立即送第一個事件、回 `X-Accel-Buffering: no`;名額滿時回 4xx 不回 5xx(上游 5xx 會累積 BFF 斷路器失敗);服務關閉用 `preClose` 結束串流;寫法照 `modules/pa-live/routes.ts`。R1 的連線最長時間要再縮短(撤權後多久停止,見報告 §6)。

## 2026-11-05 D1 驗收修正(`fix/d1-uat-findings`)

依驗收報告 `docs/test-reports/2026-11-05-d1-uat-pending.md` 與需求方 2026-11-05 的決定修正(MR 描述有細節):
- **測試區 `FTP_LOG_DIR=/my-data`**:寫在 `.gitlab-ci.yml` 的 `deploy-api-test`(蓋過主機 `netops.env`),合併後 CI 重新部署即生效。只有 CI 部署會帶這個值:在主機手動 `docker compose up` 時要另外 `export FTP_LOG_DIR=/my-data`(或寫進 `netops.env`),否則會回到預設 `/`。**正式區的值未定**,D2 部署前由負責人確認(IMPL-PLAN D2 第 2 步),不要沿用預設 `/`。
- FTP 清單(PA、AD)不列 `$RECYCLE.BIN`、`System Volume Information`。
- PA「FTP Log 檔案」:不能分析的目錄(TRAFFIC 目錄直屬與各類型目錄以外)不顯示勾選框,改顯示說明。
- AD「FTP Log 檔案」:載入時不再送 `POST /ftp/ad/listings`;有 `netops.ad-files.manage` 的人按「列出 FTP 資料夾」才列出,其他人只看得到同步狀態。
- 未登入 / 無權限導回時,前端不再回報空白訊息的錯誤(`router.isReady()` 的導覽中止)。
- `netops-kb-backup` 加 healthcheck(`LAST_RESULT` 26 小時內且 OK);CI `up --wait` 會等它 healthy,備份失敗時 `deploy-api-test` 失敗。
- `it-admin` 的 NetOps 權限:需求方已在 GigaItApp 移除,本次未處理。

**合併後要重驗**:
1. CI `deploy-api-test` 通過(`netops-kb-backup` healthy),`docker exec netops-api env` 的 `FTP_LOG_DIR` 為 `/my-data`。
2. D1 未驗項目 1「Log 明細查詢」:先只分析 1 個 TRAFFIC 檔(約 38 MB;寫入,先取得同意),再做送出、結果表、取消、匯出(admin、viewer)。
3. PA FTP 頁:根目錄不列系統資料夾;`/my-data` 可勾選,根目錄與其他目錄沒有勾選框。
4. AD FTP 頁:開頁只送 `GET /ftp/ad/status`;admin 按「列出 FTP 資料夾」才送出清單工作;viewer 看不到按鈕。
5. 未登入開 `/netops/` 後,giga-observe `netops-web` 不再新增 `VIEW /netops/` 空白錯誤。

**仍待驗**(需求方決定等 A1、R1 完成後一起驗):純 `netops-viewer` 帳號的讀取與寫入被拒、知識庫筆記的備份還原(報告 §3.2、§4.3)。

## 2026-11-04 重新規劃(會議後)

- **取消 AI 中控台**:AI 搬進新版(A1,D23),連 `10.10.130.46`(`:8080` `Qwen3.6-35B-A3B-FP8`、`:8081` embedding;`.45` 相同作備用)。舊版 IIS 留到 A1 完成(D18)。
- **PA 即時監控**(R0–R2):`netops-pa`(Python,pan-os-python)+ `netops-redis`(log 保留 2 天);第一版只讀;**不寫入資料庫**(D20)。
- 規劃全文:[PA-LIVE-PLAN.md](PA-LIVE-PLAN.md)。開工前事項(§11)已定案 P3–P7:
  - 實測 TRAFFIC 每天約 1,000 萬筆(FTP `/my-data`,4.6–6.8 GB),主機 2 WSL 5.8 GiB、主機 3 7.8 GiB。定案 TRAFFIC 統計 1 天、明細 1 小時,其他類型 2 天;`maxmemory` 2 GB;開 RDB 不開 AOF。
  - TRAFFIC 用 Syslog(:51294),其他類型 HTTP(:51293);Python 與兩個 port 登記在 Gateway(Gateway MR)。
  - AI:沿用 Qdrant(A1 先比對 `.46:8081` embedding 維度)、翻譯沿用 LLM。
  - **待網通**:P1 PA-560 管理 IP 與 PAN-OS 版本、P2 唯讀 API Key 與轉送設定。
- 量測時發現:測試區 `FTP_LOG_DIR` 是空的,TRAFFIC 實際在 `/my-data`。D1 未驗項目 1 要先切到該目錄分析,或把 `FTP_LOG_DIR` 設為 `/my-data`。
- 下面「待使用者決定」的 d(舊版正式網址)在 A1 完成後就不再需要。

## 2026-11-04 收工

**已完成**
- **D1 測試區部署**:Gateway !20(Nginx `/netops/`、`gw.app`)、!21(`gw-super-admin` 只新增權限的套用流程,已在主機 2 補上 `netops.*`)、giga-observe !3(拓樸)、NetOps !24(CI 發佈 SPA、`gateway-rbac.yaml`、監控 Key、知識庫 NAS 備份)、!25(D1 文件)、!26(安全事件頁無資料時不送出查詢)全部合併並部署。
- **驗收**(報告見 !27 `docs/test-reports/2026-11-04-d1-uat.md`):`netops-admin`、`netops-viewer`、無權限三種帳號的畫面與導回、應用切換、1440px / 375px、架構觀測(`netops-api` 心跳與請求、`netops-web` 事件)、NAS 備份產生都通過。指派角色曾被防提權擋下(403),以 Gateway !21 替 `gw-super-admin` 補 `netops.*` 後指派成功。

**D1 未驗項目(下一階段先做)**
1. **Log 明細查詢**的送出、結果表、取消、匯出(admin 與 viewer 各一次):~~測試區還沒有已分析的 TRAFFIC log~~ 2026-11-09 驗收時 `/my-data` 已有 3,466 個已分析檔(2026-10-15 ~ 11-08),不需要再分析;已驗證通過(`docs/test-reports/2026-11-09-a1-r1-uat.md` §3.2、§4.1)。之後別再全選分析(一天約 110~170 檔、約 6 GB)。
2. **安全事件頁無資料時**不再呼叫 API(!26):驗收時測試區已有資料,要找沒有資料的類型再看一次,並確認架構觀測不再新增 `pa-events/overview` 的 400。
3. **知識庫備份可還原**:目前測試區 0 則筆記,備份是空的(`files=0`)。有筆記後解開一份備份核對內容與檔數。

**驗收發現的待改項目**

| 項目 | 說明 |
| --- | --- |
| FTP 根目錄列出系統資料夾 | FTP Log 檔案清單出現 `$RECYCLE.BIN`、`System Volume Information`;前端或後端過濾 |
| viewer 開 AD FTP 頁就觸發 FTP 掃描 | 頁面載入自動送 `POST /api/netops/ftp/ad/listings`(最長 3 分鐘),唯讀角色也會觸發,多人同時開會疊加(FTP 同時連線 1);改為手動或加快取 |
| 備份容器沒有 healthcheck | `netops-kb-backup` 只能看 `LAST_RESULT` 與日誌判斷 |
| `/netops/` 一度被導回入口網 | 指派後可進,之後又被導回,補權限並重新登入後沒再發生;推測與權限版本時差或指派被收回有關,原因未明,指派後再觀察 |

**下一步:D2 驗收與切換**(IMPL-PLAN D2)。切換前要先確認:
- 舊版關閉知識庫寫入與外部 IP 自動學習的做法(D14、D18)。
- 舊版知識庫 `uploads/knowledge` 不可重建,複製前**先備份**;新版 NAS 備份確認可還原(上面未驗項目 3)。
- 正式區的 Gateway 步驟同測試區:`gateway-rbac.yaml`(`rbac-prod`)、`gateway-apps.yaml`、`apply-super-admin-grants.sh prod`(正式區要明確指定 `IMAGE_TAG`,Gateway DEPLOYMENT §3.5.1)。

**待使用者決定**

| # | 事項 | 說明 |
| --- | --- | --- |
| a | CI Runner 只跑受保護分支 | `check:*` 在所有分支用主機 2 的 shell executor 執行,讀得到主機上的 npm Token;D1 後 develop 的 job 還會寫 `gw_www` 與 Gateway RBAC,影響變大。要不要設為 Protected runner 或改 docker executor |
| b | FTPS | FTP 帳密與 log 目前明文傳輸(沿用舊版)。確認 FTP 伺服器支援 FTPS 後才能設 `FTP_SECURE=1` |
| c | `.gz` 提早結束 | 舊版 `readLog` 讀 `.gz` 時,來源比解壓先關閉會提早結束(測試可重現;FTP 分段串流正常)。依 D4 沒改核心;FTP 上是否有 `.gz` 未確認 |
| d | 舊版 NetOps 正式網址 | **仍未確認**。F1 先用 `https://gsmc-web.gigasolar.com.tw/NetOps`(`frontend/src/config/links.ts`),AI 問答連結依賴它 |
| e | F1 新增的 UI 元件 | `GStackedBars` 等要不要回饋到入口網與 GigaItApp(跨 repo) |
| f | 知識庫匯整檔可被偽造成另一則筆記(Low) | 修了會改匯整檔格式(與舊版不同) |
| g | `spa-netops` 以 root 掛整個 `gw_www` | 同 GigaItApp、giga-Portal;只掛子目錄要 Compose `volume.subpath`(Docker 26+) |
| h | 知識庫備份是明文 | 放在附件服務共用的 NAS 分享;要不要獨立帳號 / ACL 或加密 |
| i | PA、AD 的 FTP 管理按鈕共用 `netops.ftp.write` | 預設兩個角色不受影響,單獨指派按鈕時權限比預期大 |
| j | ~~viewer 可以查詢並匯出 Log 明細~~ | **2026-11-09 決定:可以,維持現狀**(ARCHITECTURE D26) |
| k | **Gateway 防提權缺口(High,兩個)** | `bff/src/modules/admin/rbac.ts`:① `PUT /api/admin/roles/:id/permissions` 不檢查操作人是否擁有要加入的權限,持有 `gw.admin.rbac.write` 者可把任意權限加進自己所屬的角色(例如 `employee`);② `POST` / `PATCH /api/admin/roles/:id/rules` 沒有保護 `gw-super-admin` 也沒有權限檢查,可建「自己的部門 → gw-super-admin」規則升為超級管理員。修法見 Gateway !21 描述;屬 Gateway repo |
| l | 超級管理員可以寫入 NetOps | `gw-super-admin` 補了 `netops.*`(!21),所有超級管理員都能 FTP 同步 / 分析 / 刪除分析結果、編輯知識庫;成員有 AD 群組對應時群組內每個人都有 |

**之後**:工作區 `GigaNexusAIPlan/architecture/` 的 NetOps 狀態(`deployment.json` 的 CI、`workspace.json` 4 條 `planned` 關係)要更新為已上測試區,屬於工作區 repo。

## 2026-11-04 D1 測試區部署(紀錄:MR 審查與合併順序)

**已完成**
- F1 與 Gherkin(!12–!23)已合併進 `develop`。
- D1 三個 MR 已開,待合併:NetOps !24(CI 發佈 SPA、`gateway-rbac.yaml`、監控 Key、知識庫 NAS 備份)、Gateway !20(Nginx `/netops/`、`deploy/gateway-apps.yaml`)、giga-observe !3(拓樸)。都經 `code-reviewer`、`security-auditor` 審查並修正。

**合併順序**(各 MR 描述有合併前後要做的事與預期輸出)
1. Gateway !20 → develop。
2. giga-observe !3 → main,在主機 2 `git pull` 並重啟 `gno-backend`。
3. 在主機 2 以 root 執行本分支的 `deploy/host2-set-secrets.sh`(建 ingest Key)與 `deploy/host2-setup-kb-backup.sh`(NAS 目錄與標記檔),再合併 NetOps !24 → develop。
4. `rbac-test` 成功後,套用 Gateway 的 `deploy/gateway-apps.yaml`;到 GigaItApp 把 `netops-admin`、`netops-viewer` 指派給測試帳號。
5. 驗證:三種帳號看 `/netops/`(無權限導回 `/?denied=netops`);走登入 → 總覽 → 明細 → 知識庫;架構觀測看得到 `netops-api` 心跳與紀錄;NAS 上有當天的知識庫備份。
6. 本文件 MR 在 !24 之後合併。

**新的待決定事項**(審查提出,這次沒有處理)

| # | 事項 | 說明 |
| --- | --- | --- |
| g | `spa-netops` 以 root 掛整個 `gw_www` | 同 GigaItApp、giga-Portal。只掛 `netops` 子目錄要用 Compose `volume.subpath`(Docker 26+),要先確認主機版本 |
| h | 知識庫備份是明文 | 放在附件服務共用的 NAS 分享 `docker-folder`;要不要獨立帳號 / ACL 或加密 |
| i | PA、AD 的 FTP 管理按鈕共用 `netops.ftp.write` | B1 的 API 設計;預設兩個角色不受影響,單獨指派按鈕時權限比預期大 |
| j | ~~viewer 可以查詢並匯出 Log 明細~~ | **2026-11-09 決定:可以,維持現狀**(ARCHITECTURE D26) |

待決定 a(CI Runner 只跑受保護分支)的影響變大:D1 後 develop 的 job 會寫 `gw_www` 與 Gateway RBAC。

**之後**:工作區 `GigaNexusAIPlan/architecture/` 的 NetOps 狀態(`deployment.json` 的 CI、`workspace.json` 4 條 `planned` 關係)要在 D1 驗證後更新,屬於工作區 repo。

## 2026-11-03 收工(紀錄)

**已完成**
- B0、B1、B2 全部合併(!4、!7–!11)並部署測試區:`netops-api` 經 Gateway 可用,新版機密腳本已執行、路由已發佈、權限已指派;容器內 FTP 可用;!11 的測試區驗證(明細筆數、匯出、取消後匯入繼續)通過。
- F1 前端與 Gherkin 行為規格的 MR 已開、待合併。

**明天的合併順序**
1. F1 堆疊:!12 → !13 → !14 → !15 → !16 → !17 → !19 → !21(F1 文件)→ 本 MR(收工文件,依賴 !21)。
2. 不依賴上面的順序:!18(Gherkin 行為規格)可以獨立合併;!20(DELETE 在 OpenAPI 宣告 204)→ !22(FTP 錯誤訊息修正)要依序合併(兩者都改 `BackendCorrection.md`,!22 已合併 !20 的分支)。
3. 每批合併後在 GigaItApp「服務與路由」發佈有變動的路由草稿。

**下一步:D1 測試區部署**(IMPL-PLAN D1)
- Gateway 的 Nginx `/netops/` location、`gw.app` 登記、`.gitlab-ci.yml` 加 SPA 部署 job、`gateway-rbac.yaml` 登記畫面代碼、giga-observe 拓樸與 ingest Key。
- Gateway 與 giga-observe 是其他 repo,**動手前要使用者同意**(AGENT.md §3)。

**待使用者決定**

| # | 事項 | 說明 |
| --- | --- | --- |
| a | CI Runner 只跑受保護分支 | `check:*` 在所有分支用主機 2 的 shell executor 執行,讀得到主機上的 npm Token;機密檔為 uid 1000 所有。要不要限定受保護分支或改 docker executor(B0 既有) |
| b | FTPS | FTP 帳密與 log 目前明文傳輸(沿用舊版)。確認 FTP 伺服器支援 FTPS 後才能設 `FTP_SECURE=1` |
| c | `.gz` 提早結束 | 舊版 `readLog` 讀 `.gz` 時,來源比解壓先關閉會提早結束(測試可重現;FTP 分段串流正常)。依 D4 沒改核心;FTP 上是否有 `.gz` 未確認。要不要另開修正(新舊兩邊一起改) |
| d | 舊版 NetOps 正式網址 | F1 先用 `https://gsmc-web.gigasolar.com.tw/NetOps`(`frontend/src/config/links.ts`),AI 問答連結依賴它 |
| e | F1 新增的 UI 元件 | `GStackedBars` 等要不要回饋到入口網與 GigaItApp(跨 repo) |
| f | 知識庫匯整檔可被偽造成另一則筆記(Low) | 筆記內容可用 setext 標題或手寫「- 記錄:」做出像另一則筆記的段落;各筆記欄位不受影響。修了會改匯整檔格式(與舊版不同) |

**提醒**:舊版知識庫(`uploads/knowledge`)不可重建,D14 複製前**先備份**(NAS 備份規劃見 ARCHITECTURE Q3)。

## 目前進度

**B0 最小骨架部署完成**(2026-11-03,NetOps !4 合併,`develop` e53f8da;測試區四項完成條件驗證通過)。`backend/` 有內部 Token 驗證、統一錯誤格式、`/healthz`、`/readyz`、`/openapi.json`、`setupGateway` 與驗證路由 `GET /api/netops/ping`(`netops.ping.read`);CI 只部署 `netops-api` 到主機 2。舊版繼續在 IIS 運作。**這次不改寫 AI 功能**,未來由 AI 中控台提供,切換後舊版留著給 AI 用(D17、D18)。負責人:佳緯。

**D1 測試區部署完成(有未驗項目)**(2026-11-04):前端 `/netops/` 經 Gateway 可用,畫面權限、應用切換、監控、知識庫 NAS 備份上線;見最前面「2026-11-04 收工」。

**F1 前端完成**(2026-11-04 全部合併):`frontend/` 由入口網複製 `src/ui/`、外框與守衛,換工程藍;全部頁面改寫並串接後端:FTP Log 檔案(PA、AD,!12)、AD 事件總覽(!13)、安全事件(!14)、流量總覽(!15)、Log 明細查詢(!16,PA 工作模式)、知識庫(!17,Markdown 經 DOMPurify)、收尾(!19)。MR 堆疊,依 !12 → !13 → !14 → !15 → !16 → !17 → !19 → 本文件 MR 的順序合併。AI 功能(問答、分析、知識庫語意搜尋與自動學習)改連結到舊版(D17、D18),舊版網址在 `frontend/src/config/links.ts` 待確認。舊版 `src/`、`server/` 依 D12、D18 保留。`netops.*` 畫面代碼要到 D1 才登記,測試區看畫面用 `DEV_EXTRA_PERMS` 或本機假 Gateway(`MOCK`);前端 SPA 部署屬 D1。

## 下一步

1. 確認 GitLab 已保護 `develop`(只有 Maintainer 能合併、不能直接推送);現有 Token 沒有 Protected Branch 讀取權限,要在 GitLab 畫面確認。
2. B1、B2 前兩批已合併(!7、!8、!9)並部署測試區(#640,`netops-api:e51b24f7`;新版機密腳本已執行、路由已發佈、權限已指派);瀏覽器經 Gateway 呼叫 `/api/netops/ftp/pa/files` 列得出檔案,容器內 FTP 可用。
3. B2 後兩批已合併(!10、!11)並在測試區驗證;後續修正 !20、!22 待合併。

## 已知狀況

- 主機 2、3 的 Windows 端 TCP 連得到 FTP;主機 2 測試區容器內已確認可用(2026-11-03),主機 3 未驗證。
- 測試區:`netops-api` 容器 `giganexus-netops-test-netops-api-1` 在主機 2 運作(Gateway 網路,未發佈 port);機密在 `/srv/giganexus/netops-secrets/`、變數在 `/srv/giganexus/deploy/netops.env`(`deploy/host2-set-secrets.sh` 產生)。
- `netops.ping.read` 目前指派給 `it-admin` 角色(2026-11-03);D2 上線時依 D15 重新指派。GigaItApp 中 `gw-it-admin` 與 `it-admin` 名稱相近,指派時注意。
- B0 監控 Key 為空檔,監控停用;D1 登記 giga-observe 拓樸後補上。
- 舊版關閉知識庫寫入的做法還沒確認(IMPL-PLAN D2)。
- `scripts/dc/ADLog-FtpBackup-3.ps1` 寫死 FTP 帳號名稱,密碼走憑證檔,版控內沒有密碼。
- 資料庫是後續階段,不在這次範圍(ARCHITECTURE §4.2)。
- 舊版 `palog.js` 的 `readLog` 讀 `.gz` 時,若來源串流比解壓先關閉會提早結束(測試以 `Readable.from` 一次送完整個檔案時重現,讀到 0 筆);FTP 串流分段送時正常。核心照 D4 原封不動搬移,沒有修改;FTP 上目前是否有 `.gz` 檔、實際是否受影響未確認。
