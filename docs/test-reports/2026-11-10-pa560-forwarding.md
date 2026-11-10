# PA-560 Log 轉送設定紀錄(測試區 10.10.130.124)

> 2026-11-09 ~ 2026-11-10。依 [PA-FORWARDING-SPEC.md](../PA-FORWARDING-SPEC.md) B、C、D 節設定 PA-560(PAN-OS 12.1.7-h3,管理介面 `10.10.115.35`)。
> 操作方式:需求方以自己的帳號(`netops`)在瀏覽器與 SSH CLI 操作,Claude 看截圖逐步指導並核對。Claude 未輸入帳密與 Token。
> 本文**不含** `X-NetOps-Token` 的值,也不含 HTTP Server Profile 的 Username / Password。

## 1. 環境與做法

| 項目 | 內容 |
| --- | --- |
| 設備 | PA-560,PAN-OS 12.1.7-h3,管理介面 `https://10.10.115.35/` |
| 操作帳號 | `netops`(需求方本人登入) |
| 接收端 | 測試區主機 2 `10.10.130.124`:HTTP `51293`、Syslog TCP `51294`(明文,需求方同意) |
| 內建瀏覽器 | 無法使用:管理介面是出廠自簽憑證,SAN 只有 `DNS:044109003916`;全數字主機名稱會被瀏覽器當成 IPv4 解析而判為無效網址,所以信任憑證加 hosts 也連不上。改由需求方自己的瀏覽器操作(暫加的 hosts 與根憑證已請需求方移除) |

## 2. 設定前的現況(唯讀盤點)

| 項目 | 現況 |
| --- | --- |
| Device > Server Profiles > HTTP / Syslog / SCP | 都沒有 |
| Device > Log Settings(System、Configuration、User-ID、HIP Match、GlobalProtect、IP-Tag) | 全空 |
| Objects > Log Forwarding | 只有內建 `IoT Security Default Profile`(送 Panorama) |
| FTP 匯出 | **Device > Scheduled Log Export**,8 筆 `to-130.66-*`(traffic 07:45、threat 07:40、url 12:00、wildfire 13:30、data 13:30、globalprotect 14:00、userid 08:50、decryption 13:45),每天從本機 log 匯出,**和 Log Forwarding profile 無關**,本次設定不影響 |
| Policies > Security | 162 條(啟用 157、停用 5);**全部沒有套用 Log Forwarding profile** |

因為沒有任何規則已有 profile,不需要「加進既有 profile」,直接新建 `netops-forward`。

## 3. 新增的設定(只新增,沒有修改或刪除既有設定)

### 3.1 Device > Server Profiles > HTTP:`netops-http`

| 欄位 | 值 |
| --- | --- |
| Tag Registration | 不勾 |
| Server | Name `netops-test`、Address `10.10.130.124`、Protocol `HTTP`、Port `51293`、HTTP Method `POST` |
| Username / Password | **12.1 必填**,填無意義假值(接收端不看 `Authorization`;值不記錄) |

Payload Format(其餘 Log Type:Config、System、Traffic、Tunnel、Authentication、HIP Match、Iptag 保持 Default):

| Log Type | Format 名稱 | URI Format | Payload |
| --- | --- | --- | --- |
| Threat | `netops-threat` | `/v1/logs/threat` | 規格 B.3 原樣 |
| URL | `netops-url` | `/v1/logs/url` | 規格 B.3 原樣 |
| Data | `netops-data` | `/v1/logs/data` | 規格 B.3 原樣 |
| WildFire | `netops-wildfire` | `/v1/logs/wildfire` | 規格 B.3 原樣 |
| Decryption | `netops-decryption` | `/v1/logs/decryption` | 規格 B.4,`status` 改用 `$decryption_status`(見 §4) |
| Globalprotect | `netops-globalprotect` | `/v1/logs/globalprotect` | 規格 B.5 原樣 |
| User-ID | `netops-userid` | `/v1/logs/userid` | 規格 B.6 原樣 |

每一筆 HTTP Headers:`Content-Type` = `application/json`;`X-NetOps-Token` = 需求方自行貼上(來源 `/srv/giganexus/netops-secrets/pa_http_token`)。Parameters 不設。未按 Send Test Log(主機 2 尚未開接收)。

### 3.2 Device > Server Profiles > Syslog:`netops-syslog`

| 欄位 | 值 |
| --- | --- |
| Server | Name `netops-test`、Syslog Server `10.10.130.124`、Transport `TCP`、Port `51294`、Format `BSD`、Facility `LOG_USER` |
| Custom Log Format | 只設 **Traffic**(規格 C.2 原樣);其他類型 Default |
| Escaping | 勾選;Escaped Characters `"\`、Escape Character `\` |

### 3.3 Objects > Log Forwarding:`netops-forward`

| Match List | Log Type | Filter | Forward Method |
| --- | --- | --- | --- |
| `traffic` | traffic | All Logs | Syslog `netops-syslog` |
| `threat` | threat | All Logs | HTTP `netops-http` |
| `url` | url | All Logs | HTTP `netops-http` |
| `data` | data | All Logs | HTTP `netops-http` |
| `wildfire` | wildfire | All Logs | HTTP `netops-http` |
| `decryption` | decryption | All Logs | HTTP `netops-http` |

Panorama、Quarantine、Built-in Actions 都不設。

### 3.4 Device > Log Settings

| 區塊 | Name | Filter | 轉送 |
| --- | --- | --- | --- |
| User-ID | `netops-userid` | All Logs | HTTP `netops-http` |
| GlobalProtect | `netops-globalprotect` | All Logs | HTTP `netops-http` |

### 3.5 安全規則套用(Actions > Log Forwarding = `netops-forward`)

需求方決定:**啟用中的規則全部套用,不含 `interzone-default`**。

| 範圍 | 條數 | 說明 |
| --- | --- | --- |
| 啟用中的一般規則 | 154 | 2026-11-09 匯出時啟用 155 條,其中 `Lansweeper port-1` 之後被其他管理員停用(running 為 `disabled yes`),依決定不套用 |
| `intrazone-default` | 1 | 內建規則,設定後自動 Override,只改 Log Forwarding |
| **不套用** | `interzone-default` + 6 條停用規則 | 停用:`test`、`test-1`、`Lansweeper port-1`、`VPN-GSMC-All` 等 |

套用方式:CLI `set rulebase security rules "<名稱>" log-setting netops-forward`(`intrazone-default` 最後改在網頁 Actions 頁設定)。核對:網頁 `(log-setting eq 'netops-forward')` 顯示 **156 / 162**(154 條一般規則 + 2 條固定顯示的預設規則),並以篩選後匯出的 CSV 與預定清單比對無缺漏。

## 4. PAN-OS 12.1.7-h3 與規格的差異

在設備的欄位清單逐一核對規格用到的變數:

| 類型 | 結果 |
| --- | --- |
| Threat / URL / Data / WildFire(B.3,25 個) | 全部存在 |
| Decryption(B.4,15 個) | **`$status` 不存在,改用 `$decryption_status`**;其餘 14 個存在(`tls_version`、`sni`、`err_index`、`error`、`proxy_type`、`policy_name` 都有)。另有 `c_tls_version`、`s_tls_cipher` 等 client / server 前綴欄位,沿用規格的 `tls_version`。NetOps 的 key 仍是 `status`,接收端不用改 |
| GlobalProtect(B.5,16 個) | 全部存在 |
| User-ID(B.6,7 個) | 全部存在;另有 `datasourcename`,沿用 `datasource` |
| Traffic(C.2,35 個) | 全部存在,含標「版本」的 `risk_of_app`、`category_of_app`、`subcategory_of_app`、`technology_of_app`、`src_host`、`dst_host` |

其他畫面差異:

- HTTP Server 的 **Username / Password 必填**(規格原寫留空)。
- HTTP Payload Format **沒有 Escaping 選項**;Syslog Custom Log Format 有(已設定)。含雙引號的少數 HTTP log 可能被 NetOps 判為格式錯誤而略過(會計數)。
- HTTP Payload Format 的 Log Type 比規格多 Config、System、Traffic、Tunnel、Authentication、HIP Match、Iptag,都保持 Default。
- Payload 欄右上角的下拉箭頭是可插入的欄位清單;上方 **Pre-defined Formats**(NSX、ServiceNow 範本)不使用。

`PA-FORWARDING-SPEC.md` 已同步更新(B.1、B.2 Escaping、B.4、G3、G6、G7、G9)。

## 5. Commit

| 時間 | 內容 | 執行者 | 結果 |
| --- | --- | --- | --- |
| 2026-11-09 16:35–16:49 之間(推定) | 第一批:`netops-http`、`netops-syslog`、`netops-forward`、Log Settings 兩筆、`Lansweeper app` / `Lansweeper port` 的 log-setting。**是被其他管理員的 Commit 一併送出**(Job 19072 benson 16:35、19086 weiyang 16:46、19092 weiyang 16:48 之一),不是本次流程的 Commit | benson / weiyang | 已在 running config(2026-11-10 `show config running \| match netops` 確認) |
| 2026-11-10 上午 | 第二批:152 條規則 + `intrazone-default` 的 log-setting(Change Summary 153 項,全部為 netops 的 Security Rule edit) | `netops`,Commit Changes Made By: netops(只送自己的變更) | **Completed / Successful** |

Commit 前核對:Commit 對話框只有 `(1) netops`、範圍 `policy-and-objects`;`show config diff` 只有 `+ log-setting netops-forward;`,沒有刪除或其他修改;需求方確認後才 Commit。

Commit 訊息裡的兩則提示(**既有狀況,本次未處理**):

- `Default master-key configured please change to custom master-key`
- `The latest API KeyGen was executed on Mon Nov 9 14:25:23 2026 with the deprecated algorithm`:指 NetOps 輪詢用的 API Key。PAN-OS 建議改用 API Key Certificate(Setup > Management > Authentication Settings),是否處理由需求方與網通決定。

## 6. 封包核對(主機 2)

2026-11-10 08:44 在主機 2 以 `pktmon` 過濾 port 51293、51294 抓 60 秒(只診斷,未改防火牆;抓完已移除過濾器並刪除暫存檔):

| 來源 → 目的 | 封包數(pktmon 各元件合計) |
| --- | --- |
| `10.10.115.35` → `10.10.130.124:51293`(HTTP) | 40 |
| `10.10.115.35` → `10.10.130.124:51294`(Syslog TCP) | 8 |

都是 TCP SYN 重試(主機 2 尚未設 portproxy,連線被拒是預期)。結論:

- **PA-560 有送出 HTTP 與 Syslog 轉送。**
- **PA 送 log 的來源 IP 是 `10.10.115.35`(管理介面)**。主機的 Windows 防火牆規則(規格附錄 F.2)要放行這個 IP。
- 網路路徑 PA-560 → 10.10.130.124 的 TCP 51293、51294 可到達主機 2,不需要網管另外放行。

## 7. 待辦與注意

| # | 項目 | 誰 |
| --- | --- | --- |
| 1 | 主機 2 設 portproxy 與 Windows 防火牆(來源 `10.10.115.35`),開 `PA_RECEIVE_ENABLED`(規格附錄 F.2、F.3) | 主討論串安排,需求方執行 |
| 2 | 開接收後到 HTTP Server Profile 按 **Send Test Log** 確認回 200(E2),觀察 TRAFFIC 與格式錯誤計數(E3) | 需求方 |
| 3 | 規格建議「測試區只在測試期間轉送」;目前 PA 會持續對 10.10.130.124 重試。長時間不測時,考慮把 `netops-test` 從兩個 Server Profile 移除,或停用接收端前先告知網通 | 需求方決定 |
| 4 | TRAFFIC 已對 154 條規則 + `intrazone-default` 開啟;請網通觀察管理平面 CPU 與 log 轉送佇列(E4) | 網通 |
| 5 | `X-NetOps-Token` 在操作截圖中部分露出(僅需求方本機),建議測完更換(重產後要同步更新 7 個 Payload Format 的 header) | 需求方 |
| 6 | 其他管理員 Commit 時請選 **Commit Changes Made By: 自己**,避免一併送出他人未完成的變更 | 網通 |
| 7 | 正式區(10.10.130.122)尚未加入 Server Profile;管理介面憑證(G4)與 API Key 演算法提示待處理 | 需求方 / 網通 |

## 8. 操作上的經驗

- PA CLI 一次貼多行時,回應會和輸入交錯,分段交界的行容易被截斷而失敗(`Invalid syntax.`)。一次貼一行最可靠;大量設定後要用網頁篩選 `(log-setting eq '<profile>')` 加篩選後匯出 CSV 逐條比對。
- `show config diff` 在設定模式要加 `run`;`| match` 的字串不要加引號;`| except value` 可避免 Token 出現在輸出。
- 網頁篩選 `neq` 不會比對「沒有設定該欄位」的規則,核對要用 `eq`。內建的 intrazone / interzone 規則不論篩選條件都會顯示。
