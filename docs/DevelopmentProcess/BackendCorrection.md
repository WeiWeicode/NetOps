# 後端修改紀錄

> `backend/`、`deploy/` 的修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-05 R1 API:`netops-api` 讀 netops-redis(`infra/redis`、`modules/pa-live`)
- 工作項目:R1
- 內容:`infra/redis/index.ts`(ioredis 5.11.1,Gateway TECH-STACK 已列;鍵格式同 `pa-collector/netops_pa/keys.py`,只在這裡組鍵;不排隊、3 秒逾時;連線錯誤限頻 warn)。`modules/pa-live/service.ts`:收集器狀態(心跳超過 30 秒 = stopped、兩個開關都關 = disabled、輪詢或 Redis 錯誤 = degraded、Redis 連不上 = unavailable;停止時不回舊快照)、快照、趨勢、排行合併、最新 log 掃描與篩選;心跳的錯誤原文只回分類。`live-routes.ts`:`GET /v1/pa-live/{snapshot,series,top,logs,stream}`,權限 `netops.pa-realtime.read`;`logs`、`stream` 設 `x-audit-level: meta`;SSE 照 S0 規則(`x-timeout-ms` 60000、立即送 open、心跳 15 秒、429、`preClose`),單一連線最長 5 分鐘,`Last-Event-ID` 游標接續(超過 5 分鐘不接續)。Redis 連不上時 `snapshot` 回 200 `unavailable`、其他回 **424**(不用 5xx:BFF 斷路器把上游 5xx 計為失敗)。`config.ts` 新增 `REDIS_URL`(test / prod 必填)。依 `code-reviewer`、`security-auditor` 審查修正(SSE 各類型分開處理失敗並送 `degraded`、ReplyError 與連線錯誤分開、`before` 拒絕 `0-0`、未知維度回 400、慢用戶端中斷底層連線、日誌)。
- 檔案:`backend/src/infra/redis/index.ts`、`backend/src/modules/pa-live/{service,live-routes}.ts`、`backend/src/{app,config,openapi}.ts`、`backend/test/fixtures/fake-redis.ts`、`backend/test/unit/pa-live-r1.test.ts`、`docs/API.md` §3.2、`docs/Gherkin/pa-live/realtime.feature`
- 驗證:`npm run typecheck`、`npm test`(148 passed)、`npm run build`;`check-scenarios.mjs` 69 / 69

## 2026-11-05 R1 部署:netops-redis、netops-pa 加入 Compose 與 CI(測試區)
- 工作項目:R1、R0
- 內容:`deploy/docker-compose.yml` 新增 `netops-redis`(redis:7.4-alpine,`maxmemory` 2 GB、`noeviction`、RDB 開 / AOF 關、named volume,只在 `internal: true` 的 `netops-internal` 網路,不對主機開 port)與 `netops-pa`(唯讀根目錄、tmpfs /tmp、cap_drop ALL、日誌輪替;port 51293 / 51294 只綁 WSL `127.0.0.1`;`PA_POLL_ENABLED` / `PA_RECEIVE_ENABLED` 預設 0);`netops-api` 加 `REDIS_URL` 與 `netops-internal` 網路。CI `deploy-api-test` 檢查機密、建置(`--pull`)並啟動兩個容器、確認 `noeviction`。新增 `deploy/host2-set-pa-secrets.sh`(Token 自動產生、API Key 隱藏輸入,可先留空)。新增 `docs/PA-FORWARDING-SPEC.md`(給網通:唯讀角色與 API Key、HTTP / Syslog Server Profile、各類型 payload 欄位對應、Log Forwarding Profile;附錄 F 主機端 portproxy、防火牆、開啟步驟)。
- 檔案:`deploy/docker-compose.yml`、`.gitlab-ci.yml`、`deploy/host2-set-pa-secrets.sh`、`deploy/test.env.example`、`docs/PA-FORWARDING-SPEC.md`、`docs/PA-LIVE-PLAN.md` §9
- 依 `security-auditor` 審查修正:Compose 帶入憑證設定(`/srv/giganexus/netops-pa-tls` 唯讀掛載,`PA_CA_FILE`、`PA_TLS_*`、`PA_RECEIVE_PLAINTEXT`)、Redis `cap_drop` 與 `stop_grace_period`、CI 先建置 netops-pa 並檢查 AOF / RDB / maxmemory、腳本 trap 順序、規格的 API Key 產生指令(密碼從標準輸入、驗證憑證)、Syslog 安全限制與主機 3 防火牆注意事項(附錄 F.4.1)、手動重建改用 CI 映像。
- 驗證:`docker compose -f deploy/docker-compose.yml config` 通過(本機無 Docker daemon,未實際啟動;CI 部署時驗證);`.gitlab-ci.yml` 以 YAML 解析器確認
- 2026-11-09 補充(準備接真的 PA-560):`docs/PA-FORWARDING-SPEC.md` 加入管理介面 Permitted IP Addresses(A.0)、憑證 SAN 規則(用 IP 連線時 SAN 要有該 IP)、附錄 F.4 改為先查憑證 SAN 再用 `python -m netops_pa check` 檢查後才打開輪詢、新增 G 節「請網通回覆的資訊」清單

## 2026-11-05 R1 收集器 `pa-collector/`(netops-pa)
- 工作項目:R1
- 內容:新增 Python 3.12 服務 `netops-pa`(PA-LIVE-PLAN §3.1):① SDK 輪詢(`PA_POLL_ENABLED`):pan-os-python 只執行白名單內 4 個 `show` op 指令(D22),寫快照 `netops:pa:snap:*`(60 秒 TTL)與趨勢 `series`(2 天);pan-os-python 預設不驗證 HTTPS 憑證,改為自帶 `ssl_context` 預設驗證(`PA_CA_FILE`;`PA_TLS_INSECURE` 只限 dev / test)。② HTTP 接收 :51293(`POST /v1/logs/{type}`,TRAFFIC 以外,`X-NetOps-Token` 固定時間比對)與 Syslog 接收 :51294(TCP / 選用 TLS 與用戶端憑證,只收 TRAFFIC,換行與長度分框),由 `PA_RECEIVE_ENABLED` 控制;只接受 `PA_ALLOWED_SOURCES`;單則與本文長度、同時連線數、閒置逾時、HTTP 與 Syslog 各自的速率上限、Syslog 最多用佇列 80%;畸形輸入只計數。③ 批次寫 Redis:Stream(MINID 精確修剪 + MAXLEN 上限 + EXPIRE)、每分鐘 Hash 與排行(TTL;排行每分鐘留前 200)、心跳 `netops:pa:heartbeat`(輪詢、接收、Redis 的最後成功時間與錯誤、計數)。保留時間依 D21。欄位 key 沿用舊版 `palog.js` / `paevents.js`。錯誤訊息遮罩 API Key / Token。CI 新增 `check:pa-collector`(Docker test 階段跑 ruff + pytest)。依 `code-reviewer`、`security-auditor` 審查修正(JSON 深層巢狀與超長整數、Redis 錯誤清除、Stream 過期、Hash 計數值上限、日誌限頻、工作執行緒結束時程序結束重啟、正式區接收端點預設要求 TLS)。
- 檔案:`pa-collector/`、`.gitlab-ci.yml`
- 驗證:`ruff check .` 通過;`pytest` 68 passed(假 PA XML API + 真正的 pan-os-python、fakeredis;本機 Python 3.14,CI 為 3.12)
- 2026-11-09 補充(需求方取得 PA-560 唯讀 API Key,準備接真的 PA):新增 `python -m netops_pa check`(`check.py`):容器內跑一次唯讀查詢(`show system info` 印型號、PAN-OS 版本、序號後 4 碼,加 4 個輪詢指令),不寫 Redis、不需打開 `PA_POLL_ENABLED`;失敗時提示可能原因(憑證 SAN、API Key / 角色權限、網路或 Permitted IP、版本);Key 不印出。HTTP 接收端點回錯誤前讀掉未讀的本文(不讀就關閉時,Windows 與 PA-560 可能收到 RST 而看不到錯誤碼;本機測試偶發失敗即此原因)。`pytest` 72 passed(連跑 3 次)。依 `security-auditor` 審查修正:`check` 也把 SDK 日誌壓到 WARNING、檢查 `GW_ENV` 只能是三個部署區、`show system info` 改經唯讀白名單(`CHECK_COMMANDS`)、設備字串去掉控制字元、建立連線失敗時遮罩後回結束碼 2;拒收時最多讀掉 64 KB 本文(超過直接關閉),keep-alive 每個請求重設狀態

## 2026-11-05 S0 串流驗證路由 `GET /v1/pa-live/stream-test`
- 工作項目:S0
- 內容:`modules/pa-live/routes.ts`:SSE(`PassThrough` 串流交給 Fastify,保留 hook 與監控);立即送 `retry` 與 `open`,每 15 秒 `heartbeat`(`id` 為序號,`data` 含 seq、伺服器時間、connectionId);`Last-Event-ID` 只接受正整數,接續序號;單一連線 10 分鐘;每人 2 條、全系統 20 條(超過 429 `NETOPS_STREAM_BUSY`;不用 5xx,因為 BFF 斷路器會把上游 5xx 計為失敗);用戶端在驗證 Token 期間已斷線時不建立串流;待送資料超過 64 KB 中斷;用戶端斷線、最長時間到與服務關閉(`preClose`,`onClose` 時 server 已在等候長連線)時清除計時器。OpenAPI 設 `x-timeout-ms: 60000`(BFF undici `bodyTimeout` 是閒置時間,大於心跳即可長連線)、`x-permission: netops.ping.read`(驗證用、不綁畫面,不新增權限、不改 `gateway-rbac.yaml`)。`buildApp` 的 `deps.streamTest` 只給測試縮短間隔。`scripts/sse-probe.mjs`:經 Gateway 連線,記錄事件到達時間、間隔、伺服器時間差、斷線與重連,結束時判定(不被緩衝、事件間隔含最後空窗、事件數、單一連線 65 秒、5 分鐘、重連序號接續);Cookie 由提示輸入(不回顯)或環境變數,不印出;只送到 https 的 GigaNexus 網域、不跟隨轉址;401 / 403 / 404 / 429 直接結束,連續 3 次錯誤停止重連。依 `code-reviewer`、`security-auditor` 審查修正。
- 檔案:`backend/src/modules/pa-live/routes.ts`、`backend/src/app.ts`、`backend/test/helpers.ts`、`backend/test/unit/pa-live.test.ts`、`backend/scripts/sse-probe.mjs`
- 驗證:`npm run typecheck`、`npm test`(125 項通過,新增 7 項)、`npm run build`;以本機假 Gateway 跑 `sse-probe.mjs`(心跳縮短)確認主動斷線後以 Last-Event-ID 重連;另以 BFF 使用的 undici 8.11.2 確認 `bodyTimeout` 是資料塊之間的閒置時間

## 2026-11-05 D1 驗收修正:測試區 FTP_LOG_DIR、FTP 清單不列系統資料夾、知識庫備份 healthcheck
- 工作項目:D1(驗收報告 `docs/test-reports/2026-11-05-d1-uat-pending.md` §3.1、§4.1、§5.4)
- 內容:① 測試區 TRAFFIC 在 FTP `/my-data`,`FTP_LOG_DIR` 沒設定(預設 `/`)時永遠無法分析;依需求方決定寫進部署設定:`.gitlab-ci.yml` `deploy-api-test` 加 `FTP_LOG_DIR: /my-data`(Compose 以 shell 環境變數優先,蓋過主機 `netops.env`)。compose 本身不寫值(正式區共用);正式區的值寫進 IMPL-PLAN D2 待確認。② `infra/ftp` 的列目錄不回 `$RECYCLE.BIN`、`System Volume Information`(不分大小寫;`isSystemEntry`),PA 瀏覽、同步與 AD 清單共用。只過濾清單,不擋路徑。③ `netops-kb-backup` 加 healthcheck:`/backup/LAST_RESULT` 26 小時內更新過且為 OK(FAIL、NAS 未掛載不寫結果、超過一天沒備份都會 unhealthy);interval 30 秒、start_period 5 分。CI 的 `up -d --wait` 會等 healthy,備份失敗時 `deploy-api-test` 失敗。
- 檔案:`.gitlab-ci.yml`、`deploy/docker-compose.yml`、`deploy/test.env.example`、`backend/src/infra/ftp/index.ts`(`toEntries`)、`backend/src/modules/ftp/routes.ts`(x-gherkin)、`backend/test/unit/ftp.test.ts`、`docs/API.md` §5、`docs/Gherkin/ftp/*.feature`
- 驗證:`npm run typecheck`、`npm test`(118 項通過,新增 2 項)、`npm run build`;`check-scenarios.mjs` 無問題(順帶修正既有的來源行號);healthcheck 指令以本機 shell 驗證 6 種情況(alpine busybox 的 `find -mmin` 未在容器內實測,合併後看 CI)

## 2026-11-04 D1:測試區部署前端、畫面權限、監控 Key、知識庫 NAS 備份
- 工作項目:D1
- 內容:① `.gitlab-ci.yml` 新增 `deploy-web-test`(建置 `spa-netops` 並發佈到 Gateway 的 `gw_www/netops`,冒煙測試確認 `/netops/` 與深層路由回本系統的 index.html)與 `rbac-test`(以測試區 Gateway 映像套用 `deploy/gateway-rbac.yaml`),做法同 GigaItApp、giga-Portal。② `deploy/gateway-rbac.yaml`:ARCHITECTURE §5 的應用、3 個選單目錄、8 個選單、3 個按鈕(`includes` 綁 API 權限,與前端 `requires` 一致)與角色 `netops-admin`、`netops-viewer`(不指派成員,D15);路由由服務自動註冊,不另寫 `gateway-routes.yaml`(B0 決定;`apply` 會把已發佈的路由打回草稿)。③ `deploy/host2-set-secrets.sh`:`monitor_api_key` 是空檔時改以 giga-observe `createApiKey.js` 建立 ingest Key(服務 `netops-api`)。④ 知識庫 NAS 備份(Q3):compose 新增 `netops-kb-backup`(`deploy/kb-backup/`,alpine,唯讀掛資料目錄、不連網路),每天 2 點把 `knowledge/` 打包到 NAS `docker-folder/giga-netops/<區>`,核對檔數、寫 `.sha256`、保留 30 份;沒有標記檔 `.giga-netops-backup` 時不寫入;目錄與標記檔由新的 `deploy/host2-setup-kb-backup.sh` 建立(沿用附件服務的 NAS 掛載,不經手 NAS 帳密)。
- 檔案:`.gitlab-ci.yml`、`deploy/docker-compose.yml`、`deploy/gateway-rbac.yaml`、`deploy/apply-gateway-rbac.sh`、`deploy/host2-set-secrets.sh`、`deploy/host2-setup-kb-backup.sh`、`deploy/kb-backup/{Dockerfile,backup.sh}`、`deploy/test.env.example`
- 配合:Gateway `feature/netops-spa`(Nginx `/netops/`、`gw.app`)、giga-observe `feature/topology-netops`(拓樸)
- 審查後:`apply-gateway-rbac.sh` 套用前檢查範圍(頂層只能有 permissions / roles,代碼、includes、角色權限都要是 `netops.*` / `netops-*`,不得有 adGroups / companies;CLI apply 本身不限系統);監控 Key 寫入後立即 chown / chmod,取不到 Key 時不印 createApiKey 的輸出;`publish.sh` 驗證版本名稱、回滾排除 `.tmp`;`netops-kb-backup` 加 `init`、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`,啟動時清掉中止留下的 `.part`,整點比較改數值(`KB_BACKUP_HOUR=0` 原本永不觸發);CI 冒煙測試不再用 `A | B && echo`(左側失敗不會讓 job 失敗,含既有的 `/v1/ping`);`deploy-web-test` 加 `needs: [deploy-api-test]`(同一個 compose project 不同時執行);`netops-kb-backup` 以 `--wait` 啟動
- 驗證:見 MR 描述

## 2026-11-03 FTP 錯誤訊息不外露主機與原始錯誤
- 工作項目:B2(F1 的 security-auditor 指出;!11 已記錄同類問題)
- 內容:`infra/ftp` 的 502 `NETOPS_FTP_UNAVAILABLE` 原本把 basic-ftp 的原始錯誤(可能含 FTP 主機 IP 與 port,例如 `connect ECONNREFUSED 10.10.130.66:21`)接在訊息後面,經 API 回應、匯入狀態 `lastSyncError`、FTP 檔案清單的 `error` 與工作的 `error.message` 傳給有 `netops.ftp.read`、`netops.pa-log.read` 的人。改成只回分類過的原因(`ftpReason`:逾時、拒絕連線、找不到主機、連線中斷、TLS、FTP 回應碼),原始錯誤放在 `cause`,由錯誤處理、匯入與工作的日誌寫出。FTP 路徑照舊(畫面上本來就看得到)。
- 已知:修正前已寫進分析狀態的錯誤訊息(測試區,以及 D14 從舊版複製的資料)維持原文,重新分析或同步後覆寫。
- 檔案:`backend/src/infra/ftp/index.ts`、`backend/src/app.ts`、`backend/src/infra/jobs/index.ts`、`backend/src/modules/{pa,pa-events,ad}/importer.ts`、`backend/test/unit/{ftp,jobs}.test.ts`、`docs/API.md` §8
- 審查後:分析狀態的 `errorText` 改白名單(已分類的 AppError、核心格式錯誤、「FTP 傳輸不完整」照實,其他回固定訊息);檔案大小上限改固定文字;外部錯誤(帶 cause)才在錯誤處理寫 error 日誌,預期內的 503 不記;自動同步失敗不重複記錄;TLS 只比對 Node 的錯誤碼。
- 驗證:`npm run typecheck`、`npm test`(116 項通過,含連到本機未開的 port,確認訊息不含主機與 port)、`npm run build`;`security-auditor`(無 High / Medium)、`code-reviewer`(無必修)審查後修正

## 2026-11-03 冪等 DELETE 在 OpenAPI 宣告 204
- 工作項目:B2(Gherkin 規格比對時發現,docs/Gherkin/README.md §7 #6)
- 內容:`DELETE /v1/pa/log-searches/:id`、`/v1/ftp/ad/listings/:id`、`/v1/kb/notes/:id` 實際回 204,但路由沒有宣告,OpenAPI 只有預設的 200;補上 `response: { 204 }`(`shared/schemas.ts` 的 `NO_CONTENT`)。行為不變。
- 檔案:`backend/src/shared/schemas.ts`、`backend/src/modules/{pa/log-routes.ts,ftp/ad-routes.ts,kb/routes.ts}`、`backend/test/unit/app.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`

## 2026-11-03 B2-logs:PA Log 明細查詢與匯出(工作模式)
- 工作項目:B2
- 內容:`scan.js` 搬到 `pa/core/scan.js`,只把 `openStream` 改成由呼叫端注入(其餘逐字相同);篩選沿用 `palog.js` 的 `buildFilter`、`buildPrefilter`。舊版 `POST /palog/search` 同步等待最長 180 秒,改成工作模式(D6):`POST /v1/pa/log-searches`(202)、`GET /v1/pa/log-searches/:id`(狀態只回摘要)、`/rows`(分頁)、`/export`(伺服器端 CSV,舊版在前端產生)、`DELETE`(取消並中斷 FTP 掃描,冪等 204)。工作只有本人可查;期間最長 31 天;與匯入共用 FTP 連線上限。審查後:IP 條件只允許 IP 字元、`*` 最多 4 個且連續合併(舊版大量 `*` 會讓正規表示式比對卡死整個服務,核心不改、在路由擋);明細查詢同時只執行 1 個、每人保留 5 筆結果,已完成的工作取消即丟棄結果;掃描結束一律中止還在排隊或佔 FTP 連線的 worker,等不到連線超過掃描秒數時回部分結果(`timeout`),匯出檔名標「_不完整」。
- 檔案:`backend/src/modules/pa/{core/scan.js,log-routes.ts}`、`backend/test/unit/logs.test.ts`、`backend/test/fixtures/fake-ftp.ts`
- 驗證:`npm run typecheck`、`npm test`(110 項通過,含同一批假 log 以舊版 `scan.js` 原封不動執行,5 組條件的結果列與新版完全一致)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B2-kb:知識庫
- 工作項目:B2
- 內容:舊版 `kb.js` 的解析、序列化、欄位整理、匯整檔與關鍵字查詢搬到 `modules/kb/core/notes.js`(內容不變,不含檔案讀寫);讀寫改由 `store.kb`(位置與格式同舊版 `uploads/knowledge`,D14)。新增 API:`/v1/kb/notes`(GET 分頁、POST)、`/v1/kb/notes/:id`(GET、PUT、DELETE)、`/v1/kb/notes/:id/markdown`、`/v1/kb/compilation`。與舊版不同:編輯權限改由 BFF 依 `netops.kb.write` 檢查(不再用 `KB_ADMINS`)、記錄人為 Gateway 身分「工號 姓名」、回應不含 `admin`、刪除冪等(204)、內容超過 20,000 字回 400(舊版截斷)。審查後(資安修正,與舊版不同):標籤與寫出的每個欄位都壓成一行、標題與標籤含換行回 400(舊版標籤內含換行可偽造記錄人與建立時間);新增時代號重複會重新產生、不覆蓋;筆記上限 5,000 則;下載加 `X-Content-Type-Options: nosniff`;匯整檔重產失敗不讓已寫入的筆記回 500。語意搜尋、向量同步、外部 IP 自動學習、`notesForAi` 不搬移(D17)。
- 檔案:`backend/src/infra/store/kb.ts`、`backend/src/modules/kb/`、`backend/test/unit/kb.test.ts`
- 驗證:`npm run typecheck`、`npm test`(100 項通過,含同一批筆記以舊版 `kb.js` 原封不動執行比對解析、查詢、匯整檔、新增結果一致)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B2-ad:安全事件、AD 事件與 FTP Log 檔案(AD)
- 工作項目:B2
- 內容:`adlog.js` 逐字複製;`adimport.js` 改寫成 TypeScript(讀寫只經 `store.ad`;一天的資料檔格式與簽章同舊版,複製舊資料後不會被誤判為已變更)。新增 API:`/v1/pa-events/{types,overview}`、`/v1/ad/{days,overview,events,events/export}`、`/v1/ftp/ad/{listings,listings/:id,status,syncs,imports,result-deletions}`。與舊版不同:AD 清單改工作模式(本人才能查、可取消);同步與重新匯入背景執行回 202,同步中回 409;列目錄與下載共用同一條 FTP 連線(舊版同時開兩條);明細查詢改分頁、期間最長 31 天;新增伺服器端 CSV 匯出(上限 20,000 筆,公式字元加 `'`);AD 下載單檔上限 64 MB;安全事件總覽多 `missing`。審查後:總覽與選項期間最長 92 天(PA、安全事件、AD);多人同時的 AD 清單共用同一次 FTP 列表;背景同步失敗寫日誌;沒有設定 FTP 時同步回 503;`/ad/days` 不回同步錯誤細節(細節在 `ftp.read` 的 `/ftp/ad/status`);CSV 公式字元也處理全形與前置空白。AI 用的 `adContext`、`eventsForIps` 等不搬移(D17)。
- 檔案:`backend/src/infra/store/ad.ts`、`backend/src/modules/{ad,pa-events/routes.ts,ftp/ad-routes.ts}`、`backend/src/shared/csv.ts`、`backend/test/unit/ad.test.ts`、`backend/test/fixtures/fake-ad.ts`
- 驗證:`npm run typecheck`、`npm test`(86 項通過,含同一批假匯出檔與舊版的匯入事件、總覽、明細篩選、安全事件總覽完全一致,舊版簽章的資料不會重新匯入)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B2-pa:FTP、PA 匯入與流量總覽
- 工作項目:B2
- 內容:`infra/ftp` 由舊版 `lib/ftp.js` 搬移(唯讀;匯入與明細查詢共用 `FTP_MAX_CONNECTIONS` 連線上限,舊版兩者各自開連線)。`palog.js`、`paevents.js` 逐字複製(`allowJs`);`flows.js` 只搬累計與輸出格式,寫檔改由 `infra/store`。`importer.js`、`paevimport.js` 改寫成 TypeScript(流程不變,讀寫只經 `store.pa` 的具名函式;分析中途被取消時不再誤標成功)。新增 API:`/v1/pa/{days,overview,options}`、`/v1/ftp/pa/{files,status,syncs,analyses,result-deletions}`;同步改背景執行回 202。總覽多 `missing`(摘要讀不到的檔案數)。
- 與舊版不同(審查後修正):讀取失敗(例如標頭不對)時立即中斷 FTP 傳輸並釋放連線(舊版留著連線);分析 API 只接受 TRAFFIC 與各類型目錄下的 log 檔,大小與修改時間改取 FTP 實際值(舊版信任畫面傳入,`modified` 格式錯誤會讓程序結束);分析佇列上限 5,000;畫面瀏覽優先拿 FTP 連線、最多等 25 秒(503 `NETOPS_FTP_BUSY`);取消可中斷等候中的連線;寫檔失敗的訊息不帶本機路徑;只有瀏覽 TRAFFIC 目錄時才比對搬移;路徑含控制字元回 400;FTP 連線逾時 30 → 20 秒;列目錄失敗 404 → 502;關閉服務時等分析中的檔案停止再寫入狀態。
- 檔案:`backend/src/infra/{ftp,store/pa.ts}`、`backend/src/modules/{pa,pa-events,ftp}/`、`backend/src/shared/`、`backend/test/unit/pa.test.ts`、`backend/test/fixtures/`
- 驗證:`npm run typecheck`、`npm test`(70 項通過,含同一批假 log 與舊版 `server/lib` 摘要、連線組合統計、總覽完全一致)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B1 後端骨架:資料存取、長時間工作與完整設定
- 工作項目:B1
- 內容:`config.ts` 新增資料目錄 `NETOPS_DATA_DIR`、FTP(密碼 `FTP_PASSWORD_FILE`,正式區只接受 `_FILE`)、同時連線上限與明細查詢上限;test / prod 缺少時啟動失敗,數字或規則寫錯也啟動失敗(舊版會靜默改用預設)。`infra/store` 建立資料存取邊界(目錄與舊版 `uploads/` 相同,D14),`/readyz` 改為檢查資料目錄可寫入。`infra/jobs` 工作只有建立者本人可查(比對工號)、每人 2 個 / 全部 6 個進行中(取消後等工作真正停止才釋放名額)、完成後保留 30 分鐘、有執行時間上限,重啟後回 `NETOPS_JOB_NOT_FOUND`。資料檔損壞時丟出錯誤(回 500 `NETOPS_DATA_CORRUPT`),不當成沒有資料。FTPS 預設驗證憑證(舊版一律不驗證,改成 `FTP_TLS_INSECURE=1` 才放寬,正式區不允許);正式區連同時設定明文機密也拒絕;匯入目錄必須在 `FTP_ROOT` 之下。映像檔設 `TZ=Asia/Taipei`(log 與知識庫時間沿用台灣時間)。`deploy/`:資料目錄掛載、FTP 變數與 `ftp_password` 機密;`host2-set-secrets.sh` 隱藏輸入 FTP 密碼並建立 `/srv/giga-netops/test`;CI 檢查 `ftp_password`。
- 檔案:`backend/src/config.ts`、`backend/src/app.ts`、`backend/src/infra/{store,jobs}/`、`backend/test/unit/{app,config,jobs}.test.ts`、`backend/Dockerfile`、`backend/.env.example`、`deploy/`、`.gitlab-ci.yml`、`docs/API.md`
- 驗證:`npm run typecheck`、`npm test`(43 項通過)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 建立 netops-api 骨架與測試區部署
- 工作項目:B0
- 內容:由 Gateway `samples/node-backend` 複製,`gateway.project = NetOps`、`SERVICE_CODE = netops-api`(設錯時啟動失敗)、port 51292;錯誤代碼改為 `NETOPS_*`;移除樣本的 `public` 免 Token 路徑。`@giganexus/backend-sdk` 改由 GitLab npm Registry 安裝。`deploy/docker-compose.yml` 加入 Gateway 網路、不發佈 port;`host2-set-secrets.sh` 比照 giga-Portal 建立 API Key,監控 Key 先留空檔(D1 補)。
- 檔案:`backend/src/`、`backend/test/unit/app.test.ts`、`backend/Dockerfile`、`deploy/`、`.gitlab-ci.yml`
- 驗證:`npm run typecheck`、`npm test`(11 項通過)、`npm run build`;本機啟動冒煙測試
