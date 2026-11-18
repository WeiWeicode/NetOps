# NetOps 正式區部署手冊(主機 3,10.10.130.122)

> 第一段(本手冊 §1–§3、§5、§6):`netops-api`、前端 `/netops/`、`netops-redis`、`netops-kb-backup`。
> 第二段(§4,C6;等 E5、PA 憑證與專用帳號):`netops-clickhouse`、`netops-ingest`、`netops-pa`,只改開關,不改程式。
> 規則:主機 3 的舊系統不能受影響(工作區 `AGENT.md` §5)——不動 `:9443` 與既有防火牆規則;含密碼的步驟由需求方執行,AI 不經手。
> CI:`.gitlab-ci.yml` 的 `build-prod`(主機 2 建置推 Registry)→ `deploy-prod`(主機 3 手動)→ `rbac-prod`(主機 3 手動),只在 `main`。

## 0. 部署前唯讀查證(需求方在主機 3 執行;AI 的唯讀 ssh 未獲授權,這些項目尚未實機確認)

`ssh host3` 後 `wsl`,以下都只讀不改:

```bash
cat /srv/giganexus/shared/gateway-image-tag                      # 正式區 Gateway 映像 SHA(rbac-prod、host3-set-secrets.sh 用);要有一行 SHA
ls /srv/giganexus/shared/giga-api-gateway-bff/deploy/docker-compose.prod.yml /srv/giganexus/deploy/prod.env
ls /srv/giganexus/giga-observe/deploy/prod.env                     # host3-set-secrets.sh 建監控 Key 用的 env 檔
sudo docker ps --format '{{.Names}}' | grep -E 'gno-backend|bff-1'  # giga-observe-prod 與正式區 Gateway 在運作
mountpoint /mnt/nas-docker && df -h /mnt/nas-docker                # NAS(docker-backup)已掛載與剩餘空間
ls -la /mnt/nas-docker/giga-netops 2>/dev/null || echo "尚未建立(§2 第 4 步會建)"
sudo docker network ls --format '{{.Name}}' | grep -x giganexus-gw_default
sudo docker volume ls --format '{{.Name}}' | grep -x giganexus-gw_gw_www
ls /srv/giganexus/deploy/netops.env /srv/giganexus/netops-secrets 2>&1   # 第一次部署前應不存在
sudo ss -ltn | grep -E ':5129[0-9]' || echo "5129x 沒有被占用"
```

任一項不符時先停下來回報,不要自行修改主機。

## 1. 正式區 FTP 目錄(寫在 `.gitlab-ci.yml` `deploy-prod` 的 `variables`)

照舊版 IIS(repo 根目錄 `server/`)的設定。舊版 IIS 實際的 `server/.env` 不在 repo(`.gitignore`;AI 依 AGENT.md §7.5 不讀 `.env`),
下表取自範本 `server/.env.example` 與程式預設值 `server/config.js`;**需求方 2026-11-16 確認沿用預設值**。之後要改時改 `deploy-prod` 的值。

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
| `FTP_SYNC_MINUTES`(deploy-prod 固定) | 第一段 `60`;第二段 `0` | 需求方 2026-11-16 決定(舊版 `server/.env.example:39` 為 0) |

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
   **主機 3 的 Gateway 共用目錄要手動補檔**(2026-11-16 實際遇到):正式區 Gateway 的 deploy 不複製 `deploy/`,共用目錄 `/srv/giganexus/shared/giga-api-gateway-bff/deploy/` 沒有 `gateway-apps.yaml`、`super-admin-grants.yaml`、`super-admin-grants-plan.mjs`、`apply-super-admin-grants.sh`。
   步驟(Gateway 負責人;用 Gateway `main` 的版本,Gateway !26、!27 合併後才有 `netops` 應用與 28 項權限):
   1. 開發機 `git -C giga-api-gateway-bff fetch gitlab`,`git show gitlab/main:deploy/<檔名> | sha256sum` 記下四個檔案的雜湊。
   2. 把四個檔案複製到主機 3(同 §2 的 `scp` 到 `C:/Users/user/netops-deploy/`),在 WSL 以 root 放進共用目錄,再 `sha256sum` 和第 1 步比對。
   3. 套用應用登記:Gateway `gateway-apps.yaml` 由 Gateway 負責人手動套用(IMPL-PLAN D1「應用切換」);**實際套用指令未確認**,照 Gateway 該檔頭註解。
   4. 補超級管理員權限:`cd /srv/giganexus/shared/giga-api-gateway-bff/deploy && ACTOR=cli:<工號> IMAGE_TAG=<正式區 Gateway 目前版本,見 /srv/giganexus/shared/gateway-image-tag> sh apply-super-admin-grants.sh prod /srv/giganexus/deploy/prod.env`(不使用 `YES=1`;Gateway DEPLOYMENT §3.5.1)。沒做這步,GigaItApp 指派 `netops-admin` 會被防提權檢查擋下(403 `PERMISSION_DENIED`)。
   5. 超級管理員在 GigaItApp 重新整理或重新登入後,指派預設 `netops-admin`(S112009、S094009、S114010、S111003)。
9. 驗證:`https://giganexus.gigasolar.com.tw/netops/` 登入、FTP Log 檔案、知識庫;舊系統 port 從主機 2 `tcp-check.ps1` 與開發機各測一次。
   新系統資料目錄與舊版 IIS 分開,一開始沒有資料。第一段 `FTP_SYNC_MINUTES=60`:**部署後最多 60 分鐘內第一次自動同步**(PA 15 秒、AD 20 秒、其他類型 60 秒後先跑一次,之後每 60 分鐘),
   同步與分析完成後再看 AD 事件與 AI 問答(FTP 舊路徑);急著看可在「FTP Log 檔案」頁手動同步。與舊版 IIS 同時讀 FTP,本系統連線上限 2。
   知識庫筆記從舊版複製屬 D2 第 3 步(D14),不在本手冊。
   第一段沒有 ClickHouse:**流量總覽、安全事件、明細查詢、熱力圖在第二段前無法使用**(ARCHITECTURE D43,只查 ClickHouse),請使用者這期間繼續用舊版 IIS。

第一段 `deploy-prod` 在 `NETOPS_PA_PIPELINE=0` 時以環境變數固定:`NETOPS_AI_SOURCE=ftp`、`NETOPS_AI_DAILY_SUMMARY=0`、`NETOPS_ARCHIVE_ENABLED=0`、
`NETOPS_RECON_TIME=-1`(不對帳,所以也不跑每日同步)、`NETOPS_RECON_AUTO_BACKFILL=0`、`NETOPS_CH_SUMMARY_MINUTES=0`。

## 4. 第二段(C6):開啟 PA log 管線

前提:E5(主機 3 磁碟 20 GB 預留)核准;網通給專用 API 帳號的 Key;**§4.1 憑證**(NetOps 專用 CA 簽接收端點憑證與 PA-560 管理介面憑證;需求方 2026-11-16 決定,公司 AD CS 到位前不等)。

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
3. **機密與憑證**:`sudo rm /srv/giganexus/netops-secrets/pa_api_key && sudo sh host3-set-pa-secrets.sh`(輸入專用帳號的 Key);
   憑證照 **§4.1 第 1 步**(`host3-pa-pki.sh init`、`server`),把腳本結尾印的 `PA_CA_FILE`、`PA_TLS_CERT_FILE`、`PA_TLS_KEY_FILE`、`PA_HOST=10.10.115.35` 寫進 `netops.env`;
   PA-560 管理介面是出廠自簽憑證時設 `PA_TLS_INSECURE=1`(需求方 2026-11-17,!109;`netops-pa` 啟動記 WARNING;正式區 2026-11-17 起即如此),有 `server.crt` 就不設 `PA_RECEIVE_PLAINTEXT`。
4. **開關**(`/srv/giganexus/deploy/netops.env`):
   - `NETOPS_PA_PIPELINE=1`:`deploy-prod` 啟動 `netops-pa`(拉 Registry 映像)、`netops-clickhouse`(2 GB,`apply-schema.sh prod`:TRAFFIC 30 天、威脅 90 天、App 彙總 13 個月、來源彙總 90 天、熱力圖 5m 1 年、1h / 1d 5 年,CG §10.3)、`netops-ingest`;
     netops-api 改依 netops.env 對帳(`NETOPS_RECON_TIME` 預設 08:10)、每日同步、ClickHouse 摘要。
   - `PA_RECEIVE_ENABLED=1`、`PA_ALLOWED_SOURCES=<Docker 閘道>`(`docker network inspect giganexus-netops-prod_pa-ingress -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`,第一次以 1 部署後查;PF F.3)、需要時 `PA_POLL_ENABLED=1`。
   - C6 驗收後:`NETOPS_AI_SOURCE=clickhouse`(並從 `netops.env` 移除 `FTP_SYNC_MINUTES`;開關 1 時 deploy-prod 已固定為 0)、`NETOPS_AI_DAILY_SUMMARY=1`(或刪除該行)。
   - E2(NAS 150 GB / 年)核准、`giga-netops/prod/pa-archive` 與標記檔建好(`GW_ENV=prod sh deploy/host2-setup-pa-archive.sh`,先讀該腳本確認主機 3 適用)後:`NETOPS_ARCHIVE_ENABLED=1`。
5. 重試 `main` 最新 pipeline 的 `deploy-prod`。之後只換機密或憑證檔時,`main`「Run pipeline」帶 `NETOPS_PA_RECREATE=1`(由 Maintainer 執行;會重跑 `build-prod`,再手動 `deploy-prod`)。
6. 網通:Syslog / HTTP Server Profile 加 `10.10.130.122`(**Syslog Transport `SSL`、HTTP Protocol `HTTPS`**,§4.1 第 4 步);預設規則 `interzone-default`、`intrazone-default` 也套 `netops-forward`(PF D.1、G11);Permitted IP 加 `10.10.130.122`;**接收開好後對 Syslog Server Profile 再 Commit 一次**。
7. 驗證:§4.1 第 5 步的連線檢查全部成功;即時監控有資料、收集器 `dropped` / `rejected` / `malformed` 為 0;`system.tables` TTL 正確;隔天 08:10 對帳誤差 < 0.5%。

### 4.1 PA 憑證(NetOps 專用 CA,`deploy/host3-pa-pki.sh`)

需求方 2026-11-16 決定:主機 3 自建 **「GigaNexus NetOps PA CA (prod)」**,與 Gateway `:9443` 的臨時 PKI 分開;CA 私鑰只留在主機 3(`/srv/giganexus/netops-pa-ca/ca.key`,root 400,目錄 root 700,不掛進任何容器)。
PA-560 管理介面憑證由網通在 PA 產生 CSR,**私鑰留在 PA**;腳本只簽發。用戶端憑證(mTLS,PF G8)這次不做,之後用同一個 CA 加簽即可。

| 項目 | 值 |
| --- | --- |
| CA | RSA 4096、SHA-256、10 年;`basicConstraints CA:TRUE, pathlen:0` |
| 接收端 `server.crt` | RSA 3072、825 天;CN 與 SAN `IP:10.10.130.122`(PA 以 IP 送 log,文件內沒有主機 3 的接收用 DNS 名稱,所以只放 IP);`serverAuth` |
| PA 管理介面憑證 | 照 CSR 的主體與 SAN(**必須含 `IP:10.10.115.35`**,不含就拒絕;IP 只能是這一個,DNS 照 CSR 保留;CN 要是 `10.10.115.35` 或 SAN 的 DNS 名稱);金鑰 RSA ≥ 2048 或 ECDSA P-256 / P-384;825 天;`serverAuth`,不沿用 CSR 要求的其他擴充欄位 |
| 檔案 | `/srv/giganexus/netops-pa-tls/`(容器 `/run/pa-tls`):`pa-mgmt-ca.pem` 644、`server.crt` 644、`server.key` `1000:1000` 400(PF F.6) |
| 到期 | `sudo sh host3-pa-pki.sh status` 看 CA、`server.crt` 與已簽發清單;接收端到期前 `server --renew`,PA 憑證到期前請網通重產 CSR 再 `sign-csr` |

腳本與 §2 一樣從開發機複製到主機 3 再以 root 執行:

```powershell
scp deploy/host3-pa-pki.sh host3:C:/Users/user/netops-deploy/
```

```bash
sudo install -d -m 700 -o root /root/netops-deploy
sudo install -m 700 -o root /mnt/c/Users/user/netops-deploy/host3-pa-pki.sh /root/netops-deploy/
sudo sha256sum /root/netops-deploy/host3-pa-pki.sh    # 和開發機 sha256sum deploy/host3-pa-pki.sh 比對
```

依序(1、3 的第 2 小步、5 需求方在主機 3;其餘網通在 PA-560):

1. **主機 3 建 CA、簽接收端憑證**(`/srv/giganexus/netops-pa-tls` 由 §2 的 `host3-set-pa-secrets.sh` 建立,沒有時腳本會停下來):
   ```bash
   sudo sh /root/netops-deploy/host3-pa-pki.sh init      # 已有 CA 不會覆寫;印出 CA 的 SHA-256 指紋
   sudo sh /root/netops-deploy/host3-pa-pki.sh server    # 已有 server.crt 會停下來;重簽用 server --renew(舊檔備份到 CA 目錄)
   ```
   把結尾印的四行寫進 `/srv/giganexus/deploy/netops.env`(§4 第 3 步)。
   CA 憑證(公開)複製給網通:`sudo cp /srv/giganexus/netops-pa-tls/pa-mgmt-ca.pem /mnt/c/Users/user/netops-deploy/`,再從 Windows 取走。
2. **網通:PA 匯入 CA 為 Trusted Root**:Device > Certificate Management > Certificates > **Import**,Certificate Name `netops-pa-ca-prod`、檔案 `pa-mgmt-ca.pem`(只匯入憑證,不需要私鑰);
   匯入後開啟該憑證勾選 **Trusted Root CA**;核對指紋與第 1 步印的相同(PA 畫面沒有 SHA-256 指紋時核對主體與到期日)。Commit。
3. **網通產 CSR → 主機 3 簽發 → 匯回 PA**:
   1. 網通:Certificates > **Generate**,Certificate Name 例如 `pa-mgmt-prod`、Common Name `10.10.115.35`、**Signed By 選 External Authority (CSR)**、
      演算法 RSA 2048 以上(或 ECDSA 256 / 384)、Digest sha256;Certificate Attributes 加 **IP `10.10.115.35`**(要有 DNS 名稱時另加 Host Name;IP 不可加其他位址)。產生後 **Export** CSR(私鑰留在 PA,不要匯出),
      並把 CSR 檔的 SHA-256(`sha256sum` 或 PowerShell `Get-FileHash`)**用另一個管道**(例如當面或電話)告訴需求方,防止 CSR 在傳送途中被換掉。
   2. 需求方把 CSR 放到主機 3(同上 `scp` 到 `C:/Users/user/netops-deploy/`),在 WSL:
      ```bash
      sudo sh /root/netops-deploy/host3-pa-pki.sh sign-csr /mnt/c/Users/user/netops-deploy/pa-mgmt-prod.csr
      ```
      腳本先印出 CSR 檔與公鑰的 SHA-256、CN、SAN,**和網通給的 SHA-256 相同才輸入 `y`**。
      SAN 沒有 `10.10.115.35`、有其他 IP、有 IP / DNS 以外的項目、CN 不是 `10.10.115.35`(或 SAN 的 DNS 名稱)、金鑰太弱時拒絕簽發,請網通重產。成功時在 CSR 旁產生 `pa-mgmt-prod.crt`(公開),印出 SAN、到期、指紋。
   3. 網通:Certificates > **Import**,Certificate Name 填**與第 1 小步相同**的 `pa-mgmt-prod`、檔案 `pa-mgmt-prod.crt`(不勾 Import private key;PA 會和 CSR 的私鑰配對)。
   4. 網通:Device > Certificate Management > **SSL/TLS Service Profile** > Add(例如 `netops-mgmt-prod`,憑證 `pa-mgmt-prod`,Min Version TLSv1.2),
      再到 Device > Setup > Management > General Settings 把 **SSL/TLS Service Profile** 改成它。Commit(管理介面會換憑證,Web UI 要重新連線)。這把 CA 沒有名稱限制,**不要裝進 Windows / 瀏覽器的信任清單**;瀏覽器的憑證警告核對指紋後略過即可。
4. **網通:Server Profile 改加密**(PF B.1、C.1):`netops-syslog` 的 `netops-prod` **Transport 改 `SSL`**(Port 51294);`netops-http` 的 `netops-prod` **Protocol 改 `HTTPS`**、TLS Version 1.2 以上(Port 51293)。
   **請網通確認(未在設備上查證)**:PA 送 Syslog SSL / HTTPS 時是否驗證接收端憑證、驗證要不要另外指定 Certificate Profile(HTTP Server Profile 有 Certificate Profile 欄位時選一個只含 `netops-pa-ca-prod` 的 Profile);
   確認方式:暫時把 `netops-pa-ca-prod` 的 Trusted Root CA 取消勾選再 Commit,PA System log 應出現憑證驗證失敗、接收端收不到;確認後恢復勾選。結果回報系統負責人寫進 PF G7。
   要在主機 3 的 `netops-pa` 以 TLS 啟動之後(§4 第 4、5 步部署完成、日誌有 `接收端點已啟用:HTTPS :51293、Syslog TLS :51294`)再 Commit;順序反了 Syslog 不會自動重連(PF E 節),要再 Commit 一次。
5. **驗證**(主機 3;只跑一次唯讀查詢、不寫 Redis;PF F.4 第 3 步):
   ```bash
   sudo docker exec giganexus-netops-prod-netops-pa-1 python -m netops_pa check
   ```
   預期第一行 `PA-560 10.10.115.35:443,驗證憑證(PA_CA_FILE)`,之後各項 `✓`、`結果:全部成功`。憑證驗證失敗時先看第 3 步的 SSL/TLS Service Profile 是否已套用並 Commit。
   接收端:`sudo docker logs --tail 20 giganexus-netops-prod-netops-pa-1` 沒有 `TLS 握手失敗`;PA-560 System log 沒有 `syslog connection failed`;即時監控有 TRAFFIC 與威脅類資料。
   全部成功後才把 `PA_POLL_ENABLED=1`(§4 第 4 步)。

`server.crt` 換新(`server --renew`)後要重建 `netops-pa` 才會載入:`main`「Run pipeline」帶 `NETOPS_PA_RECREATE=1`,之後請網通對 `netops-syslog` 再 Commit;
確認新憑證運作後刪除 `/srv/giganexus/netops-pa-ca/server.key.bak-*`(舊憑證在到期前仍有效,沒有 CRL)。
**CA 私鑰不加密、不備份**(需求方 2026-11-16 決定;CA 不加名稱限制、`netops-pa-tls` 目錄權限維持 `host2-set-pa-secrets.sh` 的設定)。
能在主機 3 WSL 取得 root 的人(含 Windows 使用者 `wsl -u root`、`prod-deploy` Runner 透過 docker)都能讀到 CA 私鑰。
**遺失或外洩時重建 CA**(沒有 CRL,誤簽同樣處理):移走 `/srv/giganexus/netops-pa-ca` → 重跑本節第 1 步 `init`、`server --renew` → 網通在 PA 刪除舊的 Trusted Root、匯入新的 CA(第 2 步)→ 重產 CSR 並簽發匯回(第 3 步)→ 重建 `netops-pa`(`NETOPS_PA_RECREATE=1`)→ 第 5 步驗證。
`deploy-prod` 會擋 `NETOPS_PA_TLS_HOST_DIR` 指到 CA 目錄(或其上層、或含 `ca.key` 的目錄),避免 CA 私鑰掛進容器。

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

## 7. 知識庫與網段設定備份、還原(`netops-kb-backup`)

**備份範圍**(每天 `KB_BACKUP_HOUR` 點,預設 02:00;容器啟動時當天還沒有備份才補一次,所以部署當天不會產生含新內容的備份):

| 目錄(`/data`) | 內容 | 備註 |
| --- | --- | --- |
| `knowledge/` | 知識庫筆記與匯整檔 | 不可重建 |
| `warroom/` | 網段設定 `warroom.json`(SG,D46)與 `history/` | 不可重建;**排除** `warroom/ai-hourly.json`(每小時重算)與 `*.tmp`。`warroom/` 還沒建立(沒存過網段設定)時只打包 `knowledge` |

`warroom/history/warroom-<時間>-v<版本>.json` 是**每次儲存前的舊設定**(保留最近 20 份,檔名的 `v<版本>` 是被取代的那一版),用途是誤改後回到舊版;NAS 每日備份再多一層保護(`warroom.json` 被刪或壞掉時)。

備份位置:NAS `/mnt/nas-docker/giga-netops/<區>/netops-kb-<區>-YYYYMMDD.tar.gz`(附 `.sha256`,保留 `KB_BACKUP_KEEP` 份,預設 30;最近結果在 `LAST_RESULT`)。標記檔 `.giga-netops-backup` 不存在時整輪跳過(NAS 沒掛上)。

**還原網段設定到舊版**(擇一;`warroom.json` 的 `version` 以當下為準,PUT 比對的是檔案內的 `version`):

1. **最近 20 次內的舊版**:在 `netops-api` 的資料目錄找 `warroom/history/warroom-<時間>-v<版本>.json`(每份是該次儲存前的完整設定)。最簡單的做法:把該檔內容在網段設定頁「匯入」後儲存(匯入只改草稿,儲存會產生新版本、並把目前版本存進 history),不必動主機檔案。
2. **`warroom.json` 遺失或損壞,或需要超過 20 次前的版本**:先 `sha256sum -c` 核對,再從備份解出 `warroom/warroom.json`(`tar -xzf netops-kb-<區>-YYYYMMDD.tar.gz warroom/warroom.json -C <暫存目錄>`),內容貼到網段設定頁「匯入」後儲存。**不要直接覆蓋主機上的資料目錄**(操作人需要 root,且戰情室以檔案修改時間偵測變更,直接覆蓋後版本號可能倒退);設定檔被改壞時頁面顯示 `source: invalid` 並載入範例,仍可整份覆寫。
3. 還原知識庫筆記:解出 `knowledge/` 後依知識庫還原流程處理(見 HANDOFF 的備份可還原驗證項)。

核對備份內容(唯讀):`tar -tzf <檔案> | grep -E "warroom/"` 應有 `warroom/warroom.json` 與 `warroom/history/*`,不應有 `warroom/ai-hourly.json`。
