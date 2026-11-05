# PA-560 設定規格(給網通):唯讀 API 帳號、HTTP 與 Syslog Log 轉送

> 給負責 PA-560 的網通同仁照著設定。對應 NetOps [PA-LIVE-PLAN.md](PA-LIVE-PLAN.md) §3.1、§4、§9 與 IMPL-PLAN R0。
> **PAN-OS 版本尚未確認**(P1):本文以 PAN-OS 10.x / 11.x 的畫面與欄位名稱撰寫;版本不同時,以設備畫面上「可選欄位清單」為準,表格裡標「版本」的欄位可能不存在,**不存在就整個 `"key":"$變數"` 拿掉**,其他照設。
> 設定完成後請回覆:PA-560 管理 IP、PAN-OS 版本、送出 log 的來源 IP(管理介面或 service route)、實際使用的傳輸方式(HTTP / HTTPS、TCP / SSL)。

---

## 0. 總覽

| 項目 | 方向 | 用途 | 目的 |
| --- | --- | --- | --- |
| A. 唯讀 API 帳號 | NetOps → PA-560 管理介面 `:443` | 每 10–15 秒查 Session、CPU、介面流量(只用 `show` 指令) | — |
| B. HTTP Server Profile | PA-560 → NetOps `:51293` | 威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID log(JSON) | 測試區 `10.10.130.124`、正式區 `10.10.130.122` |
| C. Syslog Server Profile | PA-560 → NetOps `:51294` | **TRAFFIC log**(量大,每天約 1,000 萬筆) | 同上 |
| D. Log Forwarding Profile | — | 把 B、C 套到安全政策 | — |

**網路放行**(PA-LIVE-PLAN §9):`10.10.130.124`、`10.10.130.122` → PA-560 管理 IP `TCP 443`;PA-560 送 log 的來源 IP → `10.10.130.124`、`10.10.130.122` 的 `TCP 51293`、`TCP 51294`。

**測試區只在測試期間轉送**:測試區的接收端點預設關閉(2026-11-05 需求方決定)。請先只把**正式區**(`10.10.130.122`)加進 B、C 的伺服器清單;測試時再由需求方通知加入 `10.10.130.124`,測完移除,避免 PA-560 對沒開的 port 一直重試。

**建議開啟順序**(PA-LIVE-PLAN §10):先開 B(HTTP,量小),觀察 1–2 天管理平面 CPU 正常,再開 C(TRAFFIC Syslog)。

---

## A. 唯讀 API 帳號(SDK 輪詢)

1. **Device > Admin Roles > Add**,名稱 `netops-readonly`:
   - **Web UI**:全部停用(Disable)。
   - **XML API**:只啟用 **Operational Requests**;Report、Log、Configuration、Commit、User-ID Agent、Import、Export、IoT Agent 全部停用。
   - **REST API**:全部停用。**Command Line**:None。
2. **Device > Administrators > Add**:帳號 `netops-ro`(名稱可自訂)、Administrator Type 選 Role Based、Profile 選 `netops-readonly`;密碼依公司規則。
3. 產生 API Key(在可連到管理介面、受信任的管理網段電腦執行):
   - **密碼放在 POST 本文、從標準輸入讀**,不要放在網址或命令列(會留在 log、shell history 與程序清單);
   - **驗證管理介面憑證**(`--cacert`);管理介面是自簽憑證時,先從 Web UI 匯出該憑證。不要用 `-k`(帳號密碼可能被攔截)。

   ```bash
   # 執行後輸入密碼(不顯示),按 Enter
   read -rs PW; printf 'password=%s' "$PW" | curl --cacert pa-mgmt.pem -X POST 'https://<PA-560 管理 IP>/api/?type=keygen' --data-urlencode 'user=netops-ro' --data-binary @- ; unset PW
   ```

   回應 `<key>…</key>` 的內容就是 API Key。**請用公司核可的方式直接交給需求方**,不要貼在聊天、Email 內文或工單;需求方會在主機上用隱藏輸入寫進 Docker secret(`deploy/host2-set-pa-secrets.sh`),程式不存帳號密碼。

| 注意 | 說明 |
| --- | --- |
| 權限範圍 | PAN-OS 的 XML API 權限只能開到「Operational Requests」這一層,無法限制只允許 `show`;NetOps 程式只送下列 4 個指令(程式內白名單,沒有任何設定、commit、封鎖的呼叫,ARCHITECTURE D22)。若內建角色 **Device administrator (read-only)** 在貴版本可以執行 XML API 的 `show` 指令,也可以改用(更嚴格),請網通評估 |
| 會執行的指令 | `show session info`、`show system resources`、`show running resource-monitor second last 1`、`show counter interface all` |
| 頻率 | 正式區每 10–15 秒一輪;測試區平常不輪詢,測試期間才開 |
| Key 失效 | 改密碼或 Device > Setup > Management > Authentication Settings 的 **API Key Lifetime** 到期時 Key 會失效,畫面會顯示「資料停止更新」;換 Key 時請通知需求方 |
| 憑證 | NetOps 預設**驗證**管理介面的 HTTPS 憑證。管理介面若是自簽憑證,請提供該憑證(或簽發的內部 CA 憑證,公開資訊、非機密);測試區可暫時不驗證,正式區不行 |

---

## B. HTTP Server Profile(TRAFFIC 以外的類型,JSON)

**Device > Server Profiles > HTTP > Add**,名稱 `netops-http`。

### B.1 Servers

| 欄位 | 值 |
| --- | --- |
| Name | `netops-prod`(測試時再加 `netops-test`) |
| Address | `10.10.130.122`(測試區 `10.10.130.124`) |
| Protocol | **HTTPS** 優先;PA-560 不信任我們的內部憑證時先用 HTTP(請回覆實際使用哪個) |
| Port | `51293` |
| TLS Version | 1.2 以上(HTTPS 時) |
| HTTP Method | `POST` |
| Username / Password | 留空(用下面的自訂標頭驗證) |

### B.2 Payload Format(每一種類型各設一筆)

每一筆都設定:

| 欄位 | 值 |
| --- | --- |
| URI Format | `/v1/logs/<類型>`,`<類型>` 見下表 |
| Headers | `Content-Type` = `application/json`;`X-NetOps-Token` = **需求方提供的 Token**(40 字以上的隨機字串,同 API Key 一樣用核可方式傳遞,不要貼在工單) |
| Parameters | 不設 |
| Payload | 下面各類型的 JSON(**整段複製**,不要換行或加空白也可以;值一律用雙引號包住) |

| 畫面上的 Log Type | URI Format | Payload |
| --- | --- | --- |
| Threat | `/v1/logs/threat` | B.3 THREAT |
| URL | `/v1/logs/url` | B.3 THREAT(同一段) |
| Data | `/v1/logs/data` | B.3 THREAT(同一段) |
| WildFire | `/v1/logs/wildfire` | B.3 THREAT(同一段) |
| Decryption(10.0 以後) | `/v1/logs/decryption` | B.4 |
| GlobalProtect(9.1 以後) | `/v1/logs/globalprotect` | B.5 |
| User-ID | `/v1/logs/userid` | B.6 |
| Traffic | **不設**(TRAFFIC 走 Syslog,見 C) | — |

> **Escaping**:Payload Format 若有 Escaping 選項,Escaped Characters 設 `"\`、Escape Character 設 `\`,讓 URL 或錯誤訊息裡的雙引號不破壞 JSON。沒有這個選項的版本照設即可;少數含雙引號的 log 會被 NetOps 判為格式錯誤而略過(會計數,不影響其他 log)。
> 設完可按 **Send Test Log**:NetOps 收到會回 `200`。回 `401` 表示 Token 不符;連不上表示網路或 Windows 防火牆未放行。

### B.3 THREAT(威脅、URL、資料過濾、WildFire 共用)

```json
{"time":"$receive_time","subtype":"$subtype","src":"$src","dst":"$dst","natSrc":"$natsrc","natDst":"$natdst","rule":"$rule","srcUser":"$srcuser","app":"$app","fromZone":"$from","toZone":"$to","dport":"$dport","proto":"$proto","action":"$action","url":"$misc","name":"$threatid","category":"$category","severity":"$severity","direction":"$direction","srcCountry":"$srcloc","dstCountry":"$dstloc","repeat":"$repeatcnt","thrCategory":"$thr_category","filedigest":"$filedigest","filetype":"$filetype"}
```

| key(NetOps) | PAN-OS 變數 | 舊版 CSV 欄位 | 備註 |
| --- | --- | --- | --- |
| `time` | `$receive_time` | Receive Time | |
| `subtype` | `$subtype` | Threat/Content Type | |
| `src` / `dst` | `$src` / `$dst` | Source / Destination address | |
| `natSrc` / `natDst` | `$natsrc` / `$natdst` | NAT Source / Destination IP | |
| `rule` | `$rule` | Rule | |
| `srcUser` | `$srcuser` | Source User | |
| `app` | `$app` | Application | |
| `fromZone` / `toZone` | `$from` / `$to` | Source / Destination Zone | |
| `dport` | `$dport` | Destination Port | |
| `proto` | `$proto` | IP Protocol | |
| `action` | `$action` | Action | |
| `url` | `$misc` | URL/Filename | |
| `name` | `$threatid` | Threat/Content Name | |
| `category` | `$category` | Category / URL Category | WildFire 時為判定(benign、malware…) |
| `severity` | `$severity` | Severity | |
| `direction` | `$direction` | Direction | |
| `srcCountry` / `dstCountry` | `$srcloc` / `$dstloc` | Source / Destination Country | |
| `repeat` | `$repeatcnt` | Repeat Count | |
| `thrCategory` | `$thr_category` | thr_category | 版本:9.1 以後 |
| `filedigest` / `filetype` | `$filedigest` / `$filetype` | filedigest / filetype | |

### B.4 Decryption(PAN-OS 10.0 以後)

```json
{"time":"$receive_time","src":"$src","dst":"$dst","rule":"$rule","app":"$app","dport":"$dport","action":"$action","error":"$error","errIndex":"$err_index","status":"$status","tls":"$tls_version","proxyType":"$proxy_type","policy":"$policy_name","sni":"$sni","repeat":"$repeatcnt"}
```

| key | PAN-OS 變數 | 舊版 CSV 欄位 | 備註 |
| --- | --- | --- | --- |
| `error` | `$error` | Error | |
| `errIndex` | `$err_index` | err_index | 版本:欄位名稱請對照畫面 |
| `status` | `$status` | Decryption Status | 版本:部分版本沒有,沒有就拿掉 |
| `tls` | `$tls_version` | Client TLS Version / tls_version | |
| `proxyType` | `$proxy_type` | proxy_type | |
| `policy` | `$policy_name` | policy_name | |
| `sni` | `$sni` | Server Name Indication | 版本:欄位名稱請對照畫面 |
| 其他 | 同 B.3 | | |

### B.5 GlobalProtect(PAN-OS 9.1 以後;Device > Log Settings 設定,見 D.2)

```json
{"time":"$receive_time","eventId":"$eventid","stage":"$stage","auth":"$auth_method","user":"$srcuser","region":"$srcregion","machine":"$machinename","publicIp":"$public_ip","privateIp":"$private_ip","clientVer":"$client_ver","os":"$client_os","error":"$error","description":"$opaque","status":"$status","portal":"$portal","repeat":"$repeatcnt"}
```

| key | PAN-OS 變數 | 舊版 CSV 欄位 |
| --- | --- | --- |
| `eventId` / `stage` / `auth` | `$eventid` / `$stage` / `$auth_method` | Event ID / Stage / Authentication Method |
| `user` / `region` / `machine` | `$srcuser` / `$srcregion` / `$machinename` | Source User / Source Region / Machine Name |
| `publicIp` / `privateIp` | `$public_ip` / `$private_ip` | Public IP / Private IP |
| `clientVer` / `os` | `$client_ver` / `$client_os` | Client Version / Client OS |
| `error` / `description` / `status` / `portal` | `$error` / `$opaque` / `$status` / `$portal` | Error / Description / Status / Portal |

### B.6 User-ID(Device > Log Settings 設定,見 D.2)

```json
{"time":"$receive_time","subtype":"$subtype","ip":"$ip","user":"$user","dataSourceType":"$datasourcetype","dataSource":"$datasource","repeat":"$repeatcnt"}
```

| key | PAN-OS 變數 | 舊版 CSV 欄位 | 備註 |
| --- | --- | --- | --- |
| `ip` / `user` | `$ip` / `$user` | Source IP / User | |
| `dataSourceType` / `dataSource` | `$datasourcetype` / `$datasource` | Data Source Type / Data Source | 版本:部分版本為 `$datasourcename`,請對照畫面 |

---

## C. Syslog Server Profile(TRAFFIC)

**Device > Server Profiles > Syslog > Add**,名稱 `netops-syslog`。

### C.1 Servers

| 欄位 | 值 |
| --- | --- |
| Name | `netops-prod`(測試時再加 `netops-test`) |
| Syslog Server | `10.10.130.122`(測試區 `10.10.130.124`) |
| Transport | **SSL** 優先(需信任我們的內部憑證);不行時用 **TCP**。**不要用 UDP**(量大時會掉、也無法防偽造) |
| Port | `51294` |
| Format | `BSD` 或 `IETF` 都可以 |
| Facility | `LOG_USER` |

### C.2 Custom Log Format → Traffic

只設 **Traffic** 一項(其他類型不要送到這個 profile;送來會被拒收):

```json
{"type":"$type","time":"$receive_time","subtype":"$subtype","src":"$src","dst":"$dst","natSrc":"$natsrc","natDst":"$natdst","rule":"$rule","srcUser":"$srcuser","app":"$app","fromZone":"$from","toZone":"$to","inIf":"$inbound_if","outIf":"$outbound_if","sport":"$sport","dport":"$dport","natDport":"$natdport","proto":"$proto","action":"$action","bytes":"$bytes","sent":"$bytes_sent","recv":"$bytes_received","packets":"$packets","start":"$start","elapsed":"$elapsed","category":"$category","srcCountry":"$srcloc","dstCountry":"$dstloc","endReason":"$session_end_reason","appRisk":"$risk_of_app","appCategory":"$category_of_app","appSubcat":"$subcategory_of_app","appTech":"$technology_of_app","srcHost":"$src_host","dstHost":"$dst_host"}
```

**Escaping**(同頁):Escaped Characters 設 `"\`,Escape Character 設 `\`。

| key | PAN-OS 變數 | 舊版 CSV 欄位(`server/lib/palog.js`) | 備註 |
| --- | --- | --- | --- |
| `type` | `$type` | Type | 用來確認是 TRAFFIC |
| `time` | `$receive_time` | Receive Time | |
| `subtype` | `$subtype` | Subtype | start / end / drop / deny |
| `src` / `dst` | `$src` / `$dst` | Source / Destination address | |
| `natSrc` / `natDst` | `$natsrc` / `$natdst` | NAT Source / Destination IP | |
| `rule` / `srcUser` / `app` | `$rule` / `$srcuser` / `$app` | Rule / Source User / Application | |
| `fromZone` / `toZone` | `$from` / `$to` | Source / Destination Zone | |
| `inIf` / `outIf` | `$inbound_if` / `$outbound_if` | Inbound / Outbound Interface | |
| `sport` / `dport` / `natDport` | `$sport` / `$dport` / `$natdport` | Source / Destination / NAT Destination Port | |
| `proto` / `action` | `$proto` / `$action` | IP Protocol / Action | |
| `bytes` / `sent` / `recv` / `packets` | `$bytes` / `$bytes_sent` / `$bytes_received` / `$packets` | Bytes / Bytes Sent / Bytes Received / Packets | |
| `start` / `elapsed` | `$start` / `$elapsed` | Start Time / Elapsed Time (sec) | |
| `category` | `$category` | Category | URL 類別 |
| `srcCountry` / `dstCountry` | `$srcloc` / `$dstloc` | Source / Destination Country | |
| `endReason` | `$session_end_reason` | Session End Reason | |
| `appRisk` / `appCategory` / `appSubcat` / `appTech` | `$risk_of_app` / `$category_of_app` / `$subcategory_of_app` / `$technology_of_app` | Risk / Category / Subcategory / Technology of app | 版本:10.2 以後;舊版沒有就拿掉這 4 個 |
| `srcHost` / `dstHost` | `$src_host` / `$dst_host` | Source / Destination Hostname | 版本:10.0 以後(Device-ID);沒有就拿掉 |

> 一則 log 長度約 0.8–1.5 KB;NetOps 單則上限 16 KB。
> Syslog 沒有 Token,NetOps 靠**來源 IP**(主機 Windows 防火牆只放行 PA-560)與 SSL 辨識,所以請回覆 PA-560 送 log 的實際來源 IP。
> 若 PA-560 的 Syslog SSL 可以設定**用戶端憑證**(Device > Certificate Management 指定給 Syslog 的憑證),請一併設定並提供簽發的 CA 憑證(公開資訊):NetOps 會要求並驗證這張憑證,這是 Syslog 唯一能確認來源是 PA-560 的方式。

---

## D. 套用

### D.1 Log Forwarding Profile(Objects > Log Forwarding > Add,名稱 `netops-forward`)

| Match List | Log Type | Filter | Forward Method |
| --- | --- | --- | --- |
| `traffic` | traffic | All Logs | Syslog:`netops-syslog` |
| `threat` | threat | All Logs | HTTP:`netops-http` |
| `url` | url | All Logs | HTTP:`netops-http` |
| `data` | data | All Logs | HTTP:`netops-http` |
| `wildfire` | wildfire | All Logs | HTTP:`netops-http` |

- 在要監控的**安全政策規則** Actions > Log Forwarding 選 `netops-forward`。已經有其他 Log Forwarding Profile 的規則(例如送 FTP 匯出、Panorama),請把上面的 Match List **加進既有的 profile**,不要取代(現有 FTP 匯出要繼續,FTP 是歷史查詢來源)。
- Decryption(10.0 以後):在解密政策規則 Options > Log Forwarding 選一個含 `decryption` Match List(→ `netops-http`)的 profile。

### D.2 Device > Log Settings

| 區塊 | 設定 |
| --- | --- |
| GlobalProtect(9.1 以後) | Add → Filter All Logs → HTTP:`netops-http` |
| User-ID | Add → Filter All Logs → HTTP:`netops-http` |

設定後 **Commit**。

---

## E. 設定後的核對(需求方與網通一起)

| # | 項目 | 方法 |
| --- | --- | --- |
| E1 | API Key 可用 | NetOps 即時監控頁「設備狀態」有數字、收集器狀態正常 |
| E2 | HTTP 轉送 | Send Test Log 回 200;即時 log 出現威脅 / URL 等類型 |
| E3 | Syslog 轉送 | 即時 log 出現 TRAFFIC;收集器狀態的「格式錯誤」計數不持續增加(持續增加表示 Custom Log Format 或 Escaping 有誤) |
| E4 | 負載 | 網通觀察 PA-560 管理平面 CPU 與 log 轉送佇列(開 TRAFFIC 前後比較) |
| E5 | 每秒筆數 | 需求方核對實際每秒筆數,必要時調整 PA-LIVE-PLAN §5 的保留時間(R0 第 5 步) |

---

## 附錄 F. NetOps 主機端設定(需求方在主機執行;Claude 不執行)

> 主機 2(測試區 `10.10.130.124`)為例;主機 3(正式區 `10.10.130.122`)在 D2 比照,IP 換成 `10.10.130.122`、Compose 專案名換成 `giganexus-netops-prod`。
> 為什麼需要:Docker 在 WSL 內,PA-560 連不到 WSL;要由 Windows 轉送。`netops-pa` 的 port 只綁 WSL 的 `127.0.0.1`(區網無法繞過 Windows 直接連)。

### F.1 機密(合併 `feature/r1-deploy` 後、第一次部署前)

```bash
# 主機 2 的 WSL;還沒有 API Key 時直接 Enter
sudo sh deploy/host2-set-pa-secrets.sh
```

預期輸出(第一次):

```text
已產生 pa_http_token
PA-560 API Key(輸入時不顯示;還沒有就直接按 Enter):
pa_api_key 為空檔:SDK 輪詢維持關閉(PA_POLL_ENABLED=0)
netops.env 新增 PA_POLL_ENABLED
netops.env 新增 PA_RECEIVE_ENABLED
netops.env 新增 PA_HOST
netops.env 新增 PA_ALLOWED_SOURCES
-r-------- 1 1000 1000  0 … /srv/giganexus/netops-secrets/pa_api_key
-r-------- 1 1000 1000 48 … /srv/giganexus/netops-secrets/pa_http_token
完成。…
```

要把 Token 交給網通時:`sudo sh deploy/host2-set-pa-secrets.sh --show-token`(只顯示在終端機)。

### F.2 Windows 轉送與防火牆(主機 2,系統管理員 PowerShell;開接收前做一次)

```powershell
# 轉送到 WSL 的 localhost(WSL localhost 轉送;同 Gateway rollback.ps1 的做法,實測若不通改 ::1)
netsh interface portproxy add v4tov4 listenaddress=10.10.130.124 listenport=51293 connectaddress=127.0.0.1 connectport=51293
netsh interface portproxy add v4tov4 listenaddress=10.10.130.124 listenport=51294 connectaddress=127.0.0.1 connectport=51294
# 只放行 PA-560 送 log 的來源 IP(網通回覆後填入;這條規則才是真正只收 PA-560 的地方)
New-NetFirewallRule -DisplayName "NetOps PA log 51293-51294" -Direction Inbound -Protocol TCP -LocalPort 51293,51294 -RemoteAddress <PA-560 送 log 的來源 IP> -Action Allow
netsh interface portproxy show v4tov4
```

預期:`show v4tov4` 列出兩筆 `10.10.130.124 51293 → 127.0.0.1 51293`、`51294 → 51294`。主機 2 的 80 / 443 由 Traefik 轉送,這裡不影響。

**限制(需要需求方決定)**:portproxy 會遺失來源 IP(Gateway DEPLOYMENT §6.1 實測),容器看到的是 Docker 閘道,所以 F.3 的 `PA_ALLOWED_SOURCES` 只能填閘道,實際上「只收 PA-560」完全靠這條 Windows 防火牆規則;HTTP 另有 Token,Syslog 沒有。若要在容器內也能檢查 PA-560 的 IP,要改用 Gateway 的 Traefik(`deploy/windows-l4/`)加 TCP 入口並帶 PROXY protocol,且 `netops-pa` 要支援 PROXY protocol,屬 Gateway repo 的修改,未實作。

### F.3 開啟接收(測試時)

1. 第一次部署後查 Docker 閘道(`netops-pa` 看到的來源):

   ```bash
   sudo docker network inspect giganexus-netops-test_pa-ingress -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
   ```

   預期類似 `172.2x.0.1`。
2. 編輯 `/srv/giganexus/deploy/netops.env`:`PA_ALLOWED_SOURCES=<上一步的閘道>`、`PA_RECEIVE_ENABLED=1`。
3. 重建:**重跑 GitLab CI `develop` 最新 pipeline 的 `deploy-api-test`**(用 CI 建置的同一個映像)。手動時要指定目前部署的映像、不在主機上重新建置:
   `cd /srv/giganexus/shared/NetOps 之類的 repo 目錄 && sudo IMAGE_TAG=<目前部署的 commit 短 SHA> GW_ENV=test docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml up -d --no-build --force-recreate netops-pa`(SHA 可由 `sudo docker ps --format '{{.Image}}' | grep netops-pa` 查到)。
4. `sudo docker logs --tail 20 giganexus-netops-test-netops-pa-1`,預期:`接收端點已啟用:HTTP :51293、Syslog :51294;允許來源 172.2x.0.1/32`。
5. 若日誌出現「拒絕不在允許清單的來源 X」,X 才是實際看到的來源,把 `PA_ALLOWED_SOURCES` 改成 X 再重建。
6. 請網通把 `10.10.130.124` 加進 HTTP / Syslog Server Profile(B.1、C.1),測完移除,並把 `PA_RECEIVE_ENABLED` 改回 0。

### F.4 開啟 SDK 輪詢(測試時)

1. 拿到 API Key 後:`sudo rm /srv/giganexus/netops-secrets/pa_api_key && sudo sh deploy/host2-set-pa-secrets.sh`(隱藏輸入)。
2. `netops.env`:`PA_HOST=<PA-560 管理 IP>`、`PA_POLL_ENABLED=1`;管理介面是自簽憑證且還沒拿到憑證時,測試區可暫設 `PA_TLS_INSECURE=1`(正式區不可)。
3. 重建 `netops-pa`(同 F.3 第 3 步),日誌預期:`SDK 輪詢已啟用:每 15 秒(PA <IP>:443)`;即時監控頁「設備狀態」有數字。
4. 測完 `PA_POLL_ENABLED=0` 再重建。

### F.4.1 安全限制(目前版本)

- 經 portproxy 時容器看不到真實來源(F.2),**沒有設定用戶端憑證(F.6)前,Syslog 51294 只靠 Windows 防火牆**;主機 2 本機與 WSL 內的程序(包括 CI Runner 上的 job)可以直接連 WSL 的 `127.0.0.1:51294` 送假的 TRAFFIC log。所以在 F.6 完成前,**即時 TRAFFIC 資料只作為監控參考,不作為資安判斷依據**(資安判斷以 HTTP 轉送的威脅類 log 與 FTP 歷史為準)。
- 主機 3(正式區)已有規則 `Docker-WSL2-AllServices-TCP`(來源不限):D2 上線前先確認它的 port 範圍不含 51293 / 51294,否則 F.2 限制來源的規則會被繞過。

### F.5 Redis 記憶體(建議)

`netops-redis` 的 RDB 存檔會 fork;WSL 若 `vm.overcommit_memory` 為 0,Redis 日誌會出現警告,大量資料時存檔可能失敗。需要時由需求方在 WSL 設 `sysctl vm.overcommit_memory=1`(影響整個 WSL,先確認對 Gateway 等其他容器無影響)。上線後每天記錄 `docker exec giganexus-netops-test-netops-redis-1 redis-cli info memory`(PA-LIVE-PLAN §5)。

### F.6 憑證(選用;建議至少正式區設定)

主機目錄 `/srv/giganexus/netops-pa-tls`(`deploy/host2-set-pa-secrets.sh` 建立,唯讀掛到容器 `/run/pa-tls`)。放入檔案後在 `netops.env` 設對應變數,再依 F.3 第 3 步重建:

| 檔案(建議檔名) | `netops.env` | 用途 | 權限 |
| --- | --- | --- | --- |
| `pa-mgmt-ca.pem` | `PA_CA_FILE=/run/pa-tls/pa-mgmt-ca.pem` | 驗證 PA-560 管理介面(SDK 輪詢);設了就不需要 `PA_TLS_INSECURE` | 644(公開資訊) |
| `server.crt`、`server.key` | `PA_TLS_CERT_FILE=/run/pa-tls/server.crt`、`PA_TLS_KEY_FILE=/run/pa-tls/server.key` | 接收端點改 HTTPS(51293)與 Syslog SSL(51294);PA-560 要信任簽發的 CA | crt 644;key `chown 1000:1000`、400 |
| `pa-client-ca.pem` | `PA_TLS_CLIENT_CA_FILE=/run/pa-tls/pa-client-ca.pem` | 要求並驗證 PA-560 的用戶端憑證(C 節) | 644 |

正式區沒有 `server.crt` / `server.key` 時接收端點不會啟動;需求方決定接受明文時才設 `PA_RECEIVE_PLAINTEXT=1`。私鑰是機密:由需求方放入,不要貼到聊天或工單。
