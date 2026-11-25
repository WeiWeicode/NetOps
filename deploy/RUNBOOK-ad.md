# NetOps AD 事件接收(AD-1)主機設定手冊

> 對象:需求方 / 維運(主機 2 測試區 `10.10.130.124`、主機 3 正式區 `10.10.130.122`)。**AI 不執行本手冊的指令**(機密、root、Windows 防火牆;`AGENT.md` §6、§7.5)。
> 依據:`docs/AD-AGENT-PLAN.md` §4、§7、§8 AD-1;`docs/ARCHITECTURE.md` D49(H1–H4)。
> 第一台試裝 DC:`GSMC-DC1`,網域 `gsmc.com.tw`,IP `10.10.130.3`(需求方 2026-11-23 提供)。Agent 本身是 AD-2,本手冊只準備接收端。

## 1. 元件與埠號

| 項目 | 內容 |
| --- | --- |
| 容器 | `netops-ad-receiver`(`netops-api` 同映像,`node dist/src/ad-receiver/main.js`);只寫 `netops-redis`,**和 `netops-pa` 分開**(改它不會重建 `netops-pa`,PA Syslog 不中斷) |
| 埠號 | **51295**(Gateway `BACKEND-GUIDE` §3.3 已登記,Gateway !34)。Compose 只發佈在 WSL 的 `127.0.0.1:51295`,Windows 以 `netsh portproxy` 轉入 |
| 傳輸 / 認證 | 明文 HTTP(需求方 2026-11-23);每台 DC 一把 Token(標頭 `X-NetOps-Ad-Token`),伺服器以 Token 核對 `computer` / `domain`,不一致 403 |
| 來源限制 | **只靠 Windows 防火牆規則列 DC IP**(容器看到的來源是 Docker 閘道,不做 `AD_ALLOWED_SOURCES`;H3) |
| 機密 | `/srv/giganexus/netops-secrets/ad_agent_tokens`(對應表,只含 Token 的 SHA-256;uid 1000、400)、`/srv/giganexus/netops-ad-dc-tokens/<COMPUTER>.token`(Token 明文,root、400,交給 DC 後可刪) |
| 資料 | Redis `netops:ad:log:events`(2 天)→ `netops-ingest` → ClickHouse `netops.ad_events`(正式區 90 天 / 測試區 3 天)、`ad_heat_5m` / `1h` / `1d`;NAS `giga-netops/<區>/ad-archive/<年>/ad_events_<日期>.parquet` |

**Compose 載入時就需要 `ad_agent_tokens` 這個檔**(所有服務共用設定):合併本 MR 之前,兩台主機都要先執行 §2 / §3 的第 1 步,否則之後的 CI 部署與手動 `docker compose` 指令全部失敗(CI 會在判斷 `netops-pa` 之前先擋下,不會誤重建 `netops-pa`)。

## 2. 主機 2(測試區)— 合併 MR 前

在主機 2 WSL 的 NetOps checkout(切到本 MR 分支 `feature/ad-1-collector-ingest`)執行。

1. **產生 DC Token 與對應表**(隱藏、不印在畫面):
   ```bash
   sudo sh deploy/host2-set-ad-secrets.sh add GSMC-DC1 gsmc.com.tw
   sudo sh deploy/host2-set-ad-secrets.sh list          # 只列 COMPUTER DOMAIN,不顯示 Token
   ```
   安裝 Agent(AD-2)時才用 `sudo sh deploy/host2-set-ad-secrets.sh show GSMC-DC1` 在終端機顯示 Token,寫進 DC 的 `%ProgramData%\GigaNexus\NetOpsAdAgent\secrets\ad_agent.token`;不要貼到聊天、Email 或工單,用完執行 `clear`。
   **Agent 裝好、連線正常後**,刪掉主機上的 Token 明文檔:`sudo sh deploy/host2-set-ad-secrets.sh forget GSMC-DC1`(對應表不變;之後要重裝用 `rotate`)。
2. **NAS 歸檔目錄**(`ad-archive` + 標記檔;沒有標記檔時 `netops-ingest` 不寫,心跳 `adArchiveState=nas-missing`):
   ```bash
   sudo sh deploy/host2-setup-pa-archive.sh ad
   ```
3. **套用 ClickHouse schema**(新增 `migrations/005-ad1-ad-events.sql`:`ad_events`、`ad_heat_5m` / `1h` / `1d`、3 個物化檢視;可重複執行,CI `deploy-api-test` 合併後也會再跑一次):
   ```bash
   C="docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml"
   sh deploy/clickhouse/apply-schema.sh test "$($C ps -q netops-clickhouse)"
   ```
   結尾的表格要有 `ad_events`(TTL `toIntervalDay(3)`)、`ad_heat_5m` / `1h` / `1d`(各 3 天)。
4. **Windows 防火牆與 portproxy**(主機 2 系統管理員 PowerShell;既有 51293 / 51294 規則不動):
   1. 確認沒有其他規則已放行 51295(只讀;有的話先停下來回報):
      ```powershell
      Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -contains '51295' -or $_.LocalPort -eq 'Any' } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object DisplayName, Profile
      ```
      (`LocalPort` 是範圍字串時 `-contains` 比不到,範圍型規則要人工看。)
   2. 轉入與放行(只放行 DC 的 IP):
      ```powershell
      netsh interface portproxy add v4tov4 listenaddress=10.10.130.124 listenport=51295 connectaddress=127.0.0.1 connectport=51295
      New-NetFirewallRule -DisplayName "NetOps AD Agent 51295" -Direction Inbound -Protocol TCP -LocalPort 51295 -RemoteAddress 10.10.130.3 -Action Allow
      netsh interface portproxy show v4tov4
      ```
5. **合併後**:CI `deploy-api-test` 依序部署,`netops-ad-receiver` 以 `up -d --no-deps --force-recreate` 只重建它自己;日誌應有 `OK   netops-pa 沒有變更,沿用原容器` 與 `OK   netops-ad-receiver`。
6. **驗證**(主機 2 WSL):
   ```bash
   C="docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml"
   $C ps netops-ad-receiver                                   # healthy
   $C logs --tail 5 netops-ad-receiver                        # 「netops-ad-receiver 啟動」,dcs 列出 GSMC-DC1(不含 Token)
   $C exec -T netops-redis redis-cli hmget netops:ingest:heartbeat state adState read:ad inserted:ad adArchiveState
   # netops-pa 沒有重啟:StartedAt 在這次部署之前、心跳 syslogOkAt 持續更新
   docker inspect -f '{{.State.StartedAt}}' "$($C ps -q netops-pa)"
   $C exec -T netops-redis redis-cli hget netops:pa:heartbeat syslogOkAt
   ```
   從 `GSMC-DC1`(PowerShell)測連線:`Test-NetConnection 10.10.130.124 -Port 51295` 為 `True`;從其他電腦應為 `False`(防火牆)。
   `Invoke-RestMethod http://10.10.130.124:51295/healthz` 回 `status: ok`。沒有 Token 的 `POST /ad/v1/logs` 回 401。
7. 完成標準「部署只重建 `netops-ad-receiver` 時 `netops-pa` 不重啟、PA Syslog 不中斷」以第 5、6 步的日誌與 `StartedAt` 為證,寫進測試報告。

## 3. 主機 3(正式區)

前提:`main` 已包含本 MR;`netops-ingest` 寫 ClickHouse 要 `NETOPS_PA_PIPELINE=1`(RUNBOOK-prod.md §4)。在主機 3 WSL 放 `host2-set-ad-secrets.sh`、`host3-set-ad-secrets.sh` 的目錄執行(同 PA 腳本的做法)。
`host3-set-ad-secrets.sh` 會以 root 執行同目錄的 `host2-set-ad-secrets.sh`,所以**兩支腳本都要屬於 root、群組與其他人不可寫**(`sudo chown root:root …; sudo chmod 644 …`),不符合時腳本會停下。

1. **合併到 `main` 之前**:建立對應表(Compose 需要這個檔;同時在 `netops.env` 補 `NETOPS_AD_RECEIVER=0`):
   ```bash
   sudo sh host3-set-ad-secrets.sh add GSMC-DC1 gsmc.com.tw     # Token 在主機 3 重新產生,不沿用測試區
   ```
   `deploy-prod` 也會檢查 `ad_agent_tokens` 存在(和其他機密一起)。
2. **NAS**:`sudo GW_ENV=prod sh host2-setup-pa-archive.sh ad`(**一定要帶 `GW_ENV=prod`**:沒帶時腳本預設 `test`,會建到 `giga-netops/test/ad-archive`;比照 RUNBOOK-prod.md §4.2 第 2 步)(主機 3 也可用;`/mnt/nas-docker` 在主機 3 是 `docker-backup` 分享,先確認位置,同 RUNBOOK-prod.md §4.2 第 1 步)。
3. **ClickHouse schema**:`NETOPS_PA_PIPELINE=1` 時 `deploy-prod` 會執行 `apply-schema.sh prod`(`ad_events` 90 天、`ad_heat_5m` 1 年、`1h` / `1d` 5 年)。要先手動套用:
   ```bash
   C="docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml"
   sh deploy/clickhouse/apply-schema.sh prod "$($C ps -q netops-clickhouse)"
   ```
4. **Windows 防火牆與 portproxy**(主機 3 系統管理員 PowerShell):
   1. 同 §2 第 4.1 步確認沒有規則已放行 51295;**特別確認 `Docker-WSL2-AllServices-TCP`(來源不限)的 port 範圍不含 51295**(PA-FORWARDING-SPEC 附錄 F.4.1),否則下面限制來源的規則會被繞過。
   2. ```powershell
      netsh interface portproxy add v4tov4 listenaddress=10.10.130.122 listenport=51295 connectaddress=127.0.0.1 connectport=51295
      New-NetFirewallRule -DisplayName "NetOps AD Agent 51295" -Direction Inbound -Protocol TCP -LocalPort 51295 -RemoteAddress 10.10.130.3 -Action Allow
      netsh interface portproxy show v4tov4
      ```
5. **開關**:`/srv/giganexus/deploy/netops.env` 改 `NETOPS_AD_RECEIVER=1`,重跑 `main` 最新 pipeline 的 `deploy-prod`。`netops-ad-receiver` 以 `--no-deps --force-recreate` 啟動,不動 `netops-redis` 與 `netops-pa`。
6. **驗證**:同 §2 第 6 步(IP 換 `10.10.130.122`、專案名 `giganexus-netops-prod`)。

## 4. 新增、換 Token、作廢 DC

| 動作 | 主機指令(測試區 `deploy/host2-…`;正式區 `host3-…`) | Windows 防火牆 |
| --- | --- | --- |
| 新增 DC | `sudo sh deploy/host2-set-ad-secrets.sh add <COMPUTER> <DOMAIN>` | `Set-NetFirewallRule -DisplayName "NetOps AD Agent 51295" -RemoteAddress 10.10.130.3,<新 DC IP>`(列出**全部** DC IP) |
| 換 Token(遺失、外洩) | `sudo sh deploy/host2-set-ad-secrets.sh rotate <COMPUTER>` | 不用改 |
| 作廢 DC(汰換) | `sudo sh deploy/host2-set-ad-secrets.sh revoke <COMPUTER>` | 從 `-RemoteAddress` 拿掉該 IP |

對應表改完要**重建 `netops-ad-receiver`** 才生效(其他 DC 斷線幾秒,Agent 會重送;`netops-pa` 不受影響):

- **測試區**:在 GitLab 重跑最近一次 `develop` pipeline 的 `deploy-api-test`,日誌確認 `OK   netops-pa 沒有變更,沿用原容器` 與 `OK   netops-ad-receiver`。
- **正式區**:等下一次 `deploy-prod`,或由 Maintainer 在 GitLab 重跑最近一次 `main` pipeline 的 `deploy-prod`;會不會重建 `netops-pa` 以 CI 日誌為準。
- 不要在主機手動執行不帶 `IMAGE_TAG` 的 `docker compose ... up` 指令(少了 CI 設的 `IMAGE_TAG`,映像會落回 `netops-api:dev`)。

作廢後清掉 Redis 的狀態(計畫 §4.2 L3;第一版不提供管理 API):

```bash
C="docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml"
$C exec -T netops-redis redis-cli srem netops:ad:computers <COMPUTER>
$C exec -T netops-redis redis-cli del netops:ad:heartbeat:<COMPUTER> netops:ad:recv:hwm:<COMPUTER>
```

## 5. 已知限制

- **Redis 沒有 AOF(只有 RDB 快照,`noeviction`)**:`netops-redis` 當機或重啟時,快照之後的 Stream 與水位會遺失;Agent 已收到 200 的事件不會重送,ingest 的缺口偵測也看不到。這段事件要靠 **AD-3 的 FTP 每日對帳補漏**補回(AD-3 設計時確認涵蓋)。
- **每台 DC 每分鐘最多 120 個請求**(超過回 429,Agent 退避後重送同一批,不掉資料)。Token 外洩時可限制灌入量,但持有 Token 的人仍能偽造該台 DC 的事件與心跳(需求方已接受的剩餘風險,計畫 §7);送一筆極大的 RecordID 也會讓該台之後的正常事件被當成重複(要 `redis-cli del netops:ad:recv:hwm:<COMPUTER>` 並換 Token)。
- **心跳讀不到 Redis 水位時回 503 `NETOPS_AD_UNAVAILABLE`**(不回空的 `channels`,需求方 2026-11-24):這時心跳也不寫入,畫面上該台 DC 會變成「停止更新」,但 Agent 其實還在送事件。持續發生時查 `netops-ad-receiver` 日誌的「Redis 存取失敗」與 `redis-cli type netops:ad:recv:hwm:<COMPUTER>`(應為 `hash`)。
- 水位 Hash 有 TTL(30 天):DC 停送超過 30 天後水位過期,心跳回空的 `channels`;此時若 DC 上的 `bookmarks.json` 也遺失,Agent 會從世代 0 往回 60 分鐘重讀(之間的缺口由 AD-3 對帳補)。
- 心跳內容(`data`)與 Watchdog 事件是 Agent 送來的任意 JSON,之後顯示在畫面時要當不可信資料(不用 `v-html`)。

## 6. 停用 / 回滾

- 停止接收(不影響 PA):`docker compose … stop netops-ad-receiver`;正式區另把 `NETOPS_AD_RECEIVER=0`(之後的 `deploy-prod` 會停止並移除它)。
- 移除對外入口:`netsh interface portproxy delete v4tov4 listenaddress=<主機 IP> listenport=51295`、`Remove-NetFirewallRule -DisplayName "NetOps AD Agent 51295"`。
- ClickHouse 的 `ad_*` 表與資料保留(TTL 自動刪除);要整個移除時由需求方決定,AI 不執行 `DROP`。

## 7. AD-2:Agent 試裝與實測(測試 VM、GSMC-DC1)

> 對象:需求方(自己遠端安裝)。**AI 不執行本節指令**。前提:AD-1(!184)與 AD-2 都已合併 develop、測試區 `netops-ad-receiver` 正常(§2 第 6 步)。
> 依據:`docs/AD-AGENT-PLAN.md` §3、§8 AD-2 完成標準。結果填進 `docs/test-reports/2026-11-23-ad-2.md` 的「DC 實測」欄(或另開 `docs/test-reports/<日期>-ad-2-dc.md`)。
> **清除 Security Log 只在主機 2 的 Hyper-V 測試 VM 做,不在 GSMC-DC1 上清除**(需求方 2026-11-23)。

### 7.0 共用:取得執行檔與雜湊

1. 發佈資料夾來源(擇一):
   - CI(正式做法):需求方在 develop 上建立 tag `netops-ad-v<Cargo.toml 版本>`(例 `netops-ad-v0.1.1`;`netops-ad-v0.1.0` 已用過,不可重用。0.1.1 修正大型 Security Log 讀取逾時,GSMC-DC1 以 0.1.1 升級安裝),tag pipeline 的 `build:ad-agent` 自動執行 → 下載 artifact `release-out/`。job 記錄最後一行是 `-ExpectedSha256` 的值。
     前提(需求方在 GitLab 設定):`host2-windows` Runner 指派給 `giganexus/NetOps`;`netops-ad-v*` 設為 **Protected tag**(只有 Maintainer 能建立)。分支 / MR 的 `check:ad-agent` 只跑測試、不產出 exe,**DC 只安裝受保護 tag pipeline 的產物**(資安審查 M-3)。
   - 測試 VM 可用開發機建置(需求方自己的電腦;不要用在 GSMC-DC1):在 NetOps repo 根目錄執行下面指令,輸出在 `release-out\`:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File ad-agent\scripts\build-release.ps1 -OutDir release-out
     ```
     正常:最後印出 `netops-ad-agent.exe` 的 SHA-256(64 個十六進位字元)。clippy、測試或版本檢查失敗會中止,停下回報。
2. 把 `release-out\netops-ad-agent-<版本>\` 整個資料夾與 `release-out\SHA256SUMS.txt` 一起複製到目標機器(例:`C:\Temp\netops-ad-agent\`;`SHA256SUMS.txt` 放進該資料夾)。**雜湊值另外從 CI 記錄或開發機畫面抄**,不要只看複製過去的 `SHA256SUMS.txt`(M6)。
3. Token:在主機 2 WSL 執行 `sudo sh deploy/host2-set-ad-secrets.sh show <COMPUTER>` 顯示,安裝腳本提示時貼上;用完 `clear`。不要貼到聊天、Email 或工單(§2 第 1 步)。

以下 `C=` 指令都在主機 2 WSL 的 NetOps checkout 執行:

```bash
C="docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml"
```

### 7.1 測試 VM:清除 Security Log 實測(H4)

目的:確認「清除 Security Log 後 RecordID 是否從 1 重新編號」,以及 Agent 的 `log_epoch` 加 1、水位遺失時接續後端世代是否正確。用主機 2 Hyper-V 上的 Windows 測試 VM(不需要加入網域;以下 `<VM>` 是 VM 的電腦名稱 `$env:COMPUTERNAME`)。

**準備(主機 2)**

1. 為 VM 產生 Token(網域填 `workgroup`;VM 有加入網域就填它的網域):
   ```bash
   sudo sh deploy/host2-set-ad-secrets.sh add <VM> workgroup
   ```
   正常:`list` 會多一行 `<VM> workgroup`。
2. 對應表改了要重建接收容器(同 §4):在 GitLab 重跑最近一次 `develop` pipeline 的 `deploy-api-test`(不要在主機手動執行不帶 `IMAGE_TAG` 的 `docker compose ... up`),日誌確認 `OK   netops-pa 沒有變更,沿用原容器` 與 `OK   netops-ad-receiver`。失敗停下回報。
3. VM 經 Default Switch NAT 連到主機 2,來源會是 `10.10.130.124`(同 `:9443` 的做法)。**測試期間**把它加進防火牆規則(主機 2 系統管理員 PowerShell):
   ```powershell
   Set-NetFirewallRule -DisplayName "NetOps AD Agent 51295" -RemoteAddress 10.10.130.3,10.10.130.124
   ```
   測完要改回只有 DC(7.1 第 14 步)。

**安裝(VM,系統管理員 PowerShell)**

4. 確認連得到接收端:
   ```powershell
   Test-NetConnection 10.10.130.124 -Port 51295
   ```
   正常:`TcpTestSucceeded : True`。`False` 時停下回報(防火牆或 portproxy)。
5. 安裝(提示時貼上第 3 步的 Token,輸入不顯示):
   ```powershell
   C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -SourceDir C:\Temp\netops-ad-agent -ExpectedSha256 <雜湊> -ServerUrl http://10.10.130.124:51295 -Domain workgroup
   ```
   正常:`執行檔驗證通過`、`OK computer=<VM> domain=workgroup …`,最後表格 `NetOpsAdAgent`、`NetOpsAdWatchdog` 都是 `Running` / `Automatic`。
   出現 `SHA-256 不符`、`SHA256SUMS.txt … 不同`、`設定檢查失敗` 時停下回報,**不要改用其他雜湊重試**。
6. 確認 Agent 送出成功(VM):
   ```powershell
   Get-Content C:\ProgramData\GigaNexus\NetOpsAdAgent\logs\agent.log -Tail 20
   ```
   正常:有 `沒有本機水位:後端紀錄 None,從世代 0 …`(第一次安裝)與 `心跳成功`。出現 `HTTP 401` / `403`(Token 或電腦名稱、網域不符)停下回報。
7. 確認後端收到(主機 2):
   ```bash
   $C exec -T netops-redis redis-cli hgetall netops:ad:recv:hwm:<VM>
   ```
   正常:有 `Security:0` 等欄位,值是已收到的最大 RecordID。

**產生事件並記錄清除前的數字(VM)**

8. 產生幾筆 Security 事件(登入失敗 4625;帳號 `nobody-test` 不存在即可):
   ```powershell
   1..5 | ForEach-Object { try { Start-Process cmd.exe -ArgumentList '/c exit' -Credential (New-Object PSCredential('nobody-test', (ConvertTo-SecureString 'Wrong-Pass-1' -AsPlainText -Force))) -ErrorAction Stop } catch {} }
   ```
   正常:每次都失敗(紅字或無輸出都可以)。VM 的稽核原則沒有開「登入失敗」時不會有 4625,先執行 `auditpol /set /subcategory:"Logon" /failure:enable` 再重跑。
9. 等 10 秒後記錄清除前的最大 RecordID 與 Agent 水位:
   ```powershell
   Get-WinEvent -LogName Security -MaxEvents 1 | Select-Object RecordId, Id, TimeCreated
   ```
   ```powershell
   Get-Content C:\ProgramData\GigaNexus\NetOpsAdAgent\state\bookmarks.json
   ```
   記下:**清除前最大 RecordID(A)**、`Security` 的 `logEpoch`(應為 0)與 `lastRecordId`。

**清除 Security Log(只在 VM)**

10. 確認目前是 VM(`$env:COMPUTERNAME` 必須是 `<VM>`,**是 `GSMC-DC1` 或任何 DC 就停下,不要執行下一個指令**):
    ```powershell
    $env:COMPUTERNAME
    ```
    ```powershell
    wevtutil cl Security
    ```
11. 等 10 秒,記錄清除後的事件:
    ```powershell
    Get-WinEvent -LogName Security -Oldest -MaxEvents 3 | Select-Object RecordId, Id, TimeCreated
    ```
    記下:**清除後第一筆 RecordID(B)**(應為事件 1102「稽核記錄已清除」)。
    - B = 1(或很小):RecordID 會重新編號 → Agent 應偵測到並把世代加 1(第 12 步)。
    - B = A + 1 左右:RecordID 沒有重編 → `log_epoch` 維持 0,事件照常接續;**記錄下來回報**(H4 的偵測只在重編時才需要)。
12. 確認 Agent 的處理(VM):
    ```powershell
    Select-String -Path C:\ProgramData\GigaNexus\NetOpsAdAgent\logs\agent.log -Pattern 'RecordID 被重設' | Select-Object -Last 1
    ```
    ```powershell
    Get-Content C:\ProgramData\GigaNexus\NetOpsAdAgent\state\bookmarks.json
    ```
    B 很小時正常:日誌有 `Security 的 RecordID 被重設(水位 <A 附近> > 目前最大 <B 附近>):世代 0 → 1`,`bookmarks.json` 的 `Security.logEpoch` = 1。
    B 很小但沒有這行、或世代沒變:停下回報(清除後的事件會被當成重複丟掉)。
    再跑一次第 8 步產生新事件,10 秒後確認主機 2:
    ```bash
    $C exec -T netops-redis redis-cli hgetall netops:ad:recv:hwm:<VM>
    ```
    ```bash
    $C exec -T netops-redis redis-cli lrange netops:ad:agent-events 0 4
    ```
    ```bash
    $C exec -T netops-clickhouse clickhouse-client --query "SELECT log_epoch, count(), min(record_id), max(record_id) FROM netops.ad_events WHERE computer = '<VM>' AND channel = 'Security' GROUP BY log_epoch ORDER BY log_epoch"
    ```
    正常:hwm 多了 `Security:1`;agent-events 有 `log_record_id_reset`(`oldEpoch` 0、`newEpoch` 1);ClickHouse 有 `log_epoch` 0 與 1 兩列,世代 1 的 `min(record_id)` 是 B 附近、4625 有寫進來。ClickHouse 要等 `netops-ingest` 寫入(約 1 分鐘內)。

**水位遺失時接續(VM)**

13. 模擬 `bookmarks.json` 遺失(重裝、磁碟損壞):先暫停,刪水位檔,再恢復:
    ```powershell
    C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -Pause
    ```
    ```powershell
    Remove-Item C:\ProgramData\GigaNexus\NetOpsAdAgent\state\bookmarks.json
    ```
    ```powershell
    C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -Resume
    ```
    30 秒後看日誌:
    ```powershell
    Select-String -Path C:\ProgramData\GigaNexus\NetOpsAdAgent\logs\agent.log -Pattern '沒有本機水位' | Select-Object -Last 4
    ```
    正常:`Security 沒有本機水位:後端紀錄 Some(… logEpoch: 1, lastRecordId: <R> …),從世代 1 RecordID <R> 之後開始`(沿用後端世代,不從 0 重來);再跑第 12 步的 ClickHouse 查詢,世代 1 的 `count()` 不應因重啟而多出重複列(和重啟前相同,加上新事件)。
    出現「從世代 0」或「世代 2」(後端有紀錄、也沒有清除時):停下回報。

**要記錄的數字**:A、B、清除前後的 `logEpoch`、第 12 步三個查詢結果、第 13 步的日誌那一行、`Get-Process` 的記憶體(7.2 第 6 步同一個指令)。

14. **收尾(必做)**:防火牆改回只有 DC;VM 測完不再使用時移除並作廢 Token:
    ```powershell
    Set-NetFirewallRule -DisplayName "NetOps AD Agent 51295" -RemoteAddress 10.10.130.3
    ```
    ```powershell
    C:\Temp\netops-ad-agent\Uninstall-NetOpsAdAgent.ps1 -RemoveData
    ```
    ```bash
    sudo sh deploy/host2-set-ad-secrets.sh revoke <VM>
    ```
    revoke 後依 §4 只重建 `netops-ad-receiver`,並清掉 `<VM>` 的 Redis 狀態(§4 的 `srem` / `del` 指令)。

**選做:停止回應(hung)測試**:VM 上有 Sysinternals `pssuspend` 時,`pssuspend <NetOpsAdAgent 的 PID>` 凍結 Agent,約 45–90 秒內 Watchdog 應結束它並重啟(`watchdog.log` 有 `Agent 停止回應(…),結束行程 <PID> 後重啟`,agent-events 有 `agent_restarted`、`cause` = `hung`)。超過 120 秒沒重啟停下回報。PID 取法見 7.2 第 6 步。**不要在 DC 上做**。

### 7.2 GSMC-DC1:試裝、Watchdog、4624 事件量

前提:§2 已完成(`GSMC-DC1` 的 Token、防火牆只放行 `10.10.130.3`)。**不清除任何 Event Log**。DC 上的指令都用系統管理員 PowerShell。

1. 連線:
   ```powershell
   Test-NetConnection 10.10.130.124 -Port 51295
   ```
   正常:`TcpTestSucceeded : True`。
2. **驗證 SHA-256**(安裝前另外核對一次;值要和 CI 記錄 / 開發機畫面相同):
   ```powershell
   (Get-FileHash C:\Temp\netops-ad-agent\netops-ad-agent.exe -Algorithm SHA256).Hash
   ```
   不同就停下回報,不安裝。
3. 安裝(提示時貼上 `GSMC-DC1` 的 Token):
   ```powershell
   C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -SourceDir C:\Temp\netops-ad-agent -ExpectedSha256 <雜湊> -ServerUrl http://10.10.130.124:51295 -Domain gsmc.com.tw
   ```
   正常:同 7.1 第 5 步(`OK computer=GSMC-DC1 domain=gsmc.com.tw … include_user_logon_4624=false include_kerberos_weak_tgs=false include_dcsync_4662=false include_gpo_change_5136=false`)。
4. 確認送出(DC 日誌、主機 2 水位):
   ```powershell
   Get-Content C:\ProgramData\GigaNexus\NetOpsAdAgent\logs\agent.log -Tail 20
   ```
   ```bash
   $C exec -T netops-redis redis-cli hgetall netops:ad:recv:hwm:GSMC-DC1
   ```
   正常:日誌有 `從世代 0 RecordID … 之後開始`(往回 60 分鐘)與 `心跳成功`;水位有 `Security:0`、`System:0`、`Directory_Service:0`、`DNS_Server:0`(DC 沒有的 Channel 不會出現)。401 / 403 停下回報。主機 2 執行 §2 第 6 步的 `netops-pa` `StartedAt` / `syslogOkAt` 檢查,確認 PA 不受影響。
5. **Watchdog 自動拉起**(兩種情況,各做一次,間隔 2 分鐘以上):
   - 服務被停:
     ```powershell
     Stop-Service NetOpsAdAgent
     ```
     正常:約 15–30 秒內 `Get-Service NetOpsAdAgent` 回到 `Running`;`watchdog.log` 有啟動紀錄。
   - 行程被結束(SCM 失敗復原 10 秒 + Watchdog):
     ```powershell
     Stop-Process -Id (Get-CimInstance Win32_Service -Filter "Name='NetOpsAdAgent'").ProcessId -Force
     ```
     正常:約 10–30 秒內回到 `Running`,PID 不同。
   確認上報(主機 2):
   ```bash
   $C exec -T netops-redis redis-cli lrange netops:ad:agent-events 0 4
   ```
   正常:有 `agent_service_stopped`(`source` = `watchdog`,`cause` = `stopped`)。**90 秒內沒有回到 Running 停下回報**;不要重複測試超過 5 次 / 10 分鐘(會進入 10 分鐘冷卻,上報 `agent_start_failed`)。
6. **Agent 記憶體 / CPU**(安裝後 1 小時、24 小時各量一次):
   ```powershell
   $p = Get-Process -Id (Get-CimInstance Win32_Service -Filter "Name='NetOpsAdAgent'").ProcessId; $p | Select-Object Id, @{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB,1)}}, @{n='PrivateMB';e={[math]::Round($_.PrivateMemorySize64/1MB,1)}}, @{n='CpuSec';e={[math]::Round($_.CPU,1)}}, StartTime
   ```
   記下 WorkingSet、Private、CpuSec 與 StartTime;兩次的 `CpuSec` 差 ÷ 經過秒數 = 平均 CPU 使用率。Watchdog 用同一個指令把 `NetOpsAdAgent` 換成 `NetOpsAdWatchdog`。
   完成標準:**常駐記憶體(WorkingSet)< 20 MB**;超過時停下回報。心跳裡也有 `agent.rssMb`(主機 2:`$C exec -T netops-redis redis-cli hget netops:ad:heartbeat:GSMC-DC1 data`)。
7. **4624 與 AD-6 事件量實測**(L4、AD-6 §9.5 第 4 點;先只讀量,再**逐一**開關實測):
   - **步驟 A — 預設範圍(§9.2 預設收,四個高量開關皆 `false`)**:安裝新版 Agent 並確認 §9 稽核原則已套用後,在主機 2 查上班尖峰(08:00–09:30)與離峰各 1 小時的各 `event_id` 筆數:
     ```bash
     $C exec -T netops-clickhouse clickhouse-client --query "SELECT toStartOfHour(event_time) h, channel, event_id, count() c FROM netops.ad_events WHERE computer = 'GSMC-DC1' AND event_time >= now() - INTERVAL 1 DAY GROUP BY h, channel, event_id ORDER BY h DESC, c DESC"
     ```
     另查 DC 上最近 1 小時 / 1 分鐘的 4624 總量(只讀,不開啟 `include_user_logon_4624`;注意 4624 類型 10 RDP 已預設收):
     ```powershell
     (Get-WinEvent -LogName Security -FilterXPath "*[System[(EventID=4624) and TimeCreated[timediff(@SystemTime) <= 3600000]]]" -ErrorAction SilentlyContinue | Measure-Object).Count
     ```
     ```powershell
     (Get-WinEvent -LogName Security -FilterXPath "*[System[(EventID=4624) and TimeCreated[timediff(@SystemTime) <= 60000]]]" -ErrorAction SilentlyContinue | Measure-Object).Count
     ```
     1 小時查詢超過 1 分鐘還沒結束就 Ctrl+C 停掉,改量 10 分鐘(`600000`)再換算。
   - **步驟 B — §9.3 三個高量開關與 `include_user_logon_4624`(必須一個一個開,量完就關回 `false`,不可同時全開)**:
     1. 只開 `include_kerberos_weak_tgs`(**4769** 弱加密 TGS):
        - 重寫設定只開這一個(需要 `-ServerUrl`、`-Domain`):
          ```powershell
          C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -SourceDir C:\Temp\netops-ad-agent -ExpectedSha256 <雜湊> -ServerUrl http://10.10.130.124:51295 -Domain gsmc.com.tw -RewriteConfig -IncludeKerberosWeakTgs
          ```
        - 觀察 1 小時(尖峰優先),在主機 2 查 4769 每小時筆數與心跳 `coverageHours` / `wrapRisk`:
          ```bash
          $C exec -T netops-clickhouse clickhouse-client --query "SELECT toStartOfHour(event_time) h, count() FROM netops.ad_events WHERE computer = 'GSMC-DC1' AND event_id = 4769 AND event_time >= now() - INTERVAL 3 HOUR GROUP BY h ORDER BY h"
          ```
        - 記下每小時筆數與 `coverageHours` 後,**立刻改回全部 `false`**(執行不含任何 `-Include*` 參數的 `-RewriteConfig`)。
     2. 只開 `include_dcsync_4662`(**4662** DCSync 複寫權限;前提:§9 已完成網域根目錄 SACL):
        - 重寫設定只加 `-RewriteConfig -IncludeDcsync4662`,觀察 1 小時,在主機 2 將上面 SQL 的 `event_id = 4769` 改為 `event_id = 4662` 記錄筆數與 `coverageHours`,**量完改回全部 `false`**。
     3. 只開 `include_gpo_change_5136`(**5136** GPO / AdminSDHolder 變更;前提:§9 已完成 `CN=Policies` 與 `CN=AdminSDHolder` SACL):
        - 重寫設定只加 `-RewriteConfig -IncludeGpoChange5136`,觀察 1 小時,在主機 2 將上面 SQL 的 `event_id = 4769` 改為 `event_id = 5136` 記錄筆數與 `coverageHours`,**量完改回全部 `false`**。
     4. 若要實測 `include_user_logon_4624`(**4624** 類型 3 等全部真人帳號):同樣單獨加 `-RewriteConfig -IncludeUserLogon4624` 量 1 小時(`event_id = 4624`),量完改回 `false`。
     - 實測期間若 `coverageHours` 降到 `< 24` 小時(`wrapRisk: true`)或 Agent 記憶體超過 20 MB,立即改回全部 `false` 並回報。
     - 全部實測數字填入 `docs/test-reports/YYYY-MM-DD-ad-6.md`,由需求方依容量重算結果決定正式開啟哪些開關。
8. **Security Log 覆蓋健康度**(只讀):
   ```powershell
   Get-WinEvent -ListLog Security | Select-Object FileSize, MaximumSizeInBytes, RecordCount, LogMode
   ```
   ```bash
   $C exec -T netops-redis redis-cli hget netops:ad:heartbeat:GSMC-DC1 data
   ```
   記下大小與筆數;心跳 `channels.Security` 有 `wrapRisk: true`(最舊事件不到 24 小時)時回報,請需求方評估加大 Security Log。
9. **維護暫停 / 恢復**(DC 修補、重開機前):
   ```powershell
   C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -Pause
   ```
   ```powershell
   C:\Temp\netops-ad-agent\Install-NetOpsAdAgent.ps1 -Resume
   ```
   暫停期間不會被 Watchdog 拉起;恢復後從水位補送暫停期間的事件。暫停超過 180 秒心跳會顯示離線(預期)。

**移除方式**

- 只移除服務與執行檔(保留水位、Token、設定,之後可重裝接續):
  ```powershell
  C:\Temp\netops-ad-agent\Uninstall-NetOpsAdAgent.ps1
  ```
- DC 汰換、不再收集:
  ```powershell
  C:\Temp\netops-ad-agent\Uninstall-NetOpsAdAgent.ps1 -RemoveData
  ```
  接著在主機 2 依 §4「作廢 DC」執行 `revoke`、改防火牆、清 Redis 狀態。
  正常:`Get-Service NetOpsAdAgent, NetOpsAdWatchdog` 找不到服務。移除過程出錯停下回報,不要手動 `sc delete`。

**要記錄的數字**:安裝時間與版本、SHA-256、7.2 第 4 步水位、第 5 步兩次恢復秒數與 agent-events、第 6 步兩次記憶體 / CPU、第 7 步尖峰 / 離峰的每分 / 每小時 4624 筆數與 Agent 每小時筆數、第 8 步 Security Log 大小 / 筆數 / `wrapRisk`。

## 8. AD-3:查詢來源切換(`NETOPS_AD_SOURCE`)與 FTP 對帳補漏

> 依據:`docs/AD-AGENT-PLAN.md` §5、§6.1;需求方 2026-11-24 D1–D5。**AI 不執行本節的主機指令**。

### 8.1 切換步驟(測試區與正式區)

**測試區(主機 2)**

1. 先確認 ClickHouse 已有 AD 資料:畫面「AD › FTP Log 檔案」的對帳卡片(或 `GET /api/netops/ad/reconciliations`)昨天有 `ch` 筆數;`netops-api` 已設 `CLICKHOUSE_URL`(測試區已設)。
2. 編輯主機 2 環境檔 **`/srv/giganexus/deploy/netops.env`**(CI 的 `NETOPS_ENV_FILE`),新增或修改一行 `NETOPS_AD_SOURCE=clickhouse`。
3. 套用設定:在 GitLab **重跑最近一次 `develop` pipeline 的 `deploy-api-test`**。
   - `NETOPS_AD_SOURCE`、`NETOPS_TTL_AD_DAYS` 只有 `netops-api` 的 environment 引用,改這兩個設定不會讓 `netops-pa` 重建;日誌要看到 **`OK   netops-pa 沒有變更,沿用原容器`**。
   - 不要在主機手動執行 `docker compose ... up` 指令(少了 CI 設的 `IMAGE_TAG`,映像會落回 `netops-api:dev`)。
4. 確認:`GET /api/netops/ad/days` 的 `source` 為 `clickhouse`;AD 事件總覽有今天的資料。
5. 改回 `ftp`:從 `/srv/giganexus/deploy/netops.env` 刪掉 `NETOPS_AD_SOURCE` 那一行(或改為 `NETOPS_AD_SOURCE=ftp`),同樣在 GitLab 重跑最近一次 `develop` pipeline 的 `deploy-api-test`,並確認日誌有 `OK   netops-pa 沒有變更,沿用原容器`。

**正式區(主機 3;等 AD Agent 與正式區 ClickHouse 上線後)**

1. 確認條件同測試區第 1 步。
2. 編輯主機 3 環境檔 **`/srv/giganexus/deploy/netops.env`**,新增或修改一行 `NETOPS_AD_SOURCE=clickhouse`。
3. 套用設定:等下一次 `deploy-prod`,或由 Maintainer 在 GitLab 重跑最近一次 `main` pipeline 的 `deploy-prod`;會不會重建 `netops-pa` 以 CI 日誌為準(`OK   netops-pa 沒有變更,沿用原容器` 或 `WARN netops-pa 已重建`)。
4. 確認同測試區第 4 步。
5. 改回 `ftp`:從主機 3 `/srv/giganexus/deploy/netops.env` 刪掉該行(或改為 `NETOPS_AD_SOURCE=ftp`),同樣等下一次 `deploy-prod` 或由 Maintainer 重跑 `main` pipeline 的 `deploy-prod`(會不會重建 `netops-pa` 以 CI 日誌為準)。

### 8.2 每日對帳與補漏的判讀

- 每天 08:10 PA 對帳與每日同步(含 AD 匯入)之後,接著對帳 AD:昨天以前、`ad_events` 與 FTP 保留期內的日子(測試區 TTL 3 天 → 只有前 2 天)。
- 有缺口(`gap`)時自動送補漏給 `netops-ingest`(`NETOPS_RECON_AUTO_BACKFILL=0` 關閉),同一天每天最多自動送 1 次;也可在畫面手動送(權限 `netops.ftp.write`)。
- 補漏工作的筆數:
  - `inserted` 補寫(`source = 'ftp'`);`skipped` 已存在。
  - `waitingAgent`:RecordID 大於 Agent 水位,Agent 之後還會送,這次不補;**隔天對帳再看**。Agent 長期離線時這些列一直不補(需求方 D5,剩餘風險)。
  - `ambiguous`:判斷不出 Event Log 世代(DC 的 Security Log 被清除重編號、清除前後又沒有對得上的 Agent 列),**不寫入**;記 warn。需要時由需求方決定是否人工處理。
- 未裝 Agent 的 DC:FTP 資料全量寫入 ClickHouse(世代 0;需求方 D2)。
- 補漏只寫缺的列,`ad_heat_*` 由物化檢視自然累加(不要重建分桶);冷歸檔偵測到列數變了會自動重新歸檔。
- 前提(補漏的世代判定與日期依此計算):**DC 的時區是台北時間**(CSV 的 `TimeCreated` 沒有時區,以 +08:00 解析);**Token 對應表的 `computer` 寫大寫主機短名**(例 `GSMC-DC1`,不寫 FQDN):補漏與對帳以「主機名第一段、大寫」對應 DC,未裝 Agent 的 DC 補寫列也用這個寫法,之後裝 Agent 時兩者才會是同一台。
- 補漏的水位只採信 ClickHouse 已寫入的 Agent 列(不採信 Redis 接收端水位:事件可能還在 Stream,且 `netops-redis` 沒有 ACL)。
- `NETOPS_AD_SOURCE=ftp` 時,只要 `netops-api` 有 ClickHouse 設定,每日對帳與自動補漏仍會執行並寫入 `ad_events`(切換前先把資料補齊);不想寫入時設 `NETOPS_RECON_AUTO_BACKFILL=0`(同時關閉 PA 自動補漏)。

## 9. AD-6:稽核原則前提(DC GPO 與 SACL 設定)

> 對象:IT / 網域管理員(在 **Default Domain Controllers Policy** 或專用 DC GPO 設定)。**AI 只列步驟,不執行任何 DC 指令**。
> 依據:`docs/AD-AGENT-PLAN.md` §9.2、§9.3、§9.5 第 3 點。未開啟對應子類別或 SACL 時,Windows 本身不會寫入該 Event ID,Agent 即使啟用過濾也收不到事件。

### 9.1 進階稽核原則子類別(Default Domain Controllers Policy)

在 GPO 路徑 `Computer Configuration → Policies → Windows Settings → Security Settings → Advanced Audit Policy Configuration → Audit Policies` 設定以下子類別,並確認同一個 GPO 的 `Security Options` 已啟用 **`Audit: Force audit policy subcategory settings (Windows Vista or later) to override audit policy category settings`**(避免舊式大類原則覆蓋子類別):

| 大類(Category) | 子類別(Subcategory) | 建議設定 | 對應 Event ID |
| --- | --- | --- | --- |
| Account Logon | Credential Validation | Failure(或 Success, Failure) | `4776`(NTLM 認證;Agent 只收失敗) |
| Account Logon | Kerberos Authentication Service | Success, Failure | `4768`(失敗或弱加密 `0x17`)、`4771` |
| Account Logon | Kerberos Service Ticket Operations | Success, Failure | `4769`(§9.3 開關 `include_kerberos_weak_tgs`) |
| Account Management | Computer Account Management | Success, Failure | `4741`、`4742`、`4743` |
| Account Management | Security Group Management | Success, Failure | `4727`–`4735`、`4737`、`4754`–`4758` |
| Account Management | User Account Management | Success, Failure | `4720`、`4722`、`4723`、`4724`、`4725`、`4726`、`4738`、`4740`、`4765`、`4766`、`4767`、`4780`、`4781`、`4794` |
| DS Access | Directory Service Access | Success | `4662`(§9.3 開關 `include_dcsync_4662`;需另設 §9.2 SACL) |
| DS Access | Directory Service Changes | Success | `5136`(§9.3 開關 `include_gpo_change_5136`;需另設 §9.2 SACL) |
| Logon/Logoff | Logon | Success, Failure | `4624`(類型 10 預設收;類型 3 由開關控制)、`4625` |
| Logon/Logoff | Special Logon | Success | `4672` |
| Object Access | Other Object Access Events | Success, Failure | `4698`、`4699`、`4700`、`4701`、`4702`(排程工作) |
| Policy Change | Audit Policy Change | Success, Failure | `4719`(系統稽核原則變更) |
| Policy Change | Authentication Policy Change | Success, Failure | `4713`(Kerberos 原則)、`4706`、`4707`、`4716`(信任關係)、`4739`(網域原則) |
| Policy Change | Authorization Policy Change | Success, Failure | `4704`(指派使用者權限) |
| System | Security State Change | Success | `4616`(系統時間變更)、`1100`(事件記錄服務關閉) |
| System | Security System Extension | Success | `4697`(安裝服務) |

*(註:§9.4 不收的事件如 `4688` Process Creation、`5145` Detailed File Share 不必為本系統開啟。)*

### 9.2 4662 與 5136 的目錄 SACL 設定(開啟對應 §9.3 開關前必做)

只開 `Directory Service Access` / `Directory Service Changes` 稽核子類別還不會產生 `4662` / `5136`,必須在 Active Directory 物件上設定 SACL(使用「Active Directory 使用者及電腦」進階檢視或 `ADSI Edit` → 物件「內容 → 安全性 → 進階 → 稽核」):

1. **DCSync 偵測(`4662`)— 網域根目錄**(例如 `DC=gsmc,DC=com,DC=tw`,三網域各設一次):
   - 主體(Principal):`Everyone`
   - 類型(Type):`Success`
   - 套用到(Applies to):`This object only`
   - 權限(Permissions):只勾選以下 3 項(避免勾選「全部讀取」導致事件爆炸):
     - `Replicating Directory Changes`(`1131f6aa-9c07-11d1-f79f-00c04fc2dcd2`)
     - `Replicating Directory Changes All`(`1131f6ad-9c07-11d1-f79f-00c04fc2dcd2`)
     - `Replicating Directory Changes In Filtered Set`(`89e95b76-444d-4c62-991a-0facbeda640c`)
2. **GPO 變更偵測(`5136`)— `CN=Policies,CN=System,DC=<網域>`**:
   - 主體:`Everyone`、類型:`Success`、套用到:`This object and all descendant objects`
   - 權限:`Write all properties`、`Create all child objects`、`Delete all child objects`(或限於 `groupPolicyContainer` 子物件)
3. **AdminSDHolder 保護(`5136`)— `CN=AdminSDHolder,CN=System,DC=<網域>`**:
   - 主體:`Everyone`、類型:`Success`、套用到:`This object only`
   - 權限:`Write all properties`、`Modify permissions`、`Modify owner`

### 9.3 Security Log 容量上限

- 建議每台 DC 的 `Security` Event Log 上限調整為 **至少 1–4 GB**(依 DC 負荷調整;可在 DC GPO `Computer Configuration → Policies → Administrative Templates → Windows Components → Event Log Service → Security → Specify the maximum log file size (KB)` 設定 `1048576`–`4194240` KB(64 KB 倍數),或在 DC 以系統管理員 PowerShell 執行 `wevtutil sl Security /ms:4293918720`;**請 IT 在 DC 確認實際可設的最大值**)。
- 啟用任何 §9.3 高量開關後,依 §7.2 第 7、8 步持續觀察心跳 `channels.Security.coverageHours` 與 `wrapRisk`,確保覆寫時間維持 **>= 24 小時**(`wrapRisk: false`),並留意是否出現事件 `1104`(Security Log 已滿)。

### 9.4 查核指令與預期輸出

在 DC 以系統管理員 PowerShell 執行 `gpupdate /force` 後,執行以下只讀指令確認實際套用的子類別:

```powershell
auditpol /get /category:*
```

預期輸出應包含以下項目(英文版 Windows;中文版對應繁體中文子類別名稱,狀態應為 `成功` / `成功與失敗`):

```text
System
  Security State Change                   Success
  Security System Extension               Success
Logon/Logoff
  Logon                                   Success and Failure
  Special Logon                           Success
Object Access
  Other Object Access Events              Success and Failure
DS Access
  Directory Service Access                Success
  Directory Service Changes               Success
Account Management
  Computer Account Management             Success and Failure
  Security Group Management               Success and Failure
  User Account Management                 Success and Failure
Policy Change
  Audit Policy Change                     Success and Failure
  Authentication Policy Change            Success and Failure
  Authorization Policy Change             Success and Failure
Account Logon
  Credential Validation                   Failure (or Success and Failure)
  Kerberos Authentication Service         Success and Failure
  Kerberos Service Ticket Operations      Success and Failure
```

確認 `No Auditing` 沒有出現在上表任一子類別後,即可依 §7.2 第 7 步在 `GSMC-DC1` 進行事件量實測。
