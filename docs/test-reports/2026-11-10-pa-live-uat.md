# NetOps 即時監控(R1)測試區驗收報告(2026-11-10)

> 範圍:MR !48(收集器開關與驗收修正)的重驗項目 1–5,以及 PA-560 log 轉送開啟後的接收驗收(HTTP 類型)。
> 方式:Claude 內建瀏覽器操作測試區,**登入、登出、換帳號都由需求方本人完成**(Claude 沒有輸入帳密);主機 2 只執行唯讀指令。每一個按開關、刪除都先問過需求方並取得同意。
> 寫入操作(都經同意):按「輪詢:停用 / 開啟」各一次、「接收:停用 / 開啟」各一次;以 viewer 送一次被拒絕的 `PUT collector-control`(403,沒有副作用);刪除知識庫測試筆記 1 則。沒有改主機設定,接收是主討論串先開的。
> 未驗:**TRAFFIC(Syslog)沒有資料**,所有 TRAFFIC 相關項目標「待 Syslog」。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 網址 | `https://giganexus-test.gigasolar.com.tw/netops/firewall/live` |
| 部署版本 | `origin/develop` `300d032`;`netops-api`、`netops-pa`、`netops-kb-backup` 映像 `300d032c`(約 08:54–08:57 重建);`netops-redis` `redis:7.4-alpine` healthy。任務說明寫的映像 `6c0ceaaa` 與實際不同 |
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
| 5 | giga-observe 不再出現新的 `GET /v1/ping` 401 | **未驗**(giga-observe 容器日誌不記請求,無法查) |

### 第二階段(接收,HTTP 類型)

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | 頁首「接收中」、日誌「接收端點已啟用」、無「拒絕不在允許清單」 | **通過** |
| 2 | 排行(5 / 15 / 60 分鐘、各維度、類型切換) | **失敗**:畫面沒有類型與時間切換器,固定顯示 TRAFFIC(空);API 資料正常(見 §3.1) |
| 3 | 即時 log、篩選、暫停、欄位對應 | **部分通過**:URL 欄位與 PA Monitor 一致(威脅未單獨核對);IP、Action 篩選通過;**暫停鈕不存在(失敗)**;Port 篩選與 TRAFFIC 欄位待 Syslog |
| 4 | Redis Stream 增加、記憶體、`MINID` 修剪 | **部分通過**:Stream 增加、記憶體已記錄;TRAFFIC 修剪**待觀察** |
| 5 | 串流補送(`Last-Event-ID`) | **通過**(59 / 59、無重複、無遺漏) |
| 6 | 接收開關 | **通過** |
| 7 | 接收錯誤計數、樣本 | **通過**:`dropped`、`rejected`、`malformed`、`redisFailed` 全為 0,沒有樣本可記 |
| — | 知識庫測試筆記刪除、備份還原結論 | **完成**(見 §5) |

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

## 4. 失敗項目與可能問題

### 4.1 即時排行與即時 log 的控制項沒有渲染(前端缺陷)— 影響:排行切換、log 暫停

- 現象:即時排行卡片右上沒有「類型」下拉與「5 / 15 / 60 分鐘」切換;即時 log 卡片右上沒有「暫停 / 繼續」按鈕。排行固定顯示 TRAFFIC 15 分鐘,所以只要 TRAFFIC 沒資料,畫面就一直是空的(API 其他類型都有資料)。
- 可能原因:`frontend/src/pages/firewall/Live.vue` 第 377、410 行用 `<template #extra>`,但 `frontend/src/ui/components/GCard.vue` 只有 `header` / `actions` / `footer` 插槽(`GCard.vue:19–31`),`extra` 不會渲染;實際 DOM 的 `header` 在 `.spacer` 後只有 `<!---->`。對照:`TopList.vue:43` 有 `<template v-if="$slots.extra" #actions>` 轉接,`Dashboard.vue:277` 直接用 `#actions`。
- 重現:admin 開 `/netops/firewall/live` → 捲到「即時排行」「即時 log」標題右側,沒有控制項;`read_page` 的互動元素清單也沒有暫停按鈕與排行下拉。
- 影響:使用者無法切換排行類型 / 時間、無法暫停即時 log(PLAN §8 的「可暫停」);單元測試(`npm test` 98 通過)沒涵蓋 slot 渲染。
- 建議:`#extra` 改 `#actions`,並補元件測試(或用掛載測試檢查按鈕存在)。

### 4.2 TRAFFIC / Syslog 沒有資料(待處理,非程式缺陷)

- 現象:`netops:pa:log:traffic` 長度 0;心跳沒有 `syslogOkAt`;排行 `traffic` 全空。HTTP 類型(threat、url、data、globalprotect)有資料。主討論串 09:00 前後以 30 秒 pktmon 看主機 2 的 51294 沒有連線。
- 影響:TRAFFIC 排行、欄位對應(PAN-OS 12.1 差異)、Port 篩選、TRAFFIC 1 小時 `MINID` 修剪、`INFO memory` 的真實用量都未驗。

### 4.3 項目 5(giga-observe `/v1/ping` 401)與 giga-observe 429 無法驗

- giga-observe backend 容器日誌不記請求。建議在 GigaItApp 監控畫面看 `netops-api` 最近的 401,或直接查 giga-observe 資料庫(本次驗收只讀容器日誌)。

### 4.4 其他觀察(未判定為缺陷)

1. 暫停輪詢後「介面流量」仍顯示最後一輪的值(§3.1 項目 2);規格寫「暫停時清掉介面計數」,畫面上沒有同步變成「—」。
2. admin 驗項目 4 時只開 2 個分頁就被擋;每人 2 條串流與需求方自己的瀏覽器分頁一併計算,多裝置同時開會互相影響。
3. 自建 `fetch` SSE 在登入約 14 分鐘後重連回 401;一般瀏覽器 `EventSource` 的行為(是否先刷新 token)沒有驗。
4. URL 過濾 log 的「名稱」欄顯示 `9999(9999)`。
5. 任務說明的映像 `6c0ceaaa` 與測試區實際 `300d032c` 不同(測試區在驗收前約 3 分鐘重建)。

## 5. 刪除知識庫測試筆記與備份還原結論(主討論串請求,需求方同意)

- 刪除前 `GET /api/netops/kb/notes` → `total 1`,只有「UAT-備份測試-0000」(id `202611091350-77c63c`)。
- `DELETE /api/netops/kb/notes/202611091350-77c63c`(帶 CSRF)→ **204**;刪除後 `GET /api/netops/kb/notes` → `total 0`。
- 備份還原結論(主討論串已驗,本次未重驗,數字照轉):20261110 備份 `files=2`,`sha256sum -c` OK,解開後與線上 `diff -r` 一致。

## 6. 潛在風險(測試全通過項目之外)

- `received` 約每分鐘 +190–200(HTTP 類型),Redis 約 11.9 MB(40 分鐘 +4 MB);TRAFFIC 開通後的用量要重測。
- 接收來源 `172.26.0.1`(Docker bridge gateway)是 portproxy 轉發後的來源,實際 PA 來源 `10.10.115.35` 由主機防火牆限制,`PA_ALLOWED_SOURCES` 本身無法區分 PA 與其他本機轉發來源。

## 7. 建議交給 Claude 處理

1. §4.1:把 `Live.vue` 兩處 `#extra` 改為 `#actions`,補測試;修完在測試區重驗排行切換與暫停(含 `Port` 篩選、`TRAFFIC`)。
2. §4.2:Syslog 通了之後重驗 TRAFFIC 排行、欄位對照(請需求方看 PA Monitor 的 Traffic 頁)、Port 篩選、`MINID` 1 小時修剪、記憶體。
3. §4.3:查 giga-observe 的 `/v1/ping` 401 與 429 計數,補驗項目 4 / 5。
4. §4.4 第 1、3、4 項:確認是否為預期行為,必要時另開修正。
5. 正式區上架前:重驗「接收未啟用」文案(測試區已無法重現,可用 mock 或暫時關閉接收)。
