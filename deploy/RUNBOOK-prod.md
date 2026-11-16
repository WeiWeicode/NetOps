# NetOps 正式區部署手冊(主機 3,10.10.130.122)

> 第一段(本手冊 §1–§3、§5、§6):`netops-api`、前端 `/netops/`、`netops-redis`、`netops-kb-backup`。
> 第二段(§4,C6;等 E5、PA 憑證與專用帳號):`netops-clickhouse`、`netops-ingest`、`netops-pa`,只改開關,不改程式。
> 規則:主機 3 的舊系統不能受影響(工作區 `AGENT.md` §5)——不動 `:9443` 與既有防火牆規則;含密碼的步驟由需求方執行,AI 不經手。
> CI:`.gitlab-ci.yml` 的 `build-prod`(主機 2 建置推 Registry)→ `deploy-prod`(主機 3 手動)→ `rbac-prod`(主機 3 手動),只在 `main`。

## 1. 正式區 FTP 目錄(寫在 `.gitlab-ci.yml` `deploy-prod` 的 `variables`)

照舊版 IIS(repo 根目錄 `server/`)的設定。舊版 IIS 實際的 `server/.env` 不在 repo(`.gitignore`;AI 依 AGENT.md §7.5 不讀 `.env`),
下表取自範本 `server/.env.example` 與程式預設值 `server/config.js`,**需求方以 IIS 主機上的 `server/.env` 核對後再合併**;不同時改 `deploy-prod` 的值。

| 變數 | 值 | 出處 |
| --- | --- | --- |
| `FTP_ROOT` | `/` | `server/.env.example:28`;`server/config.js:44` 預設 `/` |
| `FTP_LOG_DIR` | `/my-data` | `server/.env.example:29`;`README.md:22`「PA traffic 在 `/my-data`」;測試區 `deploy-api-test` 同值(D1 驗收 §3.1) |
| `FTP_AD_DIR` | `/AD_Log_Backup` | `server/.env.example:80`;`server/config.js:69` |
| `FTP_THREAT_DIR` | `/threat` | `server/.env.example:31`;`server/config.js:57` |
| `FTP_URL_DIR` | `/url-filtering` | `server/.env.example:32`;`server/config.js:58` |
| `FTP_DATA_FILTER_DIR` | `/data-filtering` | `server/.env.example:33`;`server/config.js:59` |
| `FTP_WILDFIRE_DIR` | `/wildfire-submissions` | `server/.env.example:34`;`server/config.js:60` |
| `FTP_DECRYPTION_DIR` | `/decryption` | `server/.env.example:35`;`server/config.js:61` |
| `FTP_GLOBALPROTECT_DIR` | `/globalprotect` | `server/.env.example:36`;`server/config.js:62` |
| `FTP_USERID_DIR` | `/user-id` | `server/.env.example:37`;`server/config.js:63` |
| `FTP_PATTERN`(不設) | 程式預設(副檔名 csv、log、txt、gz) | `server/.env.example:38`、`server/config.js:47`;與 `backend/src/config.ts` 預設相同 |
| `FTP_MAX_CONNECTIONS`(netops.env) | `2` | AGENT.md §6;舊版 `FTP_PARALLEL=2`(`server/.env.example:41`) |
| `FTP_SYNC_MINUTES`(netops.env) | `0` | `server/.env.example:39`(舊版 IIS 繼續同步,D18) |

任一目錄變數空白時 `deploy-prod` 直接失敗(不落回程式預設值)。`FTP_HOST=10.10.130.66`、`FTP_USER` 由 `host3-set-secrets.sh` 寫入 `netops.env`。

## 2. 主機 3 一次性準備(需求方,依序)

腳本從開發機複製到主機 3(三支 `host3-*` 與它們呼叫的 `host2-set-clickhouse-secrets.sh`、`host2-set-pa-secrets.sh`、`host2-setup-kb-backup.sh`,放同一個目錄):

```powershell
ssh host3 "New-Item -ItemType Directory -Force C:/Users/user/netops-deploy"
scp deploy/host3-set-secrets.sh deploy/host3-set-clickhouse-secrets.sh deploy/host3-set-pa-secrets.sh deploy/host2-set-clickhouse-secrets.sh deploy/host2-set-pa-secrets.sh deploy/host2-setup-kb-backup.sh host3:C:/Users/user/netops-deploy/
```

在主機 3(`ssh host3` 後 `wsl`,以下在 WSL)。`C:\Users\user` 是 Windows 可寫的目錄,先複製到只有 root 能改的目錄再以 root 執行,並和 repo 的版本比對:

```bash
sudo install -d -m 700 -o root /root/netops-deploy
sudo install -m 700 -o root /mnt/c/Users/user/netops-deploy/*.sh /root/netops-deploy/
sudo sha256sum /root/netops-deploy/*.sh    # 和開發機 sha256sum deploy/<同名檔> 比對
getent passwd 1000 101                      # 記下讀得到機密的帳號(機密檔 uid 1000、ClickHouse 帳號檔 uid 101)
```

1. `sudo sh /root/netops-deploy/host3-set-secrets.sh`
   正式區 Gateway 發 `gw_api_key`(client `netops-api`;**正式區已有這個 client 時,先停下來確認**,重發會讓舊 Key 失效)、giga-observe-prod 發監控 Key;隱藏輸入 FTP 密碼、Qdrant API Key;輸入 FTP 帳號;
   建 `/srv/giga-netops/prod` 與 `/srv/giganexus/deploy/netops.env`(欄位說明 `deploy/netops-prod.env.example`)。
2. `sudo sh /root/netops-deploy/host3-set-clickhouse-secrets.sh`
   主機 3 重新產生 ClickHouse 三個帳號的密碼(第一段 `netops-api` 的 compose secrets 也要有檔案)。結尾印的「之後的 CI 部署(develop)」是共用腳本的訊息,正式區看本手冊 §4。
3. `sudo sh /root/netops-deploy/host3-set-pa-secrets.sh`
   產生 `pa_http_token`;PA API Key **還沒有專用帳號的 Key 就直接 Enter**(空檔,第二段再補)。
4. 知識庫 NAS 備份目錄:`sudo GW_ENV=prod sh /root/netops-deploy/host2-setup-kb-backup.sh`
   (腳本不分主機;主機 3 的 `/mnt/nas-docker` 是 `docker-backup` 分享,建立 `giga-netops/prod/` 與標記檔 `.giga-netops-backup`)。沒做這步 `deploy-prod` 會在 `netops-kb-backup` 失敗。
5. 確認(唯讀):`ls -l /srv/giganexus/netops-secrets /srv/giganexus/netops-secrets/clickhouse`、`cat /srv/giganexus/deploy/netops.env`(不含機密)。
6. 用完刪除 `C:\Users\user\netops-deploy\` 與 `/root/netops-deploy/`。

## 3. 上架順序(第一段)

1. **保留舊版**:在 `main` 打標籤(目前 `main` = `d07847c`,`develop` 已包含它,沒有只在 `main` 的 commit):
   ```bash
   git fetch origin
   git tag -a legacy-iis d07847c -m "舊版 IIS(正式區上架前的 main)"
   git push origin legacy-iis
   ```
   之後舊版 IIS 要重新發佈時:`git checkout legacy-iis` → `npm ci` → `npm run publish`(根目錄,同以前)。
2. 確認 GitLab(專案設定,不在 repo 內;資安審查 H1、M1、M2):
   - 專案 Registry 已啟用;Runner `host3-prod`(tag `prod-deploy`,Protected)已對 NetOps 啟用;`main` 為 Protected branch。
   - Environment `production` 設為 **Protected**(只有 Maintainer 能部署;可加部署核准);`rbac-prod` 也受它管(`action: prepare`)。
   - 「Prevent outdated deployment jobs」開啟;Pipeline variables 只允許 Maintainer 帶(`ci_pipeline_variables_minimum_override_role`)。
   - 建議:Protected container tags(或只讓 protected job 寫 Registry);`build-prod` 改用只跑 protected 分支的主機 2 Runner。
     `deploy-prod` 已比對 `build-prod` 推送時記下的 digest,tag 被覆寫會失敗,但仍建議從源頭擋。
3. §2 的主機 3 準備。
4. MR `develop` → `main`(需求方合併)→ pipeline 跑 `check:*`、`build-prod`(主機 2 建置推送 4 個映像)。
5. 手動 **`deploy-prod`**:拉同一 SHA 的映像 → `netops-api`(健康檢查、自動註冊正式區草稿)→ `netops-kb-backup` → `netops-redis` → 前端發佈 `/netops/` → 冒煙測試。
6. 手動 **`rbac-prod`**:套用 `deploy/gateway-rbac.yaml`(`netops.*` 畫面權限、`netops-admin` / `netops-viewer`;不指派成員)。
7. GigaItApp(正式區 `/it/`)「服務與路由」審查並**發佈** `netops-api` 草稿(含 `netops.ai.*`、`kb/*`、`pa-live/*`、`ai/explanations`、`ai/daily-summary`、`ip-names`、`ip-name-imports`;`pa-live/stream` 逾時 60000 ms;`pa-live/collector-control` 正式區回 403,可不發佈)→ 重跑 `rbac-prod` 補綁 includes。
8. 負責人在 GigaItApp 指派 `netops-admin`、`netops-viewer`;應用登記 `netops`(`/netops/`)若正式區還沒有,同 `portal` / `it` 的做法登記(Gateway / GigaItApp 配合)。
9. 驗證:`https://giganexus.gigasolar.com.tw/netops/` 登入、FTP Log 檔案、知識庫;舊系統 port 從主機 2 `tcp-check.ps1` 與開發機各測一次。
   新系統資料目錄與舊版 IIS 分開,第一段 `FTP_SYNC_MINUTES=0`、不跑每日同步:**AD 事件與 AI 問答(FTP 舊路徑)要先在「FTP Log 檔案」頁(PA、AD)手動同步才有資料**。
   要自動同步時由需求方決定分鐘數,改 `netops.env` 的 `FTP_SYNC_MINUTES` 後重跑 `deploy-prod`(與舊版 IIS 同時讀 FTP,連線上限 2)。
   知識庫筆記從舊版複製屬 D2 第 3 步(D14),不在本手冊。
   第一段沒有 ClickHouse:**流量總覽、安全事件、明細查詢、熱力圖在第二段前無法使用**(ARCHITECTURE D43,只查 ClickHouse),請使用者這期間繼續用舊版 IIS。

第一段 `deploy-prod` 在 `NETOPS_PA_PIPELINE=0` 時以環境變數固定:`NETOPS_AI_SOURCE=ftp`、`NETOPS_AI_DAILY_SUMMARY=0`、`NETOPS_ARCHIVE_ENABLED=0`、
`NETOPS_RECON_TIME=-1`(不對帳,所以也不跑每日同步)、`NETOPS_RECON_AUTO_BACKFILL=0`、`NETOPS_CH_SUMMARY_MINUTES=0`。

## 4. 第二段(C6):開啟 PA log 管線

前提:E5(主機 3 磁碟 20 GB 預留)核准;網通給專用 API 帳號的 Key;PA-560 管理介面換公司 CA 憑證;接收端點憑證(PF 附錄 F.6)或需求方決定明文接收。

1. **確認既有規則**:列出所有放行 51293 / 51294 的 Inbound Allow 規則(只讀),預期沒有任何一條(含 `Docker-WSL2-AllServices-TCP`,PF 附錄 F.4.1 末項);有的話先停下來回報,不要改它:
   ```powershell
   Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -contains '51293' -or $_.LocalPort -contains '51294' -or $_.LocalPort -eq 'Any' } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object DisplayName, Profile
   ```
   (`LocalPort` 是範圍字串時 `-contains` 比不到,結果中範圍型的規則要人工看。)開啟 `PA_RECEIVE_ENABLED` 前建議先完成用戶端憑證(PF F.6);沒有時由需求方決定是否接受「Syslog 只靠防火牆」的風險。
2. **portproxy 與防火牆**(系統管理員 PowerShell;PF 附錄 F.2,IP 換成主機 3;`:9443` 與其他既有規則不動):
   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=10.10.130.122 listenport=51293 connectaddress=127.0.0.1 connectport=51293
   netsh interface portproxy add v4tov4 listenaddress=10.10.130.122 listenport=51294 connectaddress=127.0.0.1 connectport=51294
   New-NetFirewallRule -DisplayName "NetOps PA log 51293-51294" -Direction Inbound -Protocol TCP -LocalPort 51293,51294 -RemoteAddress 10.10.115.35 -Action Allow
   netsh interface portproxy show v4tov4
   ```
   做完從開發機與主機 2 再測一次舊系統 port。portproxy 會遺失來源 IP:Syslog 51294 在用戶端憑證(F.6)前只靠這條防火牆規則。
3. **機密**:`sudo rm /srv/giganexus/netops-secrets/pa_api_key && sudo sh host3-set-pa-secrets.sh`(輸入專用帳號的 Key);公司 CA 憑證放 `/srv/giganexus/netops-pa-tls/`,
   `netops.env` 設 `PA_CA_FILE=/run/pa-tls/<檔名>`、`PA_HOST`;**不可設 `PA_TLS_INSECURE`**(`deploy-prod` 與 `netops-pa` 都會擋)。
4. **開關**(`/srv/giganexus/deploy/netops.env`):
   - `NETOPS_PA_PIPELINE=1`:`deploy-prod` 啟動 `netops-pa`(拉 Registry 映像)、`netops-clickhouse`(2 GB,`apply-schema.sh prod`:TRAFFIC 30 天、威脅 90 天、App 彙總 13 個月、來源彙總 90 天、熱力圖 5m 1 年、1h / 1d 5 年,CG §10.3)、`netops-ingest`;
     netops-api 改依 netops.env 對帳(`NETOPS_RECON_TIME` 預設 08:10)、每日同步、ClickHouse 摘要。
   - `PA_RECEIVE_ENABLED=1`、`PA_ALLOWED_SOURCES=<Docker 閘道>`(`docker network inspect giganexus-netops-prod_pa-ingress -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`,第一次以 1 部署後查;PF F.3)、需要時 `PA_POLL_ENABLED=1`。
   - C6 驗收後:`NETOPS_AI_SOURCE=clickhouse`(並刪除 `FTP_SYNC_MINUTES`)、`NETOPS_AI_DAILY_SUMMARY=1`(或刪除該行)。
   - E2(NAS 150 GB / 年)核准、`giga-netops/prod/pa-archive` 與標記檔建好(`GW_ENV=prod sh deploy/host2-setup-pa-archive.sh`,先讀該腳本確認主機 3 適用)後:`NETOPS_ARCHIVE_ENABLED=1`。
5. 重試 `main` 最新 pipeline 的 `deploy-prod`。之後只換機密或憑證檔時,`main`「Run pipeline」帶 `NETOPS_PA_RECREATE=1`(由 Maintainer 執行;會重跑 `build-prod`,再手動 `deploy-prod`)。
6. 網通:Syslog / HTTP Server Profile 加 `10.10.130.122`;預設規則 `interzone-default`、`intrazone-default` 也套 `netops-forward`(PF D.1、G11);Permitted IP 加 `10.10.130.122`;**接收開好後對 Syslog Server Profile 再 Commit 一次**。
7. 驗證:即時監控有資料、收集器 `dropped` / `rejected` / `malformed` 為 0;`system.tables` TTL 正確;隔天 08:10 對帳誤差 < 0.5%。

關閉第二段:`NETOPS_PA_PIPELINE=0` 後重跑 `deploy-prod` **不會停止**已在執行的三個容器(避免誤停);要停時手動
`sudo docker stop giganexus-netops-prod-netops-pa-1 giganexus-netops-prod-netops-ingest-1 giganexus-netops-prod-netops-clickhouse-1`(停 `netops-pa` 前先告知網通)。

## 5. 官方映像拉不到時

`deploy-prod` 對 `redis:7.4-alpine`(第二段另有 `clickhouse/clickhouse-server:26.3.62.3`)用 `pull --policy missing`。主機 3 連不到 Docker Hub 時(2026-10-29 曾發生),在主機 2:
`docker save redis:7.4-alpine | ssh host3 "wsl -u root -e docker load"`(同 Gateway !12 的做法),再重跑 `deploy-prod`。

## 6. 回滾

- 前端:`docker compose ... --profile publish run --rm --pull never spa-netops rollback netops`(主機 3、repo 目錄;`IMAGE_TAG` 同目前部署的 SHA)。
- 後端:在上一版的 `main` pipeline 重試(Retry)`deploy-prod`(映像與 digest artifact 保留 1 年)。開了「Prevent outdated deployment jobs」時要同時勾「Allow job retries for rollback deployments」,
  或從 GitLab Environments › production 的 Rollback 按鈕執行。
- 映像清理:每次部署在主機 3 留一組完整 SHA 標籤的映像;磁碟吃緊時保留目前與上一版,其餘 `docker image rm`(E5 預留 20 GB 是給 ClickHouse 的)。
- 整個停用:`/netops/` 是新網址,使用者改回舊版 IIS 即可;舊版 IIS 上架期間持續運作(`legacy-iis` 標籤)。
