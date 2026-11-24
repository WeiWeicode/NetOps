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
2. **NAS**:`sudo sh host2-setup-pa-archive.sh ad`(主機 3 也可用;`/mnt/nas-docker` 在主機 3 是 `docker-backup` 分享,先確認位置,同 RUNBOOK-prod.md §4.2 第 1 步)。
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

對應表改完要**只重建 `netops-ad-receiver`** 才生效(其他 DC 斷線幾秒,Agent 會重送;`netops-pa` 不受影響):

```bash
docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml up -d --no-deps --wait --force-recreate netops-ad-receiver
```

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
