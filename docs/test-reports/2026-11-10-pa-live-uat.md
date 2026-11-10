# NetOps 即時監控(R1)測試區驗收報告(2026-11-10)

> 範圍:MR !48(收集器開關與驗收修正)的重驗項目 1–5,以及 PA-560 log 轉送開啟後的接收驗收(HTTP 類型)。
> 方式:Claude 內建瀏覽器操作測試區,**登入、登出、換帳號都由需求方本人完成**(Claude 沒有輸入帳密);主機 2 只執行唯讀指令。每一個按開關、刪除都先問過需求方並取得同意。
> 寫入操作(都經同意):按「輪詢:停用 / 開啟」各一次、「接收:停用 / 開啟」各一次;以 viewer 送一次被拒絕的 `PUT collector-control`(403,沒有副作用);刪除知識庫測試筆記 1 則。沒有改主機設定,接收是主討論串先開的。
> 第三階段(09:54 起):Syslog 通了之後驗 TRAFFIC,以及 !51(`70e24b0`)合併部署後的 6 項重驗(§3.3、§3.4);另按「輪詢:停用 / 開啟」各一次(都經同意並已恢復)。§2 前兩階段表是當時結果,後來修正的項目在「結果」欄與 §4 註明。
> 補驗(11:09 後):giga-observe 的 `/v1/ping` 401、串流 429(§3.5)與 TRAFFIC、威脅對 PA Monitor 的詳細欄位(需求方回報一致)。
> 仍未驗:威脅 log 在 NetOps 沒有來源 Port,PA 那邊有沒有未確認;「接收未啟用」文案;串流重連當下觸發 refresh 的時序;`gw-bff POST /api/auth/refresh` 403 的來源。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 網址 | `https://giganexus-test.gigasolar.com.tw/netops/firewall/live` |
| 部署版本 | 第一、二階段 `origin/develop` `300d032`(約 08:54 重建;09:42 起 `985d620d`);第三階段 !51 後 `70e24b0`(映像 `70e24b01`,10:32 部署);以下為第一階段:`netops-api`、`netops-pa`、`netops-kb-backup` 映像 `300d032c`(約 08:54–08:57 重建);`netops-redis` `redis:7.4-alpine` healthy。任務說明寫的映像 `6c0ceaaa` 與實際不同 |
| 設定(實測) | `GW_ENV=test`、`PA_POLL_ENABLED=1`、**`PA_RECEIVE_ENABLED=1`**(主討論串 ~09:00 前已開,任務說明原為 0)、允許來源 `172.26.0.1/32` |
| 帳號 | S112009(`netops-admin`);V112001(`employee`、`netops-viewer`,以 `GET /api/auth/me` 確認) |
| 瀏覽器 | Claude 內建瀏覽器;串流補送另用頁面內 `fetch` 自建 SSE 連線(因 `EventSource` 不能讀 id) |
| 主機 2 指令(唯讀) | `docker ps`、`docker logs`(`netops-pa`、`netops-api`、`giga-observe-test-gno-backend-1`)、`docker inspect` 的 `PA_*` / `GW_ENV` 環境變數、`redis-cli XLEN / XRANGE ... COUNT 1 / HMGET / HGETALL / INFO memory / DBSIZE` |
| 截圖 | 未進版控 |

## 2. 結果摘要

### 第一階段(!48 重驗)

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | 頁首「輪詢中」、設備狀態最後更新時間、排行與 log 的「接收端點未啟用」文案 | **部分通過**:「輪詢中」、最後更新時間(2026/11/10 08:56:57)通過;**接收在驗收時已開啟**,頁首為「接收中」,「接收未啟用」文案驗不到(未驗) |
| 2 | 輪詢開關 | **通過**(含「停止更新」偵測);「接收按鈕停用並說明原因」**不適用**(接收已開) |
| 3 | viewer 看不到開關、PUT 回 403 | **通過** |
| 4 | 第 3 個分頁顯示串流上限訊息、429 不再每 10 秒增加 | **通過**(giga-observe 端的 429 計數未查,見 §4) |
| 5 | giga-observe 不再出現新的 `GET /v1/ping` 401 | 當時**未驗**(容器日誌不記請求);11:09 後從 GigaItApp「架構觀測 › 錯誤」查到:**通過**(最後一次 401 是 20 小時前,之後部署 4 次沒有新增,見 §3.5) |

### 第二階段(接收,HTTP 類型)

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | 頁首「接收中」、日誌「接收端點已啟用」、無「拒絕不在允許清單」 | **通過** |
| 2 | 排行(5 / 15 / 60 分鐘、各維度、類型切換) | 10:00 前 **失敗**:畫面沒有類型與時間切換器(見 §4.1);API 資料正常。**!51 部署後重驗通過**(§3.4 項目 1);TRAFFIC 排行 Syslog 通後驗過(§3.3) |
| 3 | 即時 log、篩選、暫停、欄位對應 | 威脅 / URL 欄位與 PA Monitor 一致(威脅未單獨核對);IP、Action 篩選通過;暫停鈕當時不存在 → **!51 後暫停 / 繼續通過**(§3.4 項目 2);Port 篩選與 TRAFFIC 欄位在 Syslog 通後**通過**(§3.3;bytes、封包、持續秒未核) |
| 4 | Redis Stream 增加、記憶體、`MINID` 修剪 | **通過**:Stream 增加;TRAFFIC 修剪確認有作用(§3.3) |
| 5 | 串流補送(`Last-Event-ID`) | **通過**(HTTP:59 / 59、無重複、無遺漏;TRAFFIC:無重複,缺漏皆有 `dropped` / `skipped` 標示,見 §3.3) |
| 6 | 接收開關 | **通過** |
| 7 | 接收錯誤計數、樣本 | **通過**:`dropped`、`rejected`、`malformed`、`redisFailed` 全為 0(Syslog 通後也一樣),沒有樣本可記 |
| — | 知識庫測試筆記刪除、備份還原結論 | **完成**(見 §5) |

### 第三階段(Syslog 通後的 TRAFFIC,以及 !51 重驗)

| # | 項目 | 結果 |
| --- | --- | --- |
| S1 | TRAFFIC 即時 log 持續、Port 篩選、欄位對 PA Monitor | **通過**(Port=443:50 筆全是 443;3 筆對 PA Monitor 一致;bytes、封包、持續秒未核) |
| S2 | TRAFFIC 排行 5 / 15 / 60 分鐘 | **通過**(各窗口筆數遞增:10:28 為 30,753 / 101,079 / 243,334) |
| S3 | Redis 記憶體、每小時增量、`MINID` 1 小時修剪 | **通過**(修剪有作用;穩態約 291 MB) |
| S4 | 串流補送(頁面 `EventSource`,5 分鐘重連) | **通過**:重複 0;TRAFFIC 量大時伺服器依設計捨棄約 22%,有標示 |
| S5 | 心跳錯誤計數 | **通過**:全 0 |
| F1 | !51 項目 1:排行類型與 5 / 15 / 60 分鐘切換(TRAFFIC、威脅、URL) | **通過** |
| F2 | !51 項目 2:即時 log 暫停 / 繼續 | **通過** |
| F3 | !51 項目 3:輪詢停用時介面流量顯示「停止更新」 | **通過**(15–18 秒內,非即時) |
| F4 | !51 項目 4:URL 過濾 log 名稱欄改為 URL 類別 | **通過**(畫面無 9999;API 的 `name` 仍是 `9999(9999)`) |
| F5 | !51 項目 5:同帳號第 4 個分頁才顯示串流上限 | **通過(需求方回報)**:需求方開 4 個分頁,第 4 個出現上限訊息;分頁計法(是否含 Claude 的分頁)未確認 |
| F6 | !51 項目 6:登入過期後串流重連走 `/api/auth/refresh` | **通過,時序未完整驗證**:`me` 401 → `refresh` 200 → `me` 200,串流全 200、無 401、無「串流未連線」 |

## 3. 細節

### 3.1 第一階段

**項目 1**:08:56:57 開頁,頁首「輪詢中」「接收中」,文案「設備狀態來自 SDK 輪詢;排行與即時 log 來自接收端點」;「設備狀態最後更新:2026/11/10 08:56:57」。重啟後第一輪介面流量全是「—」。

**項目 2(開關)**
- 第一次按「輪詢:停用」→ 畫面「切換失敗:功能尚未啟用(路由未發佈)」,**requestId `728a901f91d4`**(404 `ROUTE_NOT_FOUND`)。原因是 `netops.pa-live.collector-control` 路由草稿還沒在 GigaItApp 發佈;需求方發佈後重試。
- 09:00:30 按「輪詢:停用」→ 提示「已要求暫停輪詢」;`netops-pa` 日誌 09:00:34(UTC 01:00:34)「收集器開關:輪詢暫停、接收繼續(蔣佳緯(S112009) 於 2026-11-10T01:00:30.168Z 設定)」。
- 09:01:03(約 30 秒)頁首「輪詢暫停」。
- 09:01:46 設備狀態最後更新「—(沒有 60 秒內的資料)」,Session、管理平面 CPU、資料平面 CPU、整體流量卡片「停止更新」(最後快照 09:00:27,60 秒到期)。
- 09:01:49 按「輪詢:開啟」→ 日誌「輪詢繼續、接收繼續」;09:01:57 設備狀態恢復,第一輪介面流量為「—」。
- 整個過程頁首「接收中」不受影響;「接收:停用」按鈕可按(因接收已開)。
- 觀察:暫停期間「介面流量」區塊仍顯示舊數值(例如 ae1 ↑20.3 Mbps),沒有變成「—」,只有 KPI 卡片變「停止更新」。

**項目 3(viewer)**:需求方登出後登入 V112001;`GET /api/auth/me` 顯示 `employeeNo=V112001`、角色 `employee`、`netops-viewer`,NetOps 權限只有 `.read` / `.use`,沒有 `netops.pa-live.manage`。頁面沒有「輪詢 / 接收」開關。以頁面內 `fetch` 帶 `gn_csrf` 的 `X-CSRF-Token` 送 `PUT /api/netops/pa-live/collector-control`,內容 `{"pollPaused":false}` → **403 `PERMISSION_DENIED`,requestId `1fa1bdc05141d226f0120d310b3e7851`**(「您沒有此功能的權限」;`pollPaused:false` 為「繼續」,即使通過也不會暫停)。

**項目 4(串流上限)**
- 先以 admin 測:seed + 2 個新分頁,**只開 2 個分頁就有分頁被擋**(程式每人上限 2,`live-routes.ts` `maxPerUser ?? 2`),表示另有串流佔名額(需求方自己的瀏覽器也開著即時監控);admin 結果不能判定。
- 改以 viewer 重測(名額乾淨):第 1、2 個分頁「串流連線中」;第 3 個分頁「串流未連線 / 串流連線數已達上限,請關閉其他即時監控分頁(30 秒後再試)」。
- `netops-api` 日誌 429:09:03:51 兩筆、09:04:21 兩筆,**間隔 30 秒**(一次嘗試 = 串流 + 探測各一筆),符合「30 秒起倍增」,不是每 10 秒。giga-observe 的 429 計數**沒查**(容器日誌不記請求)。
- 測完已關閉所有新增分頁。

**項目 5(`/v1/ping` 401)**:`giga-observe-test-gno-backend-1` 最近 3 小時日誌只有 1 行(`[status] netops-web: healthy → degraded`),不記請求,`/v1/ping`、429 計數都是 0 但**不能當證據**。需要查 giga-observe 的資料庫或 GigaItApp 監控畫面。

### 3.2 第二階段

**接收狀態**:`netops-pa` 日誌「接收端點已啟用:HTTP :51293、Syslog :51294;允許來源 172.26.0.1/32」,「拒絕不在允許清單的來源」0 次。心跳:`httpOkAt` 持續更新,`dropped` / `rejected` / `malformed` / `redisFailed` 全 0,**沒有 `syslogOkAt`**。

**Redis(唯讀)**

| 時間 | traffic | threat | url | data | globalprotect | wildfire / decryption / userid | `received` | `used_memory` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 09:07 | 0 | 111 | 212 | 2071 | 26 | 0 | 2420 | 7.82 MB |
| 09:11 | 0 | 139 | 286 | 3306 | 36 | 0 | 3770 | 8.55 MB |
| 09:34 | 0 | 334 | 824 | 8430 | 91 | — | 9659 | — |
| 09:36 | 0 | 334 | 835 | 8679 | 93 | 0 | 9909 | 11.88 MB(DBSIZE 743) |

`maxmemory` 2 GB。尚無 TRAFFIC,所以記憶體不代表 TRAFFIC 開通後的用量(PLAN §5 估算 TRAFFIC 每秒約 90–130 筆)。

**排行(畫面)**:即時排行區卡片標題右側**沒有類型下拉與 5/15/60 分鐘切換**,固定顯示 TRAFFIC 15 分鐘「0 筆 / 這段期間沒有資料 / 接收端點運作中,這段期間沒有收到這種 log」。**排行 API 正常**(admin,`GET /api/netops/pa-live/top`):

| type | 分鐘 | 結果 |
| --- | --- | --- |
| threat | 5 / 15 / 60 | count 46 / 152 / 152;`kpis.action` alert 124、block 28;`tops.name` 第一名 `Suspicious HTTP Evasion Found(14984)`(15 分鐘 38 次) |
| url | 5 / 15 / 60 | count 93 / 239 / 239;`tops.host` 第一名 `125.227.14.217`(15 分鐘 68 次) |
| data | 5 / 15 / 60 | count 3313 / 7224 / 7224;`tops.name` 第一名 `ZIP(52004)` |
| traffic | 5 / 15 / 60 | `totals` 空、`tops` 全空(沒有資料) |

**即時 log**
- 威脅:上線後持續新增;欄位 `time`、`subtype`、`src`、`dst`、`rule`、`app`、`fromZone`、`toZone`、`dport`、`proto`、`action`、`url`、`name`、`category`、`severity`、`direction`、`srcCountry`、`dstCountry`、`repeat`、`thrCategory`。樣本(`GET /logs?type=threat`):`time 2026/11/10 09:03:00`、`src 10.10.130.3`、`dst 10.10.15.236`、`rule 130 to other GSC`、`app dns-base`、`fromZone Server`、`toZone WAN`、`dport 53`、`proto udp`、`action block`、`name generic:amlzqi.com(52316871)`、`severity high`、`direction server-to-client`、`receivedAt 2026-11-10T01:02:52.307Z`。
- **欄位對照 PA-560 Monitor**:需求方並排截圖核對 **URL Filtering** 一筆(NetOps 09:17:23、`informational`、來源 10.10.112.25、目的 104.18.32.47、URL `ab.chatgpt.com`;PA Monitor Receive Time 11/10 09:17:31、LAN→WAN、來源 10.10.112.25、目的 104.18.32.47、App `openai-chatgpt`、alert)→ **一致**。原本請需求方核對的威脅筆(上表樣本)沒有單獨核對,需求方回覆的是這筆 URL;威脅類型欄位對照 PA Monitor **未驗**。
- 時間:NetOps「收到時間」比 PA Monitor 的 Receive Time **早約 8 秒**(威脅樣本 `time` 09:03:00 比 `receivedAt` 09:02:52 晚 8 秒;URL 筆 09:17:23 對 09:17:31),推測是 PA-560 與主機 2 時鐘差約 8 秒,**未驗證**。
- URL log 的「名稱」欄顯示 `9999(9999)`(URL 類型沒有威脅名稱,顯示的是 PA 預設值),可能讓使用者困惑。
- 篩選(套用鈕):
  - Action = `block`(威脅):28 筆,全是 `block`;與排行 API `block 28` 一致。
  - IP = `172.16.2.2`(威脅):50 筆,來源或目的皆為該 IP(0 筆不符)。
  - Port = `443`(威脅):結果 50 筆,但威脅表沒有 Port 欄,**無法判斷是否正確**,待 TRAFFIC。
- **暫停鈕不存在**(見 §4.1),「暫停」項目無法驗。

**串流補送(項目 5)**
- 第一輪(失敗,不算):用頁面內 `fetch` 讀 SSE,同時開著需求方的瀏覽器與本頁串流,名額已滿,回 **429 NETOPS_STREAM_BUSY**;離開即時監控頁釋放名額後重跑。
- 第二輪(登入過期):讀滿 300 秒後伺服器結束連線,**重連回 401 `UNAUTHENTICATED` 請先登入(requestId `a686459eab5bb526e806b014e9741130`)**。這是我自建的 `fetch`(不會自動刷新 token)在登入超過約 14 分鐘後的結果;一般瀏覽器頁面的 `EventSource` 重連是否會自動刷新 token **未驗**。重新載入頁面後以舊 `Last-Event-ID` 重連,因已超過 5 分鐘(`RESUME_MAX_MS`)從最新開始,只收到 1 筆,與設計一致(不補 5 分鐘前),不算補送測試。
- 第三輪(有效):09:28:49 起讀 `types=threat`,300 秒後伺服器結束連線;立即(`gapSec=0`)帶 `Last-Event-ID: threat:1794274409403-0` 重連 → `open` 事件 `resumed:true`、`gap:[]`;重連後收到 12 筆,第一筆 id `1794274414412-0`(接在 `1794274409403-0` 之後),**與重連前 42 筆重複 0 筆**。以 `GET /logs?type=threat&limit=200` 核對 id 範圍 `1794274123981-0`…`1794274439457-3` 內 Redis 有 **59 筆,兩段合計收到 59 筆,缺漏 0、多出 0**。
- 伺服器結束連線時間:300 秒(與規格 `maxSec: 300` 一致)。

**接收開關(項目 6,需求方同意)**
- 基準(09:34:55):`received` 9659、`paused` 0、`receivePaused` 0;Stream:threat 334、url 824、data 8430、globalprotect 91。
- 09:35:16 按「接收:停用」→ 日誌「收集器開關:輪詢繼續、接收暫停(蔣佳緯(S112009) …)」;頁首「輪詢中 / 接收暫停」,排行與 log 文案「接收已暫停(測試區手動開關),沒有 log 來源」。
- 09:35:48:`received` 9737、`paused` 113、`receivePaused` 1;09:36:14:`received` 9737(不變)、`paused` **227**(增加);Stream 凍結(threat 334、url 829、data 8481、globalprotect 93;與基準的差異發生在切換到生效的 5 秒內)。`dropped`、`rejected`、`malformed` 仍是 0(暫停丟棄只計 `paused`,不算錯誤)。
- 09:36:26 按「接收:開啟」→ 日誌「輪詢繼續、接收繼續」;09:36:48:`received` 9909、`paused` 304、`receivePaused` 0,Stream 恢復增加(data 8679)。輪詢全程沒有被暫停。

### 3.3 Syslog 通後的 TRAFFIC(2026-11-10 09:54 起)

**前因**:PA-560 對 `netops-syslog`(TCP,51294)在 11-09 16:38、16:46 與 11-10 08:45 各有一次「syslog connection failed for 10.10.130.124:51294, error: 110」(PA System log,主討論串提供)。當時主機 2 還沒設 portproxy,所以連不上;**PA 失敗後不會自動重試,要在 PA 重新 Commit 才會再連**。需求方重新 Commit 後 PA(10.10.115.35)→ 51294 Established。**D2 正式區注意**:主機接收開好之後,要再 Commit 一次 Syslog profile。

**Redis 與速率(唯讀)**

| 時間 | traffic | `used_memory` | `received` | DBSIZE | TRAFFIC 最舊一筆(UTC) |
| --- | --- | --- | --- | --- | --- |
| 09:54:49 | 7,269 | 21.21 MB | 12,657 | 1086 | 01:53:41 |
| 10:24:04 | 213,075 | 164.31 MB | 229,088 | 1900 | 01:53:41 |
| 10:56:24 | 394,540 | 291.37 MB(尖峰 292.26 MB) | 156,438(部署重啟後重算) | 2778 | **01:56:24** |

- 速率:TRAFFIC 約 107–117 筆/秒(09:53:41 起 68 秒 7,269 筆;之後 29 分 15 秒 +205,806 筆)。
- 增量:09:54 → 10:24 增加 143.1 MB(約 293 MB/小時);每筆約 700 bytes(含統計鍵)。TRAFFIC 明細 1 小時穩態約 395 k 筆,記憶體約 291 MB,離 `maxmemory` 2 GB 還遠;threat、url、data 保留 2 天,每小時增量遠小於 TRAFFIC(10:56 分別 1,139 / 3,211 / 34,132 筆),但 2 天累積量未驗。
- **`MINID` 修剪**:10:24 時最舊一筆是 01:53:41(09:53:41 起算的第一筆);10:56:24 最舊一筆變成 **01:56:24Z = 剛好 1 小時前**(筆數沒有繼續線性增加,394,540 對 395 k 預期),修剪有作用。核對方法:`XRANGE netops:pa:log:traffic - + COUNT 1`,其 ID 的毫秒時間戳應等於現在 UTC 減 1 小時;threat、url、data 最舊仍是 00:56:58Z(2 天內,尚未到修剪時間)。
- 心跳:`dropped`、`rejected`、`malformed`、`redisFailed`、`paused` 全 0。

**TRAFFIC 排行**:畫面 15 分鐘 8,268 筆、2.6 GB(維度:Action、協定、來源 IP、目的 IP、App、Rule 等,來源第一名 10.10.130.3)。API(`GET /pa-live/top?type=traffic`):10:28 的 5 / 15 / 60 分鐘為 30,753 / 101,079 / 243,334 筆,`perMinute` 分別 5 / 15 / 60 點;來源第一名 `10.10.130.3`、App 第一名 `dns-base`、Rule 第一名 `User to SF app-1`。Syslog 剛通時(約 3 分鐘資料)三個窗口相同,屬資料不足。10:24 有一次排行請求回應沒有內容(狀態碼沒記),`netops-api` 同時段無非 200,重試正常,**原因不明**。

**TRAFFIC 即時 log 與 Port 篩選**:表頭「收到時間、ACTION、來源、目的、PORT、APP、規則、位元組」。Port=443:50 筆 Port 全是 443。

**欄位對 PA Monitor(需求方並排截圖,查詢語法 `( addr.src in … ) and ( addr.dst in … ) and ( port.src eq … )`)**:3 筆都一致。

| NetOps 筆(`time`) | 來源 → 目的 | PA Monitor |
| --- | --- | --- |
| 09:56:49 | 10.10.112.20:56965 → 40.79.167.9:443 | Receive Time 09:56:49、`end`、LAN→WAN、`ssl`、`allow`、Rule `Lan to WAN app`、ae3→ae1、`tcp-fin`、Port 一致 |
| 09:56:48 | 10.10.119.6:56717 → 104.18.16.27:443 | 同上,`tcp-rst-from-client` |
| 09:56:48 | 10.10.112.20:60195 → 23.211.113.25:443 | 同上,`tcp-rst-from-client` |

截圖沒露出 bytes(455,582 / 830,650 / 994,332)、sent / recv、封包、持續秒,這幾欄**未核**。NetOps `time` = PA 的 Receive Time;NetOps「收到時間」(`receivedAt`)比它早約 8–11 秒,推測 PA 與主機 2 時鐘差。

**串流補送(頁面 `EventSource`,TRAFFIC,5 分鐘重連)**:在頁面攔截 `EventSource`,再用前端路由切走切回讓頁面自己建立連線。
- 09:57:07 連線;**10:02:07 伺服器結束(error、readyState 0)、10:02:12 自動重連**,之後每 5 分鐘一輪(10:07:12、10:12:17、10:17:22、10:22:27、10:27:32),連續 6 次都成功。
- 10:02 的重連前 29,040 筆、重連後 2,920 筆;**重複 0**。
- Redis 同區間共 42,005 筆;頁面收 31,960 + `dropped` 9,300(伺服器每次最多送 200 筆,超過者捨棄並標 `dropped`)+ 2 個「跟不上、跳到最新」的 `skipped` 批次(09:59:21、10:02:14)。重連後第一批就帶 `skipped`:舊游標到現在超過每次讀取上限,直接跳到最新。
- 結論:沒有靜默遺漏,每筆缺漏都有標示;但 TRAFFIC 約 107 筆/秒時,**即時 log 畫面只看得到約 76% 的 log**,這是 `SEND_PER_TICK` 200 的設計上限(`live-routes.ts`),需求方要知道。

### 3.4 !51 合併後重驗(`70e24b0`,pipeline #762 成功;映像 `netops-api` / `netops-pa` / `netops-kb-backup` `70e24b01`,10:32 部署)

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| 1. 排行類型 + 5 / 15 / 60 分鐘 | **通過** | 排行卡片標題右側出現類型下拉與 5 / 15 / 60 分鐘切換。TRAFFIC:5 分鐘 32,961 筆 / 2.6 GB、15 分鐘 100,542 / 12.6 GB、60 分鐘 279,431 / 50.2 GB;威脅(已乘上重複次數):78 / 207 / 778;URL:285 / 582 / 1,568;每種類型的維度標題也隨之換(威脅:Action、嚴重度、類型;URL:Action、類別) |
| 2. 即時 log 暫停 / 繼續 | **通過** | 威脅類型。10:34:50 按「暫停」:按鈕變「繼續」、出現「已暫停」,45 秒內第一筆維持 10:34:14 不動。10:36:00 按「繼續」:標示消失、暫停期間 Redis 收到的 3 筆威脅在畫面補回 3 筆 |
| 3. 輪詢停用 → 介面流量「停止更新」 | **通過** | 10:37:09 按停用;18 秒內介面流量區塊變「停止更新(輪詢暫停,介面計數已清除)」,頁首「輪詢暫停」(**15–18 秒內,不是立即**)。10:38:12 按「開啟」:16 秒後恢復,第一輪「—」、第二輪有值;**輪詢已恢復** |
| 4. URL 類別 | **通過** | 表頭「URL 類別」,內容 `medium-risk` 等,50 筆沒有 `9999`。API 回傳的 `name` 仍是 `9999(9999)`(只是畫面不顯示) |
| 5. 第 3 個分頁可連、第 4 個才擋 | **通過(需求方回報)** | 需求方開 4 個分頁,第 4 個顯示「串流連線數已達上限,請關閉其他即時監控分頁(30 秒後再試)」、頁首「串流未連線」(截圖);之後關了 2 個。Claude 的分頁是否算在這 4 個內未確認,上限值 3 依 `7805ac0` 的變更 |
| 6. 登入過期後串流重連 | **通過,時序未完整驗證** | 網路請求(只留最近一批,先前 220 筆已被丟棄):`GET /api/auth/me` 401 → `POST /api/auth/refresh` 200 → `me` 200,連續多次;`/api/netops/pa-live/stream` 全 200,沒有 401,少數 `ERR_ABORTED` 是切換篩選時本頁自己中斷。畫面維持「串流連線中」。無法證明「串流重連時」剛好觸發 refresh |

### 3.5 補驗(11:09 後):giga-observe 與 PA Monitor 詳細欄位

**giga-observe**(GigaItApp「Gateway 管理 › 架構觀測 › 錯誤」,近 7 天,4xx 與全部;唯讀)

| 服務 / API | 狀態 | 次數 | 最後發生 | 判讀 |
| --- | --- | --- | --- | --- |
| `netops-api GET /v1/ping` | 401 | 24 | 20 小時前 | **!48 項目 5 通過**:之後 `300d032`、`985d620`、`70e24b0`、`371a3d3` 四次部署沒有新增 |
| `netops-api GET /v1/pa-live/stream` | 429 | 25 | 29 分鐘前(需求方開第 4 個分頁) | **!48 項目 4 的 giga-observe 端通過**:7 天只有 25 次,沒有每 10 秒一次的累積 |
| `netops-web GET /api/netops/pa-live/snapshot` | 502 | 13 | 1 分鐘前(11:08) | !53 合併後 develop 重新部署(映像 `371a3d38`)使 `netops-api` 重啟,屬部署重啟 |
| `gw-bff POST /api/auth/refresh` | 403 | 10 | 約 10:40 | **來源不明**(見 §7 第 9 項) |
| `gw-bff GET /api/auth/me` | 401 | 62 | 剛剛 | 過期後換發流程的一部分(多分頁並行) |
| `gno-backup JOB dailyBackup`(mongodump 執行失敗) | 500 | 7 | 9 分鐘前 | giga-observe 自己的備份,與 NetOps 無關 |

**PA Monitor 詳細欄位(需求方回報「一致」;需求方沒有貼截圖,Claude 未逐欄看到)**

| 類型 | NetOps 值 |
| --- | --- |
| Traffic(start 11:09:42,收到 11:10:49) | 10.10.112.37:64732 → 134.33.4.22:443;Rule `Lan to WAN port`、App `ms-update`;LAN → WAN;allow;bytes 106,107(sent 101,094 / recv 5,013);封包 105;持續 53 秒;`tcp-fin` |
| Threat(11:08:36) | 10.10.130.3 → 10.10.10.10:53 udp;Rule `130 to other GSC`、App `dns-base`;Server → WAN;block;`generic:amlzqi.com(52316871)`、severity `high`、spyware、server-to-client、URL `amlzqi.com`;**NetOps 沒有來源 Port**(API 的 `sport` 空) |

## 4. 失敗項目與可能問題

### 4.1 即時排行與即時 log 的控制項沒有渲染(前端缺陷)— **已由 !51 修正,§3.4 項目 1、2 重驗通過**(以下為 10:00 前的發現)

- 現象:即時排行卡片右上沒有「類型」下拉與「5 / 15 / 60 分鐘」切換;即時 log 卡片右上沒有「暫停 / 繼續」按鈕。排行固定顯示 TRAFFIC 15 分鐘,所以只要 TRAFFIC 沒資料,畫面就一直是空的(API 其他類型都有資料)。
- 可能原因:`frontend/src/pages/firewall/Live.vue` 第 377、410 行用 `<template #extra>`,但 `frontend/src/ui/components/GCard.vue` 只有 `header` / `actions` / `footer` 插槽(`GCard.vue:19–31`),`extra` 不會渲染;實際 DOM 的 `header` 在 `.spacer` 後只有 `<!---->`。對照:`TopList.vue:43` 有 `<template v-if="$slots.extra" #actions>` 轉接,`Dashboard.vue:277` 直接用 `#actions`。
- 重現:admin 開 `/netops/firewall/live` → 捲到「即時排行」「即時 log」標題右側,沒有控制項;`read_page` 的互動元素清單也沒有暫停按鈕與排行下拉。
- 影響:使用者無法切換排行類型 / 時間、無法暫停即時 log(PLAN §8 的「可暫停」);單元測試(`npm test` 98 通過)沒涵蓋 slot 渲染。
- 建議:`#extra` 改 `#actions`,並補元件測試(或用掛載測試檢查按鈕存在)。

### 4.2 TRAFFIC / Syslog 沒有資料 — **已解決(09:54 起有資料,見 §3.3)**;以下為 09:54 前的狀況

- 原因:PA 連 51294 失敗(主機尚未設 portproxy)後不重試,需求方重新 Commit Syslog profile 後恢復。正式區要記得:接收開好後再 Commit 一次。
- 現象:`netops:pa:log:traffic` 長度 0;心跳沒有 `syslogOkAt`;排行 `traffic` 全空。HTTP 類型(threat、url、data、globalprotect)有資料。主討論串 09:00 前後以 30 秒 pktmon 看主機 2 的 51294 沒有連線。
- 影響:TRAFFIC 排行、欄位對應(PAN-OS 12.1 差異)、Port 篩選、TRAFFIC 1 小時 `MINID` 修剪、`INFO memory` 的真實用量都未驗。

### 4.3 項目 5(giga-observe `/v1/ping` 401)與 giga-observe 429 — **已補驗通過(§3.5)**

- 當時 giga-observe backend 容器日誌不記請求所以查不到;後來改從 GigaItApp「架構觀測 › 錯誤」查到。

### 4.4 其他觀察(未判定為缺陷)

1. 暫停輪詢後「介面流量」仍顯示最後一輪的值(§3.1 項目 2)— **!51 已修**(§3.4 項目 3);但 15–18 秒才變,不是立即。
2. admin 驗項目 4 時只開 2 個分頁就被擋;每人 2 條串流與需求方自己的瀏覽器分頁一併計算,多裝置同時開會互相影響。!51 把上限改成 3,多裝置仍會互相影響。
3. 自建 `fetch` SSE 在登入約 14 分鐘後重連回 401;!51 後頁面會先換發(§3.4 項目 6),時序未完整驗證。
4. URL 過濾 log 的「名稱」欄顯示 `9999(9999)` — **!51 已改成 URL 類別**;API 仍回 `name: 9999(9999)`。
5. **TRAFFIC 即時 log 只顯示約 76%**:每次最多送 200 筆(`SEND_PER_TICK`),約 107 筆/秒時其餘捨棄(`dropped`)或因跟不上而跳過(`skipped`);有標示,但需求方要知道畫面不是完整 log,完整的要查 Log 明細。
6. 10:24 一次排行 API 回應沒有內容,原因不明(`netops-api` 同時段無非 200);沒再重現。
7. NetOps `time`(PA Receive Time)比 `receivedAt` 晚約 8–11 秒;推測 PA 與主機 2 時鐘差,未驗證。
8. 任務說明的映像 `6c0ceaaa` 與測試區實際 `300d032c` 不同(測試區在驗收前約 3 分鐘重建)。

## 5. 刪除知識庫測試筆記與備份還原結論(主討論串請求,需求方同意)

- 刪除前 `GET /api/netops/kb/notes` → `total 1`,只有「UAT-備份測試-0000」(id `202611091350-77c63c`)。
- `DELETE /api/netops/kb/notes/202611091350-77c63c`(帶 CSRF)→ **204**;刪除後 `GET /api/netops/kb/notes` → `total 0`。
- 備份還原結論(主討論串已驗,本次未重驗,數字照轉):20261110 備份 `files=2`,`sha256sum -c` OK,解開後與線上 `diff -r` 一致。

## 6. 潛在風險(測試全通過項目之外)

- Redis 記憶體:TRAFFIC 開通後穩態約 291 MB(約 395 k 筆明細 + 統計),離 `maxmemory` 2 GB 還遠;threat / url / data 保留 2 天,2 天累積量(目前 2 小時 1.1 k / 3.2 k / 34 k 筆)沒驗,正式區流量可能不同。
- PA 的 Syslog TCP 失敗後不會自動重試(PA System log:error 110),主機接收端重啟、網路中斷後都可能需要在 PA 重新 Commit;心跳的 `syslogOkAt` 停止更新時要有人處理(監控 / 告警未驗)。
- 接收來源 `172.26.0.1`(Docker bridge gateway)是 portproxy 轉發後的來源,實際 PA 來源 `10.10.115.35` 由主機防火牆限制,`PA_ALLOWED_SOURCES` 本身無法區分 PA 與其他本機轉發來源。

## 7. 建議交給 Claude 處理

**已修(!51,測試區重驗通過)**:排行切換、log 暫停、介面流量停止更新、URL 類別、串流上限 3、串流 401 先換發(§3.4)。Syslog 通後 TRAFFIC 排行、Port 篩選、欄位對照、`MINID`、串流補送都已驗(§3.3)。

**還要追**

1. ~~giga-observe `/v1/ping` 401 與 429 計數~~:**已補驗通過**(§3.5)。
2. **TRAFFIC 即時 log 只顯示約 76%**(§4.4 第 5 項):**需求方決定可以提高上限**(2026-11-10)。待開發:調高 `SEND_PER_TICK`(`live-routes.ts`,目前 200)與相關讀取上限(`READ_PER_TICK`),並重測約 107–117 筆/秒時的 `dropped` / `skipped`、頁面 CPU 與記憶體、`MAX_PENDING_BYTES`(慢消費者中斷);也可評估依篩選先過濾再取樣,或在畫面明確寫「流量太大,部分 log 未顯示」並顯示累計 `dropped`。上限沒有數字,要由實作時決定。
3. ~~TRAFFIC bytes、封包、持續秒、威脅欄位對 PA Monitor~~:**需求方回報一致**(§3.5)。仍沒逐一核的:PAN-OS 12.1 的 Traffic 差異欄位(`risk_of_app`、`category_of_app`、`src_host`、`dst_host`)在 NetOps 的呈現;**威脅 log 在 NetOps 沒有來源 Port**(API 回的 `src` 只有 IP、沒有 `sport`),PA 威脅 log 有沒有 Source Port 未確認。
4. **「接收未啟用」文案**:測試區接收已常開,正式區上架前要重驗(用 mock 或暫時關閉接收)。
5. **登入過期後串流重連的時序**(§3.4 項目 6):只看到 `me` 401 → `refresh` 200,沒有逐步證明「串流重連時」觸發 refresh;可在正式區上架前用較短的 token 逾時重測。
6. **一次排行 API 無內容**(§4.4 第 6 項):沒再重現,若再出現請記狀態碼與 requestId。
7. **PA Syslog TCP 失敗不重試**:D2 正式區要在接收開好後 Commit 一次;建議在 `HANDOFF` 或 D2 檢查清單寫明,並考慮監控 `syslogOkAt`(!51 的 `118f901` 已補文件,內容我沒逐項核對)。
8. **`time` 與 `receivedAt` 差 8–11 秒**:確認 PA / 主機 NTP;畫面顯示的是哪一個要讓使用者知道。
9. **`gw-bff POST /api/auth/refresh` 403**(§3.5):近 7 天 10 次,最後約 10:40;我的網路紀錄裡 refresh 都是 200,來源與原因不明,可能是多個請求同時換發(換發權杖輪替)造成。建議查 BFF 日誌的 requestId,並確認 !51 的「先換發」是否會同時送出多個 refresh。
10. **驗收未覆蓋**:threat / url / data 2 天保留的修剪、Redis 長時間(多日)穩定性、正式區流量。
