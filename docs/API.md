# NetOps API

> `netops-api` 的對外介面:前端(F1)照本文件串接。決策見 [ARCHITECTURE.md](ARCHITECTURE.md),工作項目見 [IMPL-PLAN.md](IMPL-PLAN.md)。
> **狀態:B1 定稿;C3 `feature/clickhouse-c3-query` 加 §4.1、§4.2 的 `source`(ClickHouse),`feature/clickhouse-c3-detail` 加 §4.3 的 `source`,`feature/clickhouse-c3-reconcile` 加 §5.3 對帳與補漏;V-a `feature/viz-a-heatmap-data` 加 §4.4 熱力圖與時段明細;V-b1 `feature/viz-b1-insight-frontend` 加 §4.5 分析儀表板;C5 `feature/c5-pa-precise-query` 加 §3.3 PA 精準查詢;`feature/clickhouse-c3-ch-only`(D43)§4.1–§4.3 只查 ClickHouse、對帳 01:00;B2-pa 已實作 §4.1、§5.1;B2-ad 已實作 §4.2、§5.2、§6;B2-kb 已實作 §7;B2-logs 已實作 §4.3(B2 全部完成);A1(AI 搬移)第 2 批 `feature/a1-ai-api` 實作 §10**。各模組在 B2 分批實作,「批次」欄是預定交付的 MR;實作與本文件不同時,以 MR 描述的「API 變更」為準並同步更新本文件。
> 欄位的完整定義以服務的 `/openapi.json` 為準(上架時匯入 Gateway);本文件寫路徑、權限、請求與回應格式。

---

## 1. 通用規則

依 Gateway `BACKEND-GUIDE.md` §5:

| 項目 | 規則 |
| --- | --- |
| 路徑 | 後端 `/v1/{resource}`,對外 `/api/netops/{resource}`(BFF 去掉 `/v1`)。下文一律寫**對外路徑** |
| 身分 | 前端不帶 Token;BFF 依 Cookie 換成 `X-Internal-Token`。API 權限(`x-permission`)由 BFF 檢查,沒有權限回 403 `PERMISSION_DENIED` |
| 格式 | JSON、UTF-8、camelCase。成功直接回資料本身(不再包 `{ status, data, message }`),提示訊息由前端組 |
| 錯誤 | `{ code, message, requestId, details? }`;`message` 可直接顯示。代碼見 §8 |
| 日期參數 | `from`、`to` 為 `YYYY-MM-DD`(含當天);`to` 省略時等於 `from`。總覽與選項(§4.1、§4.2、§6.1)期間最長 92 天,超過回 400 |
| 時間參數 | ISO 8601 含時區,精確到分鐘,例 `2026-11-03T08:30:00+08:00`;秒忽略(`to` 含該分鐘的 59 秒) |
| 回應時間 | log 內的時間(PA、AD 都是設備當地時間)一律輸出 `+08:00`,例 `2026-11-03T08:30:15+08:00`;系統時間(分析時間、工作建立時間)輸出 UTC `Z` |
| 每小時統計 | `hour` 為該小時開始時間,例 `2026-11-03T08:00:00+08:00` |
| 分頁 | `page`(從 1 開始)、`pageSize`(預設 50、上限 100);回應 `{ items, total, page, pageSize }`。數量有上限的清單(日期、類型、單一 FTP 目錄)不分頁 |
| 長時間工作 | 超過路由逾時的操作改成「送出工作 → 查詢結果」(ARCHITECTURE D6、§7):建立回 **202** 與工作狀態,前端每 1–2 秒查詢一次 |
| 下載 | 回 `Content-Disposition: attachment; filename*=UTF-8''…`;前端以 `fetch` 取得 Blob 下載(帶 CSRF,不帶 Bearer) |
| 資料不完整 | 摘要與查詢回應會帶出檔案數、掃描範圍或匯入狀態;**沒有資料不等於沒有發生**(AGENT.md §5),畫面要顯示這些欄位 |
| 不回傳 | 本機資料目錄的路徑與檔案結構、堆疊、內部錯誤訊息(ARCHITECTURE §4.3 邊界)。FTP 上的路徑是業務資料,照常回傳 |

### 1.1 工作狀態(Job)

明細查詢、時段明細(§4.4,`pa-slice`)、AD 的 FTP 檔案清單使用工作模式。工作**只有建立者本人可查與取消**,別人的工作回 404;只存在記憶體,服務重新啟動後失效(回 404 `NETOPS_JOB_NOT_FOUND`,前端提示重新送出);完成後保留 30 分鐘。進行中的工作上限依**工作類型**分開計算(明細查詢一組、AD 的 FTP 檔案清單一組):每種每人同時最多 2 個、全系統最多 6 個,超過回 409 `NETOPS_JOB_LIMIT_EXCEEDED`(取消後,要等工作真正停止才釋放名額,通常幾秒內)。每人保留的已完成工作:明細查詢 5 筆(§4.3)、AD 檔案清單 10 筆,超過時先丟自己最舊的。

取消一律用 `DELETE …/{id}`,回 **204**;工作已結束、已逾期或不存在也回 204(冪等,BFF 重試時不會報錯)。取消後再查詢,`status` 為 `cancelled`。

```jsonc
{
  "id": "6f1c…",                    // UUID
  "kind": "pa-log-search",
  "status": "running",              // queued | running | done | failed | cancelled
  "createdAt": "2026-11-03T00:30:00.000Z",
  "startedAt": "2026-11-03T00:30:00.010Z",
  "finishedAt": null,
  "progress": { "filesScanned": 3, "files": 12, "rows": 845000, "found": 120 },   // 依工作類型,可能為 null
  "error": null,                    // failed 時 { code, message }
  "result": null                    // done 時才有,格式依工作類型
}
```

### 1.2 匯入狀態(ImportStatus)

PA 匯入在背景佇列執行;同步、分析只是送進佇列,畫面輪詢狀態。

```jsonc
{
  "busy": true,
  "total": 12, "done": 3, "failed": 0, "queued": 8,
  "startedAt": "2026-11-03T00:30:00.000Z", "finishedAt": null,
  "lastSyncAt": "2026-11-03T00:30:00.000Z", "lastSyncError": "",
  "syncing": false,                 // 正在列出 FTP 目錄(同步在背景執行)
  "autoSyncMinutes": 0,
  "running": [ { "path": "/PA-560_traffic_….csv", "name": "PA-560_traffic_….csv", "size": 123456, "read": 4567, "rows": 890, "seconds": 3 } ]
}
```

---

## 2. 權限

以 ARCHITECTURE §5 為準;畫面節點(`netops.*-page`、`*.manage`)在 `deploy/gateway-rbac.yaml`(D1)以 `includes` 綁定這些 API 權限。

| 權限代碼 | 名稱 | 用在 |
| --- | --- | --- |
| `netops.ping.read` | 連線驗證:查詢 | §3(含 §3.1 串流驗證) |
| `netops.pa-realtime.read` | PA 即時監控:查詢 | §3.2(畫面節點 `netops.pa-live.read`) |
| `netops.pa-realtime.write` | PA 即時監控:測試區暫停 / 繼續收集器 | §3.2 `collector-control`(按鈕 `netops.pa-live.manage`,只給 `netops-admin`;2026-11-09 需求方決定) |
| `netops.pa-query.read` | PA 精準查詢:查詢 | §3.3(**只給 `netops-admin`**,CQ7;按鈕 `netops.pa-live.query`) |
| `netops.pa.read` | PA 防火牆:查詢 | §4.1、§4.2、§4.4 熱力圖、§4.5 儀表板 |
| `netops.pa-log.read` | PA Log 明細:查詢 | §4.3、§4.4 時段明細 |
| `netops.ftp.read` | FTP Log 檔案:查詢 | §5 讀取 |
| `netops.ftp.write` | FTP Log 檔案:同步與管理 | §5 寫入 |
| `netops.ad.read` | AD 事件:查詢 | §6.1 |
| `netops.ad-log.read` | AD Log 明細:查詢 | §6.2 |
| `netops.kb.read` | 知識庫:查詢 | §7 讀取、§10.2 讀取(語意搜尋、向量庫與外部 IP 學習狀態) |
| `netops.kb.write` | 知識庫:編輯 | §7 寫入、§10.2 立即同步 / 學習 |
| `netops.ai.use` | AI 分析與問答:使用 | §10.1(分析、問答、狀態)。不是 `.read`:選單不能綁定,由按鈕 `netops.pa-ask.use`、`netops.ad-ask.use`、`netops.pa-dashboard.ai` 綁定(`gateway-rbac.yaml`);給 `netops-admin`、`netops-viewer`(2026-11-05 決定) |

稽核:Log 明細查詢與匯出、時段明細(§4.4)、知識庫下載、即時 log(§3.2 `logs`、`stream`)、AI 分析與問答(§10.1)設 `x-audit-level: meta`;測試區收集器開關(§3.2 `collector-control`)設 `body`(記錄要求的狀態)。

取消工作(`DELETE …/{id}`)用該工作的**讀取**權限:只能取消自己送出的工作,不改變業務資料,因此不另設寫入權限(ARCHITECTURE §5)。

---

## 3. 連線驗證(B0,已上線)

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/netops/ping` | `netops.ping.read` | 回 `{ service, emp, name, dept, roles, requestId, time }` |

### 3.1 串流驗證(S0)— 批次 `feature/s0-sse`

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/netops/pa-live/stream-test` | `netops.ping.read` | Server-Sent Events;確認 SSE 經 Nginx 與 BFF 不被緩衝、不因閒置逾時中斷(IMPL-PLAN S0、PA-LIVE-PLAN §7) |

- 回應標頭:`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`(Nginx 依此關閉這個回應的緩衝)。
- 事件:連線後立即送 `retry: 5000` 與 `open`,之後每 15 秒送 `heartbeat`。`id` 為序號;`data` 為 `{ seq, time, connectionId, elapsedSec }`,`open` 另帶 `heartbeatSec`、`maxSec`、`resumedFrom`。
- 重連:瀏覽器 `EventSource` 斷線 5 秒後自動重連並帶 `Last-Event-ID`;序號接續,`open.resumedFrom` 為該 id(不是正整數時為 `null`、從 0 開始)。
- 上限:單一連線最長 10 分鐘,到時伺服器結束連線(瀏覽器自動重連,BFF 重新檢查登入與權限,所以登出或撤權最晚 10 分鐘後生效);每人(工號)同時 2 條、全系統 20 條,超過回 **429** `NETOPS_STREAM_BUSY`。用戶端讀不動、待送資料超過 64 KB 時中斷;服務關閉時結束全部串流。
- **逾時(不受 AGENT.md §7.3 一般 API 10 秒限制的原因)**:BFF 對上游的 `bodyTimeout` 等於路由逾時,而 undici 的 `bodyTimeout` 是「兩個資料塊之間」的閒置時間,不是總時長;本路由設 `x-timeout-ms: 60000`,心跳 15 秒,所以連線可以一直開著。BFF 斷路器計入「收到標頭之前」的逾時與連線錯誤,以及上游回 5xx;串流已回 200 之後的中斷不累積,所以名額滿時回 **429**(回 5xx 會讓有權限的人藉此打開斷路器、整個 `netops-api` 停 30 秒)。**SSE 路由一定要設 `x-timeout-ms` 大於心跳間隔**(預設 10 秒會在第一次心跳前被切斷),心跳不可超過 60 秒。
- 權限用 `netops.ping.read`:同 §3 是連線驗證用,不綁畫面節點、不在 `gateway-rbac.yaml` 的角色內,在 GigaItApp 個別指派(B0 時指派給 `it-admin`,現況以 GigaItApp 為準);S0 驗證完成後可把這條路由在 GigaItApp 停用;不新增權限代碼,`gateway-rbac.yaml` 不變。R1 正式串流用 `netops.pa-realtime.read`(PA-LIVE-PLAN §8)。
- 驗證腳本 `backend/scripts/sse-probe.mjs`,步驟見 `docs/test-reports/2026-11-05-s0-sse.md`。

### 3.3 PA 精準查詢(C5)— 批次 `feature/c5-pa-precise-query`

設計見 [PA-LOG-CLICKHOUSE-GUIDE.md](PA-LOG-CLICKHOUSE-GUIDE.md) §9;決策 D31、CQ6、CQ7;門檻依 IMPL-PLAN C0 **E4 結果**(2026-11-10:15 分鐘、500 筆、逾時 60 秒、全系統一次一個、管理平面 CPU > 50% 不送;較大範圍實測前不放寬)。`netops-api` 只驗證與送出,PA-560 由 `netops-pa` 的查詢執行者查(`PA_QUERY_ENABLED`,**測試區預設關閉**,需求方手動開)。

| 方法 | 路徑 | 權限 | 稽核 | 說明 |
| --- | --- | --- | --- | --- |
| GET | `/api/netops/pa-query/status` | `netops.pa-query.read` | — | 按鈕能不能按:`{ enabled, executor, heartbeatAgeSec, activeSec, globalCoolSec, userCoolSec, mgmtCpu }` |
| POST | `/api/netops/pa-query/jobs` | `netops.pa-query.read` | `meta` | 送出(202 + 工作) |
| GET | `/api/netops/pa-query/jobs/{id}` | `netops.pa-query.read` | `meta` | 工作狀態與結果(本人;10 分鐘內) |

**權限**:`netops.pa-query.read` **只給 `netops-admin`**(CQ7;按鈕 `netops.pa-live.query`);`netops-viewer` 沒有,BFF 回 403。查詢本身唯讀(D22),但會在 PA-560 管理平面執行,所以和寫入一樣只給管理員。

**送出內容**(`additionalProperties: false`):

| 欄位 | 說明 |
| --- | --- |
| `kind` | `log`:XML API `type=log`;`session`:Session Browser(`show session all filter source / destination <IP>`) |
| `ip` | **必填,單一 IPv4 / IPv6**(不接受 CIDR、萬用字元);查詢語法只由驗證過的值組成,不接受自訂 filter |
| `logType` | `log`:`traffic`(預設)/ `threat` |
| `from`、`to` | `log`:ISO 8601 含時區;`to − from` ≤ **15 分鐘**、`to` 在最近 **1 小時**內(更早的用 §4.3 Log 明細查詢) |
| `nlogs` | `log`:1–**500**(預設 500) |
| `direction` | `session`:`src`(該 IP 為來源,預設)/ `dst` |

**限流**(被擋一律 **429** `NETOPS_PA_QUERY_BUSY`,`Retry-After` 與 `details.retryAfter`,不回 5xx):

| 規則 | 值 |
| --- | --- |
| 全系統同時 | 1 個(Redis `netops:paq:active`,TTL 90 秒;`netops-pa` 結束時釋放) |
| 全域間隔 | 10 秒(每個工作結束後) |
| 每人冷卻 | 60 秒(送出時起算;被擋的請求不算) |
| 管理平面 CPU | 最新快照(輪詢寫入)> 50% 先擋;`netops-pa` 送出前**再取樣一次**,> 50% 或讀不到就不送,工作標 `rejected` |
| 工作逾時 | 60 秒;到時 `netops-pa` 送 `action=finish` 取消 PA 上的工作,工作標 `failed`(`NETOPS_PA_QUERY_TIMEOUT`) |

`netops-pa` 沒開查詢執行者、或心跳超過 60 秒:409 `NETOPS_PA_QUERY_DISABLED`。Redis 連不上:424 `NETOPS_REDIS_UNAVAILABLE`。

```jsonc
// POST 202、GET 200
{
  "id": "…uuid…", "kind": "log", "status": "done",      // queued | running | done | failed | rejected
  "params": { "logType": "traffic", "ip": "10.10.130.124", "from": "2026-11-12T01:45:00.000Z", "to": "2026-11-12T02:00:00.000Z", "nlogs": 500 },
  "createdAt": "…", "startedAt": "…", "finishedAt": "…",
  "mgmtCpu": 4.5,                                       // 送出前取樣到的管理平面 CPU(%)
  "error": null,                                        // failed / rejected:{ code, message }(NETOPS_PA_QUERY_TIMEOUT、_FAILED、_EXPIRED、_INVALID、_CPU_HIGH、_CPU_UNKNOWN)
  "result": {                                           // done 才有
    "rows": [ { "time": "2026/11/12 09:58:01", "action": "allow", "src": "10.10.130.124", "sport": 51000, "dst": "8.8.8.8", "dport": 443,
                "app": "ssl", "rule": "Allow-Web", "fromZone": "trust", "toZone": "untrust", "bytes": 1200, "sent": 200, "recv": 1000 } ],
    // log:欄位同 §4.3(time 為 PA 設備時間 yyyy/MM/dd HH:mm:ss);session:id、app、state、type、src、sport、dst、dport、proto、
    //      fromZone、toZone、startTime、bytes、rule、natSrc、natDst、natSport、natDport、srcUser
    "count": 1, "truncated": false                      // truncated:達 500 筆上限
  }
}
```

- API Key 只在 `netops-pa`,放 `X-PAN-KEY` 標頭(不進網址、POST 內容與錯誤訊息,日誌遮罩)。不跟隨轉址;PA 的錯誤原文只寫日誌,`error.message` 只有分類與 PA code。PA 端該 Key 的 Admin Role 應只開 XML API Log 與 Operational Requests(網通設定;程式另以白名單只送唯讀請求)。
- 測試區與正式區查同一台 PA-560,名額與冷卻各在自己的 Redis(兩區同時查可能各 1 個;正式區上線前再評估)。

### 3.2 PA 即時監控(R1)— 批次 `feature/r1-api`

資料來源是 `netops-redis`(`netops-pa` 收集器寫入,PA-LIVE-PLAN §3–§4),本服務只讀;唯一的寫入是測試區手動開關 `netops:pa:control`(`collector-control`)。保留:TRAFFIC 明細 1 小時、統計 1 天;其他類型 2 天(D21);更早的資料用 §4.3 Log 明細查詢(FTP)。查詢權限一律 `netops.pa-realtime.read`;開關用 `netops.pa-realtime.write`。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/netops/pa-live/snapshot` | 收集器狀態 `collector` 與設備快照 `metrics`(`session`、`cpu`、`throughput`、`interfaces`) |
| GET | `/api/netops/pa-live/series?metric=&minutes=` | 指標趨勢(`minutes` 1–120,預設 60;由舊到新,最多約 360 點) |
| GET | `/api/netops/pa-live/top?type=&minutes=&limit=&dims=` | 最近 5 / 15 / 60 分鐘的排行與統計 |
| GET | `/api/netops/pa-live/logs?type=&limit=&before=&ip=&port=&action=` | 最新 log(由新到舊;`x-audit-level: meta`) |
| GET | `/api/netops/pa-live/stream?types=&ip=&port=&action=` | SSE 串流(`x-audit-level: meta`、`x-timeout-ms: 60000`) |
| PUT | `/api/netops/pa-live/collector-control` | 測試區暫停 / 繼續收集器(`netops.pa-realtime.write`、`x-audit-level: body`;正式區 403) |

**收集器狀態** `collector`:`state` 與中文 `message`、`updatedAt`(心跳時間)、`poll`(`enabled`、`paused`、`lastOkAt`、`error`、`errorAt`)、`receive`(`enabled`、`paused`、`tls`、`httpLastAt`、`syslogLastAt`)、`redis`(`error`)、`counters`(`received`、`dropped`、`rejected`、`malformed`、`redisFailed`、`paused`,收集器啟動後累計)。`enabled` 是主機設定的總開關(`PA_POLL_ENABLED`、`PA_RECEIVE_ENABLED`);`paused` 是測試區手動開關的**實際**狀態(收集器回報;總開關關閉時一律 `false`);`counters.paused` 是接收暫停期間丟棄的筆數。

| `state` | 條件 | 畫面 |
| --- | --- | --- |
| `ok` | 心跳 30 秒內更新 | 正常顯示 |
| `degraded` | 輪詢有錯誤(連不到 PA-560、Key 失效、某指令失敗)或 Redis 寫入錯誤 | 顯示錯誤;快照過期的指標顯示「停止更新」 |
| `disabled` | `PA_POLL_ENABLED`、`PA_RECEIVE_ENABLED` 都關閉 | 「收集器未啟用」 |
| `paused` | 總開關有開的部分都被測試區手動開關暫停 | 「收集器已暫停」;快照 60 秒後過期為「停止更新」 |
| `stopped` | 心跳超過 30 秒沒更新 | 「資料停止更新」,`metrics` 全為 `null`(**不顯示舊快照**,AGENT §5) |
| `not-running` | Redis 沒有心跳 | 「收集器沒有啟動過」 |
| `unavailable` | Redis 連不上或未設定 | 「無法連線即時資料庫」,`metrics` 全為 `null` |

- `snapshot` 在 Redis 連不上時仍回 **200**(`state: unavailable`):頁面每 10 秒更新,回 5xx 會累積 BFF 斷路器失敗、讓整個 `netops-api` 被短路。其他查詢回 **424** `NETOPS_REDIS_UNAVAILABLE`(同樣不用 5xx;R1 審查時確認 BFF `upstream.ts` 把上游 5xx 計為斷路器失敗)。Redis 回指令錯誤(程式或資料問題)回 500 `INTERNAL_ERROR`。Redis 不可用與恢復時 `netops-api` 各記一筆 warn。
- 收集器心跳裡的錯誤(`poll.error`、`redis.error`)回給畫面前**只留分類**(例 `session:API Key 無效或權限不足`、`連不到主機`、`連線逾時`、`憑證驗證失敗`、`設備不支援此查詢`),不含主機、IP 與網址;原文看 `netops-pa` 容器日誌。
- **測試區手動開關**(2026-11-09 需求方決定「在測試區我想要有按鈕可以停用或開啟」):`snapshot` 另回 `control`(`available`:這個部署區能不能切換,正式區 `false`;`pollPaused`、`receivePaused`:**要求的**狀態;`updatedAt`、`updatedBy`:最後操作時間與「姓名(工號)」)。`PUT /collector-control` 內容 `{ "pollPaused"?: boolean, "receivePaused"?: boolean }`(至少一個,未知欄位忽略),只寫要求的狀態並回 `control`;收集器每次輪詢前讀(輪詢)、每 5 秒讀一次(接收),實際狀態看 `collector.poll.paused` / `receive.paused`。輪詢暫停時不查 PA-560、清掉介面計數(繼續後第一輪介面流量為 `null`);接收暫停時端點仍開著,收到的 log **丟棄並計數** `counters.paused`(HTTP 仍回 200,避免 PA-560 重送),不寫 Redis。總開關關閉時寫入照樣成功但不會生效(畫面停用該按鈕並說明原因)。套用最長延遲:輪詢為一個輪詢間隔(預設 15 秒),接收為 5 秒。正式區 `PUT` 回 **403** `NETOPS_PA_CONTROL_DISABLED`,`netops-pa` 也不讀這個鍵。Redis 連不上回 424。
- 查詢成本:`top` 60 分鐘的 TRAFFIC 全部維度約 540 個 Redis 指令(各維度同時送出);畫面每 30 秒查一次。
- 每個快照 60 秒沒更新就過期為 `null`;快照帶 `time`(收集器取得的時間)。`session`:`active`、`max`、`utilization`(%)、`tcp`、`udp`、`icmp`;`throughput`:`bps`、`pps`、`cps`;`cpu`:`mgmt`(管理平面 %)、`dataplane`(資料平面各核心平均 %)、`memUsed`、`memTotal`(bytes);`interfaces.items[]`:`name`、`rxBps`、`txBps`(第一次輪詢或計數歸零時為 `null`)。
- `top`:`totals`(`count`;TRAFFIC 另有 `bytes`、`packets`)、`kpis`(例 `action: { allow: 13, deny: 2 }`;每分鐘每項最多 50 種值,其餘併為 `(其他)`)、`tops[dim]: [{ key, value }]`(每分鐘只保留前 200 名,合併後為近似值;`*Bytes` 維度的 value 是位元組)、`perMinute: [{ minute, count }]`、`retentionSec`。次數已乘 Repeat Count(TRAFFIC 除外)。維度:TRAFFIC `src`、`dst`、`app`、`rule`、`port`、`srcBytes`、`dstBytes`、`appBytes`;其他類型見 `backend/src/infra/redis/index.ts` `TOP_DIMS`。
- `logs`(剛好湊滿 `limit` 時 `nextBefore` 不是 `null`,下一頁可能是空的):`items[]` 為 log 欄位(key 同舊版 `palog.js` / `paevents.js`,PA-LIVE-PLAN §4)加 `id`、`type`、`receivedAt`(收集器收到的時間);`nextBefore`(下一頁游標,沒有更早資料為 `null`)、`scanned`、`truncated`(篩選時一次最多掃描 5000 筆,沒湊滿 `limit` 時為 `true`:結果不完整)、`earliest`(Redis 內最早一筆的時間)、`retentionSec`。`ip` 比對 `src`、`dst`、`natSrc`、`natDst`、`ip`、`publicIp`、`privateIp`;`port` 比對 `dport` 或 `sport`(威脅類 log 自 2026-11-10 起也帶 `sport`、`natDport`,PA 的 HTTP Payload 有加變數才有值,沒有就沒有這兩個欄位;`natDport` 不參與 `port` 篩選);`action` 完全相同。
- `stream`(SSE,寫法同 §3.1):立即送 `retry: 5000` 與 `open`(`types`、`filter`、`heartbeatSec`、`maxSec`、`resumed`),接著 `snapshot`(同 `GET /snapshot`,之後每 10 秒);每 1 秒檢查一次新 log(2026-11-10 由 2 秒縮短)並送 `logs`(`items` 由舊到新;每個 tick 最多送 1500 筆,超過的筆數在 `dropped`,正常為 0;一個 `logs` 事件最多 200 筆,較多時分成數個事件,**只有最後一個事件帶 `id`**,中途斷線會從上一個 tick 重送、瀏覽器依 `id` 去重;某類型一個 tick 讀到 1500 筆以上跟不上時,跳到最新並列在 `skipped`。舊上限:2 秒 / 200 筆 / 500 筆,TRAFFIC 約 107–117 筆/秒時實測約 24% 被捨棄);每 15 秒 `heartbeat`。`types` 預設 `traffic,threat`。只有 `logs` 事件帶 `id`(游標 `traffic:<StreamID>,threat:<StreamID>`),斷線重連時以 `Last-Event-ID` 接續;沒有游標時只送連線之後的新 log;游標比現在早超過 **5 分鐘**的類型不接續(從最新開始,列在 `open.gap`),重連只補斷線期間,不能用來撈舊明細(舊明細用 `GET /logs`,有稽核)。某類型讀取失敗時該類型的游標不推進(恢復後補上),送 `degraded`(`types`、`message`;恢復時 `types` 為空)。單一連線最長 **5 分鐘**(需求方 2026-11-05 決定;撤權後最晚 5 分鐘停止),每人 **3** 條(2026-11-10 需求方決定由 2 提高到 3:同一人多個分頁或多台裝置)、全系統 20 條,超過回 **429** `NETOPS_STREAM_BUSY`。Redis 暫時失敗時串流不中斷,`snapshot` 帶 `state: unavailable`。
- 前端重連(2026-11-10 驗收 §4.4-3):伺服器 5 分鐘結束連線後,瀏覽器 `EventSource` 自動重連;重連時若 Access Token 已過期,BFF 回 401,`EventSource` 不經 web-kit,不會自己 Refresh。前端探測到 401 時先呼叫 web-kit 的 `refreshSession()`,成功立即重連,失敗導向入口網登入;換發後仍 401(連線成功前只換發一次)才照一般錯誤退避。

---

## 4. 防火牆 PA-560

### 4.1 流量總覽(TRAFFIC)— 批次 `feature/netops-b2-pa`

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/pa/days` | `netops.pa.read` | `GET /palog/days` |
| GET | `/api/netops/pa/overview?from&to&top&source` | `netops.pa.read` | `GET /palog/summary` |
| GET | `/api/netops/pa/options?from&to&source` | `netops.pa.read` | `GET /palog/options` |

**資料來源(C3,ARCHITECTURE D29、D42、D43)**:**只查 ClickHouse**(2026-11-11 需求方決定捨棄 FTP 查詢路徑、不再並行 2 週)。`source` 參數保留只為相容,只接受 `clickhouse`(或省略);`ftp`、`auto` 已移除,帶了回 400。回應的 `source` 固定 `clickhouse`。
- ClickHouse 無法使用或未設定回 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`(不再改用 FTP)。
- **保留期限**:回應 `coverage` = ClickHouse 實際有 TRAFFIC 的日期範圍 `{ from, to }`(正式區保留 30 天);期間有一部分在 `coverage.from` 之前時 `partial: true`;期間**整個**在之前回 404 `NETOPS_PA_OUT_OF_RETENTION`(訊息含有資料的範圍),不回 0。
- `rows`、`allow`、`block`、`bytes`、`hours`、`actions` 來自每小時彙總表(含進行中的小時);`top`、`topBytes`、`scan`、`sent`、`recv`、`subtypes`、`timeMin`、`timeMax` 來自 ClickHouse 每小時摘要(和舊版 FTP 摘要同一份核心邏輯),**只算到 `topsUntil`**(最後一個已結束、已建好摘要的小時的結束時間;背景每 5 分鐘建,小時結束 3 分鐘後才建)。`topsState`:`ok`、`not-ready`(服務剛啟動,摘要建立中)、`stale`(太久沒更新,ClickHouse 可能停止),不是 `ok` 時排行不完整。`files` 為有資料的小時數,`missing` 為已結束、有資料但摘要還沒建好(或筆數變了待重建)的小時數;`import` 為摘要建立狀態(`busy` 建立中、`failed` 1 = 上一輪失敗)。
- 同樣的參數 60 秒內重複查詢走 Redis 快取(CQ11),所以結果最多晚 60 秒;`topsState` 不是 `ok` 的結果不快取。有資料的日期另在程序內記 2 分鐘。
- `partial`:TRAFFIC 以 ClickHouse 最早一小時判斷(最早那天可能只從中午才有資料),威脅類以天判斷。`/pa/options` 超過保留期限同樣回 404。
- 和舊版 FTP 摘要的差異:FTP 每個檔案只留前 300 名再合併,ClickHouse 每小時只留前 300 名再合併(排行尾端的數字可能不同)。

**`GET /pa/days`**:ClickHouse 有 TRAFFIC 的日期(新的在前);`files` 沿用舊欄位名稱,意思改為**有資料的小時數**;另有 `coverage`(有資料的範圍,沒有資料為 null)。畫面用它顯示可查的範圍(取代舊的「已分析 … 天」)。

```jsonc
{ "days": [ { "day": "2026-11-02", "files": 6, "rows": 1830000 } ], "import": { /* ImportStatus,不含 running */ } }
```

**`GET /pa/overview`**:合併期間內各檔案的摘要。`top` 為排行筆數(1–100,預設 20)。

```jsonc
{
  "from": "2026-11-01", "to": "2026-11-02",
  "files": 12,                                   // 期間內已分析的檔案數;0 表示沒有資料(不是沒有流量)
  "missing": 0,                                  // 已分析但摘要讀不到的檔案數;大於 0 表示總覽不完整
  "import": { "busy": false, "failed": 0 },      // 有檔案還在分析或分析失敗時,總覽可能不完整
  "rows": 3600000, "allow": 3500000, "block": 100000,
  "bytes": 123456789, "sent": 23456789, "recv": 100000000,
  "timeMin": "2026-11-01T00:00:01+08:00", "timeMax": "2026-11-02T23:59:58+08:00",
  "hours": [ { "hour": "2026-11-01T00:00:00+08:00", "n": 150000, "allow": 146000, "block": 4000, "bytes": 5000000 } ],
  "actions": { "allow": 3500000, "deny": 90000, "drop": 10000 },
  "subtypes": { "end": 3500000, "deny": 100000 },
  "top": { "src": [ { "key": "10.10.1.5", "n": 120000, "bytes": 3456789 } ] /* 其他排行見下 */ },
  "topBytes": { "src": [ { "key": "10.10.1.5", "n": 120000, "bytes": 3456789 } ] },
  "scan": [ { "src": "1.2.3.4", "n": 5000, "dsts": 300, "ports": 2, "zone": "untrust → trust" } ],
  "source": "clickhouse",                        // C3:實際來源 ftp | clickhouse
  "topsUntil": "2026-11-12T09:00:00+08:00"       // C3:只有 clickhouse 來源;排行只算到這個時間(不含)
}
```

排行名稱(`top` 的 key,與舊版相同):`src`、`dst`、`dport`、`app`、`rule`、`zone`、`srcCountry`、`dstCountry`、`user`、`category`、`blockSrc`、`blockDst`、`blockDport`、`blockRule`、`inboundBlockSrc`、`inboundAllow`、`riskApp`、`endReason`、`srcHost`、`upSrc`、`upDst`、`upRiskSrc`、`upRiskPair`、`upRiskApp`、`aiSrc`、`aiPair`、`aiApp`。`topBytes` 只有依位元組排序有意義的排行。

**`GET /pa/options`**:明細查詢的下拉選項(期間內出現過的值)。

```jsonc
{ "apps": ["ssl", "web-browsing"], "rules": ["Allow-Web"], "zones": ["trust", "untrust"], "actions": ["allow", "deny"] }
```

### 4.2 安全事件(其他類型 log)— 批次 `feature/netops-b2-ad`

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/pa-events/types` | `netops.pa.read` | `GET /pa-events` |
| GET | `/api/netops/pa-events/overview?type&from&to&top` | `netops.pa.read` | `GET /pa-events/summary` |

`type`:`threat`、`url`、`data`、`wildfire`、`decryption`、`globalprotect`、`userid`(只列出有設定 FTP 目錄的類型)。

**資料來源(C3,D43)**:`threat`、`url`、`data`、`wildfire` **只查 ClickHouse**(全部來自 ClickHouse 每小時摘要,只到 `topsUntil`;`files` 為有摘要的小時數;`coverage`、`partial`、`topsState` 與 404 `NETOPS_PA_OUT_OF_RETENTION`、503 規則同 §4.1;正式區威脅類保留 90 天);`decryption`、`globalprotect`、`userid` 不進 ClickHouse(AGENT.md §7.2),仍是 FTP 已分析的摘要(`source: "ftp"`)。`types` 回應每個類型多 `source` 與 `coverage`(`dir` 照舊),ClickHouse 類型的 `days` 為 ClickHouse 有資料的日期、**`files` 意思改為有資料的小時數**;ClickHouse 無法使用時這幾個類型 `unavailable: true`,解密等 FTP 類型照常列出。

```jsonc
// GET /pa-events/types
{ "types": [ { "type": "threat", "label": "威脅", "dir": "/threat", "files": 30, "rows": 52000, "days": ["2026-11-02", "2026-11-01"] } ] }

// GET /pa-events/overview?type=threat&from=2026-11-01&to=2026-11-02
{
  "type": "threat", "label": "威脅", "from": "2026-11-01", "to": "2026-11-02",
  "files": 4, "missing": 0, "import": { "busy": false, "failed": 0 },
  "rows": 5200,
  "timeMin": "2026-11-01T00:03:11+08:00", "timeMax": "2026-11-02T23:50:02+08:00",
  "hours": [ { "hour": "2026-11-01T00:00:00+08:00", "n": 210 } ],
  "kpis": [ { "key": "action", "title": "動作", "items": [ { "key": "alert", "n": 4000 } ] } ],
  "tops": [ { "key": "name", "title": "威脅名稱", "items": [ { "key": "…", "n": 300 } ] } ]
}
```

`kpis`、`tops` 的項目依類型不同(與舊版 `server/lib/paevents.js` 定義相同)。

### 4.3 Log 明細查詢與匯出(工作模式,D6)— 批次 `feature/netops-b2-logs`

舊版 `POST /palog/search` 同步等待最長 180 秒,超過路由上限,改成工作模式。**C3 起只查 ClickHouse 的 TRAFFIC 原始 log**(D43,捨棄 FTP 掃描),依時間由舊到新取前 `limit` 筆。

**ClickHouse 明細(C3,D43)**:期間最長 30 天;只用關鍵字 `q`、沒有其他條件時最長 1 天(超過回 400,`details` 指出 `q`);執行上限 50 秒,全系統同時 2 個、每人 1 個。`source` 只接受 `clickhouse`(或省略)。期間整個超過保留期限回 404 `NETOPS_PA_OUT_OF_RETENTION`;期間內沒有 log 回 404 `NETOPS_PA_NO_DATA`;ClickHouse 連不上回 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`;執行中失敗或超過 50 秒時工作 `failed`,`error.code` 為 `NETOPS_CLICKHOUSE_UNAVAILABLE`。
- 條件語意同舊版(IP 完全相同 / CIDR / 萬用字元並比對 NAT、Port、動作…);`q` 比對主要文字欄位(IP、Port、類型、協定、規則、使用者、App、區域、動作、URL 類別、國家、結束原因、主機名稱)串起來的字串,不是整列原始 CSV(數字欄位如位元組、Session ID 不在比對範圍)。IP 以位址值比較:IPv6 的 CIDR 用真正的範圍,`::1` 與 `0:0:0:1` 視為相同。
- 結果 `result.source` 固定 `clickhouse`;`files`、`filesScanned` 為 0(舊欄位),`scanned` 為 ClickHouse 讀過的列數,`stopReason` 為 `''` 或 `limit`,`coverage`、`partial` 同 §4.1(`partial` 時匯出檔名結尾加「_部分期間超過保留期限」);`progress` 只有 `{ found: 0 }`。

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| POST | `/api/netops/pa/log-searches` | `netops.pa-log.read` | 送出查詢,回 202 + 工作狀態 |
| GET | `/api/netops/pa/log-searches/{id}` | `netops.pa-log.read` | 工作狀態;完成時 `result` 為查詢摘要(不含資料列) |
| GET | `/api/netops/pa/log-searches/{id}/rows?page&pageSize` | `netops.pa-log.read` | 查詢結果分頁(工作完成後) |
| GET | `/api/netops/pa/log-searches/{id}/export` | `netops.pa-log.read` | 下載查詢結果 CSV(UTF-8 BOM,欄名中文) |
| DELETE | `/api/netops/pa/log-searches/{id}` | `netops.pa-log.read` | 取消(冪等),回 204;已完成的工作則丟棄結果、釋放記憶體 |

```jsonc
// POST /pa/log-searches(from / to 必填;其他條件選填,與舊版相同)
{
  "from": "2026-11-02T08:00:00+08:00", "to": "2026-11-02T09:00:00+08:00",
  "src": "10.10.1.5", "dst": "10.10.0.0/16", "ip": "10.10.124.*", "port": "443,8443", "proto": "tcp",
  "app": "ssl", "rule": "Allow", "action": "block", "fromZone": "trust", "toZone": "untrust",
  "user": "S112009", "country": "TW", "q": "keyword", "limit": 2000
}
```

- IP 條件:完全相同、萬用字元(`10.10.*`)、CIDR(`10.10.0.0/16`);同時比對 NAT 位址。只能用 IP / CIDR 字元,`*` 最多 4 個(連續的視為一個),否則 400。
- 同時只執行 1 個明細查詢,其他排隊(`status: queued`);每人保留最近 5 筆已完成的結果。
- `action`:`allow`、`block`(非 allow)、或 PA 的動作原文。
- `limit` 預設與上限都是設定 `PA_SEARCH_LIMIT`(預設 2,000,可設 1–10,000;結果保留在記憶體 30 分鐘,調高前先估記憶體)。
- 期間最長 31 天(超過回 400);`port` 只能是數字、逗號與空白。
- 期間內沒有已分析的檔案時,建立工作直接回 404 `NETOPS_PA_NO_DATA`(請先到 FTP Log 檔案同步)。
- 工作執行上限為掃描秒數 + 60 秒;`progress` 為 `{ filesScanned, files, rows, found }`,每掃完一個檔案更新。
- 查詢與匯入共用 FTP 連線名額(測試區 1 條):匯入進行中時,查詢會排隊等候(工作狀態維持 `running`、`progress.filesScanned` 不動)。

```jsonc
// 完成時的 result
{
  "source": "ftp",          // C3:實際來源 ftp | clickhouse
  "from": "2026-11-02T08:00:00+08:00", "to": "2026-11-02T09:00:00+08:00",
  "total": 120, "limit": 2000,
  "files": 2, "filesScanned": 2, "scanned": 845000, "seconds": 12.3,
  "stopReason": ""          // "" 全部掃完 | "limit" 達筆數上限 | "timeout" 超過掃描秒數或等不到 FTP 連線(結果不完整,匯出檔名加「_不完整」)
                            // FTP 讀取失敗時工作為 failed,原因在 error
}

// GET /pa/log-searches/{id}/rows:依時間排序;欄位順序同舊版 ROW_FIELDS
{ "items": [ { "time": "2026-11-02T08:00:03+08:00", "subtype": "end", "action": "allow", "src": "10.10.1.5", "sport": 51234,
               "dst": "8.8.8.8", "dport": 443, "proto": "tcp", "app": "ssl", "rule": "Allow-Web", "fromZone": "trust", "toZone": "untrust",
               "srcUser": "", "natSrc": "", "natDst": "", "bytes": 1234, "sent": 600, "recv": 634, "packets": 10, "elapsed": 3,
               "endReason": "tcp-fin", "category": "any", "srcCountry": "10.0.0.0-10.255.255.255", "dstCountry": "United States",
               "appRisk": 4, "threat": "", "severity": "", "url": "" } ],
  "total": 120, "page": 1, "pageSize": 50 }
```

### 4.4 活動熱力圖與時段明細(V-a)— 批次 `feature/viz-a-heatmap-data`

設計見 [VIZ-RULES-DESIGN.md](VIZ-RULES-DESIGN.md) §3、§4.2、§4.3(決策 D34、D35;V1、V3、X4、X8、X9)。熱力圖只讀 ClickHouse 彙總表 `pa_heat_5m` / `_1h` / `_1d`(物化檢視從原始表算;正式區每 5 分鐘保留 1 年、每小時與每天 5 年,測試區 3 天);時段明細讀原始表,一次最多 1 天。

| 方法 | 路徑 | 權限 | 稽核 | 說明 |
| --- | --- | --- | --- | --- |
| GET | `/api/netops/pa/heatmap?granularity&metric&date` | `netops.pa.read` | — | 熱力圖格子 |
| GET | `/api/netops/pa/slice?start&end&type…` | `netops.pa-log.read` | `meta` | 時段明細;30 秒內回 200,否則 202 工作(`x-timeout-ms: 40000`) |
| GET | `/api/netops/pa/slices/{id}` | `netops.pa-log.read` | `meta` | 時段明細工作狀態(完成時含 `result`) |
| DELETE | `/api/netops/pa/slices/{id}` | `netops.pa-log.read` | — | 取消 / 丟棄結果(冪等,204) |

**熱力圖**:

| 參數 | 值 | 說明 |
| --- | --- | --- |
| `granularity` | `year` \| `month` \| `day` | 必填。`year`:以 `date` 所在週(週一開始)為最後一欄往前共 53 週,一格一天;`month`:`date` 所在月,一格一小時;`day`:`date` 當天,一格 5 分鐘 |
| `metric` | `traffic` \| `deny` \| `threat` \| `ad` | 必填。`traffic` = 位元組;`deny` = 非 allow 筆數;`threat` = `10×critical + 5×high + 2×medium + 1×low`(只算 `log_type = threat` 的筆數,不乘 Repeat Count);`ad` 是 AD 階段(V-d)預留,回 409 `NETOPS_HEATMAP_METRIC_UNAVAILABLE` |
| `date` | `YYYY-MM-DD` | 預設今天;晚於今天回 400。`day` 超過 1 年(5 分鐘彙總保留)回 422 `NETOPS_HEATMAP_OUT_OF_RETENTION`,`details.earliest` 為最早可查日 |

```jsonc
{
  "granularity": "month", "metric": "traffic", "date": "2026-11-11",
  "from": "2026-11-01T00:00:00+08:00", "to": "2026-12-01T00:00:00+08:00", "bucketSeconds": 3600,
  "coverage": {
    "since": "2026-11-10T15:00:00+08:00",   // 彙總表最早的格子;更早的格子 v = null(沒有資料,不是 0)。表內沒有資料時 null
    "gaps": [ { "from": "2026-11-10T13:00:00+08:00", "to": "2026-11-10T14:00:00+08:00", "reason": "recon-gap" } ],  // recon-gap:§5.3 每日對帳的缺口小時;no-data:彙總表沒有的連續格子
    "gapsKnown": true                       // false:沒有對帳(ClickHouse 未設定),缺口未檢查
  },
  "levels": { "method": "quantile", "thresholds": [120000000, 480000000, 1500000000] },  // level 2–4 的下限;threat 為 { "method": "severity", "thresholds": [] }
  "cells": [                                // 開始時間在現在之後的格子不回
    { "t": "2026-11-11T08:00:00+08:00", "v": 2345678901, "level": 4, "partial": false,
      "tip": { "bytes": 2345678901, "sessions": 412345, "deny": 3120,
               "threats": { "critical": 0, "high": 2, "medium": 5, "low": 11, "info": 40 },
               "topIp": { "traffic": "10.10.112.20", "deny": "10.10.113.7", "threat": "10.10.112.31" } } }  // topIp 為近似值(topK),畫面標「約」;沒有時 null
  ],
  "generatedAt": "2026-11-11T02:12:00.000Z"
}
```

- `level`:`traffic`、`deny` 依本視圖非 0 格的 25 / 50 / 75 百分位分 1–4(0 = 0 或 null);`threat` 依最高嚴重度:critical 4、high 3、medium 2、low / info 1。只有 info 的格子 `v = 0`(權重 0)但 `level = 1`,畫面以 `level` 上色、以 `tip.threats` 說明。
- `coverage.since` 是整張彙總表最早的格子:上線當天(或 TTL 刪到一半的那天)的每天格只含部分時段,數字照實回、不標 `partial`(`partial` 只標已知的對帳缺口)。
- `v = null`:`coverage.since` 之前,或彙總表沒有該格(例:彙總上線前的時段、彙總中斷;彙總表是稀疏表,整格收不到任何 TRAFFIC 也沒有列,同樣視為沒有收到資料,不當成 0)。`since` 之後的這種格子會合併成 `reason: "no-data"` 的缺口列進 `coverage.gaps`(結束未滿 10 分鐘的格子可能還有遲到的寫入,不列);畫面顯示「沒有資料」,不畫成 0(2026-11-13 驗收 C1)。
- `partial`:格子和 `coverage.gaps` 重疊(含 `no-data`)。
- 快取(Redis `netops:cache:pa-heat:*`):含現在或結束未滿 1 小時的期間 60 秒,更早結束的期間 1 小時;三個指標共用同一份。FTP 補漏或 `rebuild-day.sh` 重建之後,最多 1 小時才看到新的數字。
- ClickHouse 未設定、連不上或查詢失敗回 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`(同 §4.1)。

**時段明細**(點熱力圖格子、圖表聯動):

| 參數 | 說明 |
| --- | --- |
| `start`、`end` | ISO 8601 含時區,對齊到分鐘(秒忽略);`end` 必須晚於 `start`,最長 1 天,超過 400 |
| `type` | `traffic`(預設)\| `threat`(只查 `log_type = threat`) |
| 篩選(選填) | `ip`(比對來源 / 目的,含 NAT)、`src`、`dst`:**只接受單一 IP 或 CIDR**(不接受萬用字元);`app`、`country`(包含,不分大小寫)、`fromZone`、`toZone`(完全相同)、`dport`(0–65535)、`action`(`allow` \| `block`);`type=threat` 另有 `severity`(`critical`…`info`)、`threatName`(包含)。語意同 §4.3 ClickHouse 來源 |
| `rows` | 明細列數 0–200(預設 100);全部明細請用 §4.3 Log 明細查詢 |
| `sort` | `time`(預設,新到舊)\| `bytes`(只對 `traffic`) |

**熱 / 冷分界**:`hotFrom` = 今天 00:00 −(原始表保留天數 − 1)天(TRAFFIC 30 → 29 天、威脅 90 → 89 天;測試區 3 → 2 天;設定 `NETOPS_TTL_TRAFFIC_DAYS` / `NETOPS_TTL_THREAT_DAYS`,預設依部署區,要和 `apply-schema.sh` 一致)。`start ≥ hotFrom` 查原始表(`source: "hot"`);早於 `hotFrom` 的部分讀 **NAS 冷歸檔**(C4,每天一個 Parquet,帳號 `netops_cold` 以 `file()` 讀),`source` 為 `cold` / `mixed`(跨分界時兩段合併:總數相加、排行重排、明細列依排序合併),欄位格式和熱資料相同。冷歸檔關閉(`NETOPS_ARCHIVE_ENABLED=0`,例如正式區 NAS 空間還沒核准)回 409 `NETOPS_COLD_ARCHIVE_DISABLED`,`details.hotFrom` 為可查的起點。期間涵蓋的任何一天沒有歸檔成功回 404 `NETOPS_COLD_ARCHIVE_NOT_FOUND`,`details.missing` 為 `[{ type: "traffic" | "threat", day: "YYYY-MM-DD", status }]`,`status`:`missing`(尚未歸檔,例:前一天 02:30 之前)、`failed`(歸檔失敗,每小時重試中)、`expired`(超過歸檔保留期限:測試區 14 天;正式區至少 1 年)、`unreadable`(紀錄成功但檔案讀不到:NAS 未掛載或檔案遺失);TRAFFIC 明細另外要同一天的威脅歸檔(摘要列的威脅數)。不回傳檔案路徑。冷查詢全系統同時 1 個(Redis 鎖 `netops:cold:lock`,和每天 02:30 起的歸檔匯出共用),拿不到回 429 `NETOPS_COLD_QUERY_BUSY` 與 `Retry-After: 10`(`details.retryAfter` 同值,前端 web-kit 讀不到回應標頭時用)。冷查詢從 NAS 讀整天的檔,通常超過 30 秒轉成工作(202)。

**同步 30 秒,超過轉工作**:一律建 `pa-slice` 工作;30 秒內完成回 **200** 結果,否則回 **202** 工作狀態(§1.1),前端改輪詢 `GET /pa/slices/{id}`(完成時 `result` 為結果)。同一人、同一組參數在工作保留期間(30 分鐘)重送回同一個工作(進行中 202、完成 200),不重複查詢。工作每人同時 2 個、全系統 6 個(和 §4.3 分開計),同時執行 2 個(其餘排隊;一個工作內的 ClickHouse 查詢依序執行),每人保留 5 筆,執行上限 120 秒(ClickHouse 每個查詢 50 秒;冷工作 110 秒,全系統 1 個)。取消熱查詢工作時,已送出的 ClickHouse 查詢不會中止(結果是多人共用的快取),最多再跑 50 秒;30 秒內失敗直接回該錯誤(例 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`)。熱查詢結果另有 60 秒共用快取(`netops:cache:pa-slice:*`)。

```jsonc
{
  "source": "hot",                        // hot | cold | mixed
  "type": "traffic", "start": "2026-11-11T08:00:00+08:00", "end": "2026-11-11T09:00:00+08:00",
  "filters": { "ip": "10.10.112.20" },    // 有帶的篩選條件
  "summary": { "sessions": 41234, "bytes": 2345678901, "sent": 1234567, "recv": 2344444334, "deny": 312,   // type=threat 時 sessions 為威脅筆數、bytes / sent / recv 為 0(不適用;前端 useSlice.summary 轉成 null 顯示「不適用」)
               "threats": { "critical": 0, "high": 2, "medium": 5, "low": 11, "info": 40 } },             // 同時段 log_type=threat 的筆數(type=traffic 時只套用 IP 條件)
  "top": {                                // 各 Top 10;traffic:依位元組 { key, sessions, bytes };threat:依筆數 { key, count }(name 另有 severity)
    "src": [ { "key": "10.10.112.20", "sessions": 1200, "bytes": 1300000000 } ], "dst": [], "app": [], "dport": [], "dstCountry": []
    // type=threat:{ "name": [ { "key": "…", "severity": "high", "count": 9 } ], "src": [], "dst": [], "srcCountry": [] }
  },
  "rows": [ /* traffic:欄位同 §4.3 ClickHouse 來源(time 為 +08:00);threat:time、subtype、src、dst、natSrc、natDst、rule、srcUser、app、fromZone、toZone、dport、proto、action、url、name、category、severity、direction、srcCountry、dstCountry、repeat、thrCategory、filedigest、filetype */ ],
  "rowsLimit": 100, "rowsTruncated": true,
  "coverage": { "partial": false, "gaps": [], "gapsKnown": true },
  "seconds": 0.8
}
```

### 4.5 分析儀表板(V-b1)— 批次 `feature/viz-b1-insight-frontend`

設計見 [VIZ-RULES-DESIGN.md](VIZ-RULES-DESIGN.md) §4.4。一個視角一支 API,一次回該視角全部圖表的資料(畫面一個請求,快取一份 `netops:cache:pa-insight:*`:含今天或結束未滿 1 小時 60 秒,其他 10 分鐘)。權限 `netops.pa.read`。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/netops/pa/insight/traffic?from&to` | 流量視角 |
| GET | `/api/netops/pa/insight/threat?from&to` | 安全威脅視角 |

`from`、`to`:`YYYY-MM-DD`(含當天),最長 **90 天**(來源 IP 彙總與威脅原始表保留 90 天)、最早 5 年內;不存在的日期(例 `2026-02-31`)、`to` 晚於今天或早於 `from` 回 400。實際計算(沒命中快取)全系統同時 2 個,超過回 **429** `NETOPS_INSIGHT_BUSY`(`Retry-After` 與 `details.retryAfter` 為 5 秒;畫面倒數後重試)。時間序列的數值 `null` 表示沒有資料(彙總表最早的格子之前),和 0 不同;`coverage` 同 §4.4。ClickHouse 無法使用回 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`。

```jsonc
// traffic
{
  "view": "traffic", "from": "2026-11-05", "to": "2026-11-11",
  "bucketSeconds": 3600,                 // trend:≤ 2 天 300、≤ 31 天 3600、其他 86400
  "allowDenyBucketSeconds": 86400,       // allowDeny:≤ 2 天 3600、其他 86400
  "coverage": { "since": "…", "gaps": [], "gapsKnown": true },
  "trend": [ { "t": "2026-11-05T00:00:00+08:00", "sent": 1200, "recv": 5400, "sessions": 310 } ],   // pa_heat_*
  "sankey": {                            // 來源區域 → App → 目的區域(位元組);App 取前 15,其他併「其他」
    "nodes": [ { "id": "z:LAN", "name": "LAN", "layer": 0 }, { "id": "a:ssl", "name": "ssl", "layer": 1 }, { "id": "d:WAN", "name": "WAN", "layer": 2 } ],
    "links": [ { "source": "z:LAN", "target": "a:ssl", "bytes": 3000 } ]
  },
  "topIp": [ { "ip": "10.10.112.20", "bytes": 3000, "sent": 1000, "recv": 2000, "sessions": 100 } ],  // pa_traffic_hourly_src;migration 003 之前的列上傳 / 下載為 0
  "topApp": [ { "app": "ssl", "bytes": 3000, "sessions": 100 } ],
  "allowDeny": [ { "t": "…", "allow": 90, "deny": 10 } ],
  "generatedAt": "…"
}
// threat(只算 log_type = threat 的筆數,不乘 Repeat Count)
{
  "view": "threat", "from": "…", "to": "…", "bucketSeconds": 3600, "coverage": { … },
  "score": { "critical": 1, "high": 2, "medium": 5, "low": 11, "info": 40,
             "prev": { "critical": 0, "high": 4, "medium": 3, "low": 9, "info": 30 },   // 前一個同長度期間;資料起點晚於前一期開始時為 null(畫面不顯示增減)
             "prevFrom": "2026-10-29", "prevTo": "2026-11-04" },
  "timeline": [ { "t": "…", "critical": 0, "high": 1, "medium": 0, "low": 2 } ],
  "countries": [ { "country": "China", "iso2": "CN", "count": 30, "critical": 1, "high": 5 } ],  // 全部國家(給地圖);內網範圍不列,對不到的併成 { "country": "未知", "iso2": null }
  "topInternalSrc": [ { "ip": "10.10.112.31", "count": 12, "high": 3 } ],   // RFC 1918 來源(V-c 網段設定後改用設定)
  "topServerDst": null,                  // 伺服器網段在偵測設定(V-c)之前沒有,見 notes
  "topNames": [ { "name": "…(12345)", "severity": "high", "count": 9 } ],   // 同名有多種嚴重度時取最高的
  "notes": [ "內網以 RFC 1918 判斷;伺服器網段尚未設定(偵測設定 V-c),「被攻擊最多的伺服器」暫不提供" ],
  "generatedAt": "…"
}
```

- 國家:PA 的國家欄位是英文全名,後端轉 ISO 3166-1 alpha-2(`backend/src/modules/pa-insight/countries.ts`);前端地圖以 ISO2 對應(`frontend/src/ui/charts/world/`)。
- 和流量總覽一致:`trend` 的 `sessions` 加總 = 流量總覽同期間的 `rows`(兩者都來自 ClickHouse 寫入的 TRAFFIC;彙總表上線前的日子要先用 `rebuild-day.sh` 回填)。

---

## 5. FTP Log 檔案 — 批次 `feature/netops-b2-pa`(PA)、`feature/netops-b2-ad`(AD)

FTP 唯讀(AGENT.md §7.4):「刪除分析結果」只刪本系統的摘要,不動 FTP。

### 5.1 PA(TRAFFIC 與其他類型共用)

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/ftp/pa/files?path` | `netops.ftp.read` | `GET /ftp/browse` |
| GET | `/api/netops/ftp/pa/status` | `netops.ftp.read` | `GET /ftp/status` |
| POST | `/api/netops/ftp/pa/syncs` | `netops.ftp.write` | `POST /ftp/sync` |
| POST | `/api/netops/ftp/pa/analyses` | `netops.ftp.write` | `POST /ftp/analyze` |
| DELETE | `/api/netops/ftp/pa/analyses` | `netops.ftp.write` | `POST /ftp/cancel` |
| POST | `/api/netops/ftp/pa/result-deletions` | `netops.ftp.write` | `POST /ftp/forget` |

**`GET /ftp/pa/files?path=/threat`**:列出 FTP 目錄與每個檔案的分析狀態;`path` 省略時為 TRAFFIC 目錄,不可超出 FTP 根目錄(403 `NETOPS_FTP_PATH_FORBIDDEN`)。Windows 系統資料夾 `$RECYCLE.BIN`、`System Volume Information`(不分大小寫)不列出,AD 的清單同樣不列(2026-11-05)。

`isLog` 只看檔名;**能不能分析看目錄**:只有 `path === logDir`(TRAFFIC 目錄直屬)或 `type` 不是空字串(各類型目錄)時,檔案送 `POST /ftp/pa/analyses` 才會加入佇列。畫面在其他目錄(例如 `FTP_LOG_DIR` 之外的 `/my-data`)不顯示勾選框,只能瀏覽(2026-11-05)。

```jsonc
{
  "path": "/threat", "type": "threat",                // type:"" 表示 TRAFFIC 或一般目錄
  "root": "/", "logDir": "/", "pattern": "\\.(csv|log|txt|gz)$",
  "eventDirs": [ { "type": "threat", "label": "威脅", "dir": "/threat" } ],
  "items": [ {
    "name": "PA-560_threat_2026_11_02_last_calendar_day_0.csv", "path": "/threat/PA-560_threat_….csv",
    "dir": false, "size": 123456, "modified": "2026-11-03T00:05:00.000Z",
    "isLog": true,
    "state": "done",                                 // new | changed | done | error | queued | running
    "rows": 5200, "day": "2026-11-02",
    "timeMin": "2026-11-02T00:00:03+08:00", "timeMax": "2026-11-02T23:59:58+08:00",
    "analyzedAt": "2026-11-03T00:06:00.000Z", "ms": 3456, "error": ""
  } ]
}
```

**`GET /ftp/pa/status`**:`{ traffic: ImportStatus, events: ImportStatus }`(§1.2)。

**`POST /ftp/pa/syncs`**(無 body):在背景列出 TRAFFIC 與各類型目錄,把新的、已變更、上次失敗的檔案加入分析佇列;回 **202** `{ traffic: ImportStatus, events: ImportStatus }`。結果看 `GET /ftp/pa/status` 的 `lastSyncAt`、`lastSyncError` 與佇列。

**`POST /ftp/pa/analyses`**:分析選取的檔案(重新分析也用這個)。只接受 TRAFFIC 目錄(符合檔名規則)與各類型目錄下的 log 檔;大小與修改時間以 FTP 上的實際值為準(舊版由畫面傳入,`size`、`modified` 仍接受但不使用)。不在 FTP 上、不是 log 或不在這些目錄的檔案算在 `skipped`。佇列上限 5,000 個檔案,超過回 409 `NETOPS_IMPORT_QUEUE_FULL`。

```jsonc
// 請求(1–500 筆)
{ "items": [ { "path": "/PA-560_traffic_….csv" } ] }
// 回應
{ "added": 1, "skipped": 0 }
```

**`DELETE /ftp/pa/analyses`**:取消佇列並中斷分析中的檔案;回 `{ "cancelled": 3 }`(重複呼叫回 0)。

**`POST /ftp/pa/result-deletions`**:`{ "paths": ["/PA-560_traffic_….csv"] }`(1–500 筆)→ `{ "deleted": 1 }`。之後同步會重新分析。

### 5.3 FTP 與 ClickHouse 對帳、補漏(C3)— 批次 `feature/clickhouse-c3-reconcile`

ARCHITECTURE D33、D43、手冊 `PA-LOG-CLICKHOUSE-GUIDE.md` §11:FTP 只做對帳與補漏(查詢只用 ClickHouse,2026-11-11 起不再並行 2 週)。

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/netops/pa/reconciliations?from&to` | `netops.ftp.read` | 已存的每日對帳結果(新的在前,期間最長 92 天) |
| POST | `/api/netops/pa/reconciliations` | `netops.ftp.write` | 立即對帳一天 `{ day: "YYYY-MM-DD" }`,回結果 |
| POST | `/api/netops/pa/backfills` | `netops.ftp.write` | 補漏 `{ day, hours? }`:先重新對帳,把缺口小時交給 `netops-ingest`,回 202 + 工作 |
| GET | `/api/netops/pa/backfills/{id}` | `netops.ftp.read` | 補漏工作狀態(保留 7 天) |

- **對帳**:每小時比 FTP 摘要的筆數(已分析的 FTP 檔的每小時統計,不另外讀 FTP)與 ClickHouse 每小時彙總的筆數。差異 = (FTP − ClickHouse) / FTP;> 0.5% 為 `gap`、< −0.5% 為 `excess`(可能重複)、FTP 沒有該小時為 `ftp-missing`、其他 `ok`。ClickHouse 開始收資料之前的小時、以及開始的那一小時(通常只收到一部分)不比。FTP 的筆數是各匯出檔摘要的加總;若 PA 匯出檔時間範圍互相重疊會把 FTP 算多(補漏時依 seqno 去重,補不出列、缺口仍在),此時請人工確認。
- 一天的 `status`:`ok`、`gap`(有缺口)、`pending`(FTP 這一天的匯出檔還沒同步分析完:隔天也要有已分析的檔案、沒有讀不到的摘要、沒有在分析中;不判斷缺口)、`not-covered`(ClickHouse 這天沒有資料)。
- 每天台灣時間 `NETOPS_RECON_TIME`(`HH:MM`,預設 **08:10**,需求方 2026-11-13 決定;`-1` = 不自動;舊的 `NETOPS_RECON_HOUR` 整點設定仍可用,`NETOPS_RECON_TIME` 優先)起自動對帳前 3 天並存檔;有缺口時服務日誌記 warn。**對帳要的 FTP 分析由對帳流程自己確保**:FTP 檔還沒分析完時先同步(只排 TRAFFIC 檔,30 分鐘最多一次),之後每 10 分鐘再試,直到不是 `pending`。PA 前一天的匯出檔實際約 **07:45** 才出現在 FTP,所以預設 08:10 開始;若 08:10 時檔還沒出現,先為 `pending` 再每 10 分鐘重試。
- **自動補漏**(需求方 2026-11-13 決定;`NETOPS_RECON_AUTO_BACKFILL=0` 關閉):自動對帳發現 `gap` 時,同手動 `POST /pa/backfills` 的流程送出補漏工作,`createdBy` 為 `system:recon`,工作 id 記在該天對帳結果的 `backfills`。缺口小時還找不到已分析的 FTP 檔、上一個補漏還在排隊或執行中、佇列已滿或 netops-redis 失敗時,照 `pending` 的規則每 10 分鐘再試;自動補漏全系統同時只有 1 個在排隊或執行(不佔滿佇列、不擋人工補漏)。補漏完成 20 分鐘後(等每小時彙總追上)重新判斷,沒缺口就結束,仍有缺口再送,同一天每天最多自動送 3 次(之後記 warn,改人工)。FTP 只保留 `NETOPS_FTP_RETENTION_DAYS`(預設 10,最多 30)天:4 天前到保留期限前一天、上次對帳仍有缺口或 `pending` 的日子每天自動再對帳、再補;到了保留期限仍有缺口或 `pending` 時記 warn(FTP 檔已刪或即將被刪,無法再補)。部署注意:Compose 一律給 `NETOPS_RECON_TIME`,原本在 `.env` 用 `NETOPS_RECON_HOUR=-1` 關閉自動對帳的,要改成 `NETOPS_RECON_TIME=-1`。
- **補漏**:`netops-ingest` 一次做一個工作,逐小時查 ClickHouse 已有的 seqno,從 FTP 逐列讀涵蓋該小時的 TRAFFIC CSV,**只補寫 seqno 不在 ClickHouse 的列**(`source = 'ftp'`;不刪除、不覆蓋既有資料;沒有 seqno 的列無法去重,略過並計數)。每小時彙總由物化檢視自動補上,總覽的每小時摘要偵測到筆數變了會重建。佇列最多 10 個工作。
- `hours`(選填):只補其中幾個缺口小時(ISO 8601 含時區);不是缺口的小時忽略。

```jsonc
// GET /pa/reconciliations?from=2026-11-12
{ "threshold": 0.005,
  "days": [ { "day": "2026-11-12", "checkedAt": "2026-11-13T06:00:02.120Z", "status": "gap", "ftpFiles": 158, "gaps": 1, "excess": 0,
              "hours": [ { "hour": "2026-11-12T01:00:00+08:00", "ftp": 351200, "ch": 348000, "diff": 0.009112, "status": "gap" } ],
              "backfills": ["…"] } ] }

// POST /pa/backfills → 202;GET /pa/backfills/{id}
{ "id": "…", "day": "2026-11-12", "hours": [ { "hour": "2026-11-12T01:00:00+08:00", "files": 7 } ], "state": "done",
  "createdBy": "S112009", "createdAt": "…", "startedAt": "…", "finishedAt": "…",
  "read": 351200, "skipped": 348000, "inserted": 3200, "noSeqno": 0, "error": null }
```

錯誤:ClickHouse 無法使用或未設定 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`;FTP 還沒分析完、或缺口小時找不到已分析的 FTP 檔 409 `NETOPS_RECON_PENDING`;沒有缺口 409 `NETOPS_BACKFILL_NOTHING`;佇列已滿 409 `NETOPS_BACKFILL_BUSY`;工作不存在 404 `NETOPS_BACKFILL_NOT_FOUND`;Redis 讀寫失敗 424 `NETOPS_REDIS_UNAVAILABLE`。工作 `state` 為 `failed` 時 `error` 只有分類過的訊息:例如 FTP 檔沒有 Sequence Number 欄位(無法去重)、工作內容不合法(`netops-ingest` 執行前再驗:小時對齊且屬於該日期、31 天內、檔案在 `FTP_LOG_DIR` 之下且符合 `FTP_PATTERN`)、一個檔超過 70,000 列待補、`netops-ingest` 停止或重新啟動時中斷(重新送出即可,只補缺的列)。

### 5.2 AD

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| POST | `/api/netops/ftp/ad/listings` | `netops.ftp.read` | `GET /ad/browse`(改工作模式) |
| GET | `/api/netops/ftp/ad/listings/{id}` | `netops.ftp.read` | 同上 |
| DELETE | `/api/netops/ftp/ad/listings/{id}` | `netops.ftp.read` | 取消(冪等,204) |
| GET | `/api/netops/ftp/ad/status` | `netops.ftp.read` | `GET /ad/days` 的 `job` |
| POST | `/api/netops/ftp/ad/syncs` | `netops.ftp.write` | `POST /ad/sync` |
| POST | `/api/netops/ftp/ad/imports` | `netops.ftp.write` | `POST /ad/import` |
| POST | `/api/netops/ftp/ad/result-deletions` | `netops.ftp.write` | `POST /ad/forget` |

**`POST /ftp/ad/listings`**:舊版要逐一列出每個日期資料夾(最長 120 秒),改成工作模式;回 202 + 工作狀態(§1.1)。畫面載入時**不送出**,有管理權限(`netops.ad-files.manage`)的人按「列出 FTP 資料夾」才送出;沒有管理權限的人看不到按鈕,只看得到 `GET /ftp/ad/status`(需求方 2026-11-05 決定)。API 權限仍是 `netops.ftp.read`:按鈕隱藏只是體驗,有 read 權限的人仍可直接呼叫(要在後端限制需另行決定)。完成時 `result`:

```jsonc
{
  "dir": "/AD_Log_Backup",
  "days": [ {
    "day": "2026-11-02", "path": "/AD_Log_Backup/20261102",
    "state": "done",                                // new | changed | done | orphan(已匯入但 FTP 上已沒有資料夾)
    "events": 5300, "importedAt": "2026-11-03T00:10:00.000Z",
    "files": [ { "name": "Security_GSMC-DC1.csv", "size": 1234567, "modified": "2026-11-03T00:01:00.000Z", "channel": "Security", "rows": 5000, "error": "" } ]
  } ]
}
```

**`GET /ftp/ad/status`**:

```jsonc
{ "running": false, "dir": "/AD_Log_Backup", "autoSyncMinutes": 0,
  "lastSyncAt": "2026-11-03T00:10:00.000Z", "lastSyncError": "",
  "lastResult": { "days": 30, "imported": [ { "day": "2026-11-02", "events": 5300 } ] } }
```

`dir`、`autoSyncMinutes` 與 `lastResult.imported[].day`(`YYYY-MM-DD`)同上。

**`POST /ftp/ad/syncs`**(無 body):背景比對每個日期資料夾,有變更才重新匯入;回 **202** + `GET /ftp/ad/status` 的內容。正在同步時回 409 `NETOPS_AD_SYNC_BUSY`;沒有設定 FTP 時回 503 `NETOPS_FTP_NOT_CONFIGURED`。

多人同時送出清單工作時共用同一次 FTP 列表,不會多佔 FTP 連線;工作執行上限 3 分鐘;每人保留最近 10 筆已完成的清單。

**`POST /ftp/ad/imports`**:`{ "days": ["2026-11-02"] }`(1–60 天)不比對、一律重新匯入;回 **202**,同上。

**`POST /ftp/ad/result-deletions`**:`{ "days": ["2026-11-02"] }` → `{ "deleted": 1 }`。

---

## 6. AD 網域 — 批次 `feature/netops-b2-ad`

### 6.1 AD 事件總覽

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/ad/days` | `netops.ad.read` | `GET /ad/days` |
| GET | `/api/netops/ad/overview?from&to` | `netops.ad.read` | `GET /ad/summary` |

```jsonc
// GET /ad/days
{
  "days": [ { "day": "2026-11-02", "events": 5300, "importedAt": "2026-11-03T00:10:00.000Z", "files": [ { "name": "Security_GSMC-DC1.csv", "channel": "Security", "rows": 5000 } ] } ],
  "import": { "running": false, "lastSyncAt": "2026-11-03T00:10:00.000Z", "lastSyncError": "" },   // 失敗時只回「同步失敗,詳見 FTP Log 檔案頁」,細節在 GET /ftp/ad/status(ftp.read)
  "channels": { "Security": "安全性", "System": "系統", "Directory_Service": "目錄服務", "DNS_Server": "DNS 伺服器" },
  "securityEvents": { "4625": "登入失敗" }
}

// GET /ad/overview?from=2026-11-01&to=2026-11-02(與舊版 summarizeAd 相同,時間改 ISO)
{
  "from": "2026-11-01", "to": "2026-11-02",
  "days": 2,                                       // 期間內已匯入的天數;少於期間天數表示有日期沒有資料
  "total": 10600, "byChannel": { "Security": 10000 }, "byLevel": { "info": 9000, "audit_failure": 1000 },   // 等級:info、warning、error、critical、audit_success、audit_failure
  "timeMin": "2026-11-01T00:00:01+08:00", "timeMax": "2026-11-02T23:59:59+08:00",
  "hours": [ { "hour": "2026-11-01T00:00:00+08:00", "n": 400, "issue": 3 } ],
  "events": [ { "channel": "Security", "eventId": 4625, "level": "audit_failure", "provider": "…", "n": 30,
                "first": "2026-11-01T08:00:00+08:00", "last": "2026-11-02T09:00:00+08:00", "sample": "…", "computers": ["GSMC-DC1"], "name": "登入失敗" } ],
  "issues": [ /* 同 events */ ],
  "failAccounts": [ { "key": "S112009", "n": 3 } ], "failIps": [ { "key": "10.10.1.5", "n": 3 } ],
  "failReasons": [ { "key": "使用者名稱或密碼錯誤", "n": 3, "ips": [ { "key": "10.10.1.5", "n": 3 } ], "accounts": [ { "key": "S112009", "n": 3 } ] } ],
  "accountChanges": [ { "time": "2026-11-02T10:00:00+08:00", "eventId": 4728, "action": "…", "actor": "…", "target": "…", "group": "…", "privileged": true, "computer": "GSMC-DC1", "recordId": "123" } ],
  "privilegedChanges": 1, "accountsCreated": 0,
  "privLogons": [ { "key": "admin", "n": 10 } ]
}
```

### 6.2 AD Log 明細查詢與匯出

資料已在本機,查詢不掃 FTP,維持同步回應。

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/ad/events?from&to&channel&level&eventId&q&account&ip&issueOnly&page&pageSize` | `netops.ad-log.read` | `GET /ad/events` |
| GET | `/api/netops/ad/events/export?(同上條件,不含分頁)` | `netops.ad-log.read` | 舊版前端自行產生 CSV |

- `from`、`to`:時間參數(§1);`eventId` 可用逗號分隔多個;`issueOnly=true` 只看需要注意的事件。
- 期間最長 31 天(超過回 400 `VALIDATION_FAILED`)。
- 匯出上限 20,000 筆,超過回 422 `NETOPS_EXPORT_TOO_LARGE`(請縮小條件)。欄位同舊版畫面匯出(時間、記錄、事件 ID、等級、來源、主機、帳號、執行者、對象、群組、來源 IP、工作站、原因、訊息);以 `=`、`+`、`-`、`@` 開頭的文字前面加 `'`,避免 Excel 當成公式。

```jsonc
// GET /ad/events(新的在前)
{
  "items": [ { "time": "2026-11-02T08:00:00+08:00", "eventId": 4625, "level": "audit_failure", "levelText": "稽核失敗",
               "provider": "Microsoft-Windows-Security-Auditing", "computer": "GSMC-DC1", "recordId": "123", "channel": "Security",
               "message": "…", "account": "S112009", "domain": "GSMC", "ip": "10.10.1.5", "workstation": "PC01", "reason": "使用者名稱或密碼錯誤",
               "actor": "", "target": "", "group": "", "privileged": false } ],
  "total": 30, "page": 1, "pageSize": 50,
  "scanned": 10600                               // 期間內的事件總數(篩選前)
}
```

---

## 7. 知識庫 — 批次 `feature/netops-b2-kb`

AI 相關(語意搜尋、向量同步、外部 IP 自動學習)見 §10.2(A1)。內容輸出前端時一律經 DOMPurify(AGENT.md §7.4)。

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/kb/notes?q&page&pageSize` | `netops.kb.read` | `GET /kb?q`(不含 `semantic`) |
| GET | `/api/netops/kb/notes/{id}` | `netops.kb.read` | `GET /kb/:id` |
| GET | `/api/netops/kb/notes/{id}/markdown` | `netops.kb.read` | `GET /kb/:id/md` |
| GET | `/api/netops/kb/compilation` | `netops.kb.read` | `GET /kb/all/md` |
| POST | `/api/netops/kb/notes` | `netops.kb.write` | `POST /kb` |
| PUT | `/api/netops/kb/notes/{id}` | `netops.kb.write` | `PUT /kb/:id` |
| DELETE | `/api/netops/kb/notes/{id}` | `netops.kb.write` | `DELETE /kb/:id` |

- `q`:關鍵字以空白分隔,全部符合(標題、內容、IP、標籤、記錄人)。依更新時間新的在前。
- 清單每筆含完整 `content`(與舊版相同,畫面直接顯示選取的筆記);單則最長 20,000 字,`pageSize` 預設 50。
- 舊版回應的 `admin` 拿掉:能否編輯由前端依權限 `netops.kb.write`(畫面節點 `netops.kb-page.write`)判斷。
- 記錄人改用 Gateway 身分的「工號 姓名」(AGENT.md §7.1)。
- `id` 格式 `^[\w-]{6,64}$`,不符合回 400。

```jsonc
// GET /kb/notes
{
  "items": [ { "id": "202611021030-a1b2c3", "title": "10.10.130.66 FTP 伺服器", "ips": ["10.10.130.66"], "tags": ["FTP"],
               "author": "S112009 佳緯", "created": "2026-11-02T10:30:00+08:00", "updated": "2026-11-02T10:30:00+08:00",
               "updatedBy": "S112009 佳緯", "source": "", "content": "# Markdown…" } ],
  "total": 1, "page": 1, "pageSize": 50,
  "compilation": { "count": 120, "updated": "2026-11-02T10:30:00+08:00", "chars": 18000 }    // 匯整檔資訊
}

// POST /kb/notes、PUT /kb/notes/{id} 請求(content 必填,上限 20,000 字;ips 最多 30 個、tags 最多 10 個;
// ips、tags 可以是陣列或逗號 / 頓號分隔的文字,同舊版;ips 只保留 IP / 網段格式;title、ips、tags 不可含換行(400);
// 總數上限 5,000 則(409 NETOPS_KB_LIMIT);PUT 省略 source 時保留原值)
{ "title": "…", "ips": ["10.10.130.0/24"], "tags": ["FTP"], "content": "…", "source": "" }
// 回應:筆記本身(POST 回 201)
```

- `DELETE /kb/notes/{id}`:回 204;已不存在也回 204(冪等)。
- `GET /kb/notes/{id}/markdown`、`GET /kb/compilation`:`text/markdown; charset=utf-8` 下載;檔名分別為筆記標題、`網通知識庫匯整.md`。

---

## 8. 錯誤代碼

| HTTP | 代碼 | 說明 |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 參數驗證失敗(附 `details`) |
| 401 | `NETOPS_INTERNAL_TOKEN_INVALID` | 沒有或無效的內部 Token(只會在直連服務時發生) |
| 403 | `NETOPS_FTP_PATH_FORBIDDEN` | FTP 路徑超出可瀏覽的根目錄 |
| 403 | `NETOPS_JOB_OWNER_UNKNOWN` | 身分沒有工號也沒有 sub,不能建立工作(正常經 Gateway 不會發生) |
| 404 | `NETOPS_NOT_FOUND` | 找不到此 API |
| 404 | `NETOPS_JOB_NOT_FOUND` | 工作不存在、不是本人的、已逾期或服務重新啟動後失效 |
| 404 | `NETOPS_PA_NO_DATA` | 期間內沒有已分析的 PA log 檔 |
| 404 | `NETOPS_KB_NOTE_NOT_FOUND` | 找不到筆記 |
| 403 | `NETOPS_KB_AUTHOR_UNKNOWN` | 身分沒有工號與姓名,不能編輯筆記(正常經 Gateway 不會發生) |
| 409 | `NETOPS_JOB_LIMIT_EXCEEDED` | 進行中的工作超過上限(每人或全系統) |
| 409 | `NETOPS_JOB_NOT_DONE` | 工作尚未完成(或失敗、已取消),沒有結果可分頁或匯出 |
| 409 | `NETOPS_AD_SYNC_BUSY` | AD 正在同步 |
| 409 | `NETOPS_IMPORT_QUEUE_FULL` | 分析佇列已滿 |
| 409 | `NETOPS_KB_LIMIT` | 知識庫筆記已達上限 |
| 409 | `NETOPS_AI_DISABLED` | 沒有設定 AI 服務(`LLM_URL`);設定狀態不是故障,不用 5xx(§10) |
| 409 | `NETOPS_VECTOR_SYNC_DISABLED` | 沒有啟用向量庫同步(`VECTOR_SYNC=0`,只做語意搜尋;§10.2) |
| 409 | `NETOPS_VECTOR_SYNC_BUSY` | 向量庫正在同步 |
| 409 | `NETOPS_IPLEARN_BUSY` | 外部 IP 自動學習正在執行 |
| 429 | `NETOPS_STREAM_BUSY` | 串流連線數已達上限:串流驗證(§3.1,每人 2 條、全系統 20 條)與即時監控(§3.2,每人 3 條、全系統 20 條)、AI 回答(§10.1,每人 2 個、全系統 6 個);不用 5xx,避免累積 BFF 斷路器失敗 |
| 422 | `NETOPS_EXPORT_TOO_LARGE` | 匯出筆數超過上限 |
| 502 | `NETOPS_FTP_UNAVAILABLE` | FTP 連線或讀取失敗。訊息為「動作 + FTP 路徑:原因」,原因只有分類(連線逾時、拒絕連線、找不到主機、連線中斷、TLS 憑證驗證失敗、帳號或密碼錯誤(FTP 530)、檔案或目錄不存在,或沒有權限(FTP 550)…),不含 FTP 主機、port 與原始錯誤;原始錯誤只寫服務日誌。匯入狀態的 `lastSyncError`、檔案的 `error`、工作的 `error.message` 同樣規則 |
| 503 | `NETOPS_FTP_NOT_CONFIGURED` | 未設定 FTP(只會在 dev) |
| 404 | `NETOPS_PA_OUT_OF_RETENTION` | 期間整個超過 ClickHouse 保留期限(訊息含目前有資料的範圍;§4.1–§4.3) |
| 409 | `NETOPS_RECON_PENDING` | 這一天的 FTP 檔還沒同步分析完,不能補漏(§5.3) |
| 409 | `NETOPS_BACKFILL_NOTHING` | 這一天沒有需要補漏的小時(§5.3) |
| 409 | `NETOPS_BACKFILL_BUSY` | 補漏佇列已滿(§5.3) |
| 404 | `NETOPS_BACKFILL_NOT_FOUND` | 補漏工作不存在或已超過 7 天(§5.3) |
| 503 | `NETOPS_CLICKHOUSE_UNAVAILABLE` | ClickHouse 連不上、查詢失敗或未設定(C3,§4.1–§4.3;不再改用 FTP);熱力圖與時段明細(§4.4)、分析儀表板(§4.5)同樣回這個代碼。只影響用到 ClickHouse 的 API。原始錯誤只寫服務日誌 |
| 409 | `NETOPS_HEATMAP_METRIC_UNAVAILABLE` | 熱力圖指標尚未開放(`ad`,AD 階段 V-d;§4.4) |
| 422 | `NETOPS_HEATMAP_OUT_OF_RETENTION` | 熱力圖日視圖超過 5 分鐘彙總保留(1 年);`details.earliest`(§4.4) |
| 409 | `NETOPS_COLD_ARCHIVE_DISABLED` | 時段明細早於原始表保留、要讀冷歸檔,冷歸檔關閉(`NETOPS_ARCHIVE_ENABLED=0`);`details.hotFrom`(§4.4)。設定狀態,不用 5xx |
| 404 | `NETOPS_COLD_ARCHIVE_NOT_FOUND` | 時段明細期間有一天沒有歸檔成功(尚未歸檔、失敗、超過保留期限、檔案讀不到);`details.missing`(§4.4,C4) |
| 429 | `NETOPS_INSIGHT_BUSY` | 分析儀表板同時計算的查詢已滿(全系統 2 個);帶 `Retry-After`(§4.5,V-b1) |
| 429 | `NETOPS_COLD_QUERY_BUSY` | 已有冷資料查詢在執行(全系統 1 個)或歸檔匯出中;帶 `Retry-After`(§4.4,C4 起) |
| 403 | `NETOPS_PA_CONTROL_DISABLED` | 正式區不能切換收集器的輪詢與接收(§3.2 `collector-control`,只有測試區可用) |
| 429 | `NETOPS_PA_QUERY_BUSY` | PA 精準查詢:已有查詢在執行(全系統 1 個)、間隔 / 冷卻中或管理平面 CPU 過高;帶 `Retry-After`(§3.3) |
| 409 | `NETOPS_PA_QUERY_DISABLED` | PA 精準查詢未啟用(`netops-pa` 沒開查詢執行者或停止回報;§3.3) |
| 404 | `NETOPS_PA_QUERY_NOT_FOUND` | PA 精準查詢工作不存在、不是本人的或超過 10 分鐘(§3.3) |
| 424 | `NETOPS_REDIS_UNAVAILABLE` | 即時監控讀不到 `netops-redis`(§3.2;`snapshot` 例外,回 200 `state: unavailable`)。不用 5xx:避免累積 BFF 斷路器失敗。原始錯誤只寫服務日誌 |
| 424 | `NETOPS_PA_LIVE_DISABLED` | 未設定 `REDIS_URL`(只會在 dev) |
| 403 | `NETOPS_STREAM_OWNER_UNKNOWN` | 身分沒有工號也沒有 sub,不能建立即時串流(正常經 Gateway 不會發生) |
| 503 | `NETOPS_FTP_BUSY` | FTP 連線名額都在使用中(匯入或查詢進行中,測試區只有 1 條),等候 25 秒仍拿不到;請稍後再試 |
| 503 | `NETOPS_NOT_READY` | 資料目錄無法讀寫(`/readyz`) |
| 500 | `NETOPS_DATA_CORRUPT` | 本系統的資料檔損壞或無法讀取(不當成沒有資料;請通知系統負責人) |
| 503 | `NETOPS_JOB_ABORTED` | 服務正在關閉,不接受新工作 |
| 500 | `INTERNAL_ERROR` | 非預期錯誤 |

AI 串流(§10.1)開始後的錯誤以 `error` 事件回傳 `{ code, message }`:上表的代碼(例如 FTP 掃描失敗的 `NETOPS_FTP_UNAVAILABLE`),或 `NETOPS_AI_UNAVAILABLE`(連不到 AI 主機或回應錯誤)、`NETOPS_AI_TIMEOUT`(超過 `LLM_TIMEOUT_MS`)、`NETOPS_AI_FAILED`(非預期錯誤)、`NETOPS_STREAM_CLOSED`(服務重新啟動、超過 15 分鐘);訊息不含 AI 主機位址與上游原文。

工作失敗時,`error.code` 可能是上表的代碼,或 `NETOPS_JOB_TIMEOUT`(超過執行時間上限)、`NETOPS_JOB_ABORTED`(服務關閉時中止)、`NETOPS_JOB_FAILED`(非預期錯誤)。

---

## 9. 舊版 API 對照與移除清單

舊版共 **41** 支(`server/index.js`、`server/routes/*.js`,2026-11-03 盤點;IMPL-PLAN 原估 39)。搬移 27 支(含 `/health`),移除 14 支(`GET /kb?semantic=1` 是參數,不另計)。2026-11-04 取消 AI 中控台(D23)後,AI 的 8 支於 A1 搬移(§10),`GET /ai/context`(開發用)仍移除:合計搬移 35 支、移除 6 支。

### 9.1 搬移

| 舊版(`/NetOps/api`) | 新版(`/api/netops`) |
| --- | --- |
| `GET /health` | 服務 `GET /healthz`、`GET /readyz`(不經 BFF) |
| `GET /palog/days` | `GET /pa/days` |
| `GET /palog/summary` | `GET /pa/overview` |
| `GET /palog/options` | `GET /pa/options` |
| `POST /palog/search` | `POST /pa/log-searches` + `GET /pa/log-searches/{id}`、`/rows`、`/export`、`DELETE`(D6) |
| `GET /pa-events` | `GET /pa-events/types` |
| `GET /pa-events/summary` | `GET /pa-events/overview` |
| `GET /ftp/browse` | `GET /ftp/pa/files` |
| `GET /ftp/status` | `GET /ftp/pa/status` |
| `POST /ftp/sync` | `POST /ftp/pa/syncs`(202,背景執行) |
| `POST /ftp/analyze` | `POST /ftp/pa/analyses` |
| `POST /ftp/cancel` | `DELETE /ftp/pa/analyses` |
| `POST /ftp/forget` | `POST /ftp/pa/result-deletions` |
| `GET /ad/days` | `GET /ad/days`;同步狀態另見 `GET /ftp/ad/status` |
| `GET /ad/browse` | `POST /ftp/ad/listings` + `GET /ftp/ad/listings/{id}`(D6) |
| `POST /ad/sync` | `POST /ftp/ad/syncs`(202,背景執行) |
| `POST /ad/import` | `POST /ftp/ad/imports`(202,背景執行) |
| `POST /ad/forget` | `POST /ftp/ad/result-deletions` |
| `GET /ad/summary` | `GET /ad/overview` |
| `GET /ad/events` | `GET /ad/events`(分頁)、`GET /ad/events/export` |
| `GET /kb` | `GET /kb/notes`(不含語意搜尋) |
| `GET /kb/:id` | `GET /kb/notes/{id}` |
| `GET /kb/:id/md` | `GET /kb/notes/{id}/markdown` |
| `GET /kb/all/md` | `GET /kb/compilation` |
| `POST /kb`、`PUT /kb/:id`、`DELETE /kb/:id` | `POST /kb/notes`、`PUT /kb/notes/{id}`、`DELETE /kb/notes/{id}` |
| `GET /ai/status` | `GET /ai/status`(A1;不回 AI 主機位址) |
| `POST /ai/analyze` | `POST /ai/analyses`(SSE) |
| `POST /ai/ask` | `POST /ai/questions`(SSE) |
| `GET /kb?semantic=1` | `GET /kb/semantic-search` |
| `POST /kb/vector-sync` | `POST /kb/vector-syncs`(202,背景執行);狀態 `GET /kb/vector-status` |
| `GET /kb/learn-ips`、`POST /kb/learn-ips` | `GET /kb/ip-learning`、`POST /kb/ip-learnings`(202) |

### 9.2 移除

| 舊版 | 原因 |
| --- | --- |
| `POST /auth/login`、`GET /auth/sync`、`GET /auth/me` | 登入由 Gateway 處理(AGENT.md §7.1);身分改用 web-kit |
| `POST /jump/:system` | Veeam 改一般連結(D11),不寫 `PortalSolar.SyncLoginInfo` |
| `GET /theme.css` | 新版前端主題由 `src/ui/` 提供(D5) |
| `GET /ai/context` | 開發用(看送給 AI 的資料),不搬移;其他 AI API 於 A1 搬移,見 §9.1(D17 已由 D23 取代) |
| `POST /ai/note`、`POST /ai/translate` | 整理筆記(請 AI 記錄)與翻譯:需求方 2026-11-09 依 `docs/AI-FEATURE-INVENTORY.md` 決定不搬(ARCHITECTURE D25);管理者在知識庫頁自己寫筆記 |

舊版的 `.env` 名單(`VIEW_USERS`、`VIEW_DEPTS`、`KB_ADMINS`)與 `JWT_*` 不再使用,權限改由 Gateway RBAC(D15)。

---

## 10. AI — 批次 `feature/a1-ai-api`(IMPL-PLAN A1)

由舊版 `server/routes/ai.js` 搬移,直接呼叫 AI 主機(ARCHITECTURE D23;`LLM_URL`、`LLM_MODEL`、`EMBED_URL`、`QDRANT_URL` 只從設定讀)。送給模型的內容與舊版相同,**只送統計與彙整,不送原始 log 檔**(AGENT.md §7.4;問答的彙整含最多 15 筆範例紀錄、AD 事件訊息前 400 字,同舊版,為 §7.4 的例外,ARCHITECTURE D25)。哪些功能保留見 [AI-FEATURE-INVENTORY.md](AI-FEATURE-INVENTORY.md)。沒有設定 `LLM_URL` 時回 409 `NETOPS_AI_DISABLED`。

### 10.1 分析、問答(SSE)

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/netops/ai/status` | `netops.ai.use` | `{ enabled, ok, model, message }`;不回主機位址 |
| POST | `/api/netops/ai/analyses` | `netops.ai.use` | 期間分析;`{ from, to?, think?, question? }`(`YYYY-MM-DD`,最長 92 天) |
| POST | `/api/netops/ai/questions` | `netops.ai.use` | 問答;`{ from, to, question, history?, think?, source? }`(ISO 8601,最長 31 天;`source: 'ad'` 只看 AD) |

- **全部回 SSE**(`text/event-stream`):掃描 FTP 與模型回答可能超過路由逾時(AGENT.md §7.3),寫法依 S0(本文件 §3.1、`docs/test-reports/2026-11-05-s0-sse.md` §3.6):`x-timeout-ms: 60000`、立即送 `open`、每 15 秒 `heartbeat`、`X-Accel-Buffering: no`。POST,前端以 `fetch` 讀串流(`EventSource` 只能 GET);一次性回答,不重連。
- 參數錯誤、沒有資料(404 `NETOPS_PA_NO_DATA`)、AI 未設定在串流開始前回 4xx;開始後的錯誤以 `error` 事件回傳(§8)。
- 同時進行的 AI 回答(分析與問答共用名額)每人 2 個、全系統 6 個(`AI_MAX_STREAMS`、`AI_MAX_STREAMS_PER_USER`,程式預設值,compose 未列出),超過回 429 `NETOPS_STREAM_BUSY`;單一回答最長 15 分鐘;使用者關頁時中斷掃描與模型呼叫。問答需要從 FTP 掃原始 log 時,全系統同時只掃 1 個(FTP 連線與匯入、明細查詢共用),其餘排隊並送 `scan` 事件 `{ waiting: true }`;掃描並行數為 `FTP_MAX_CONNECTIONS`(舊版另開一條)。
- `history`:最多 100 則、每則 20,000 字;只送最近 6 則、每則前 4,000 字(同舊版)。問答的問題沒有 IP / Port 時沿用前面的條件(追問);同樣的條件 10 分鐘內不重複掃描(所有人共用,同舊版;資料不完整的結果不快取)。
- **`netops.ai.use` 的資料範圍是 PA + AD + 知識庫**:問答依問題帶入 PA log 彙整、AD 事件與筆記標題,分析帶入 PA 摘要;所以 `gateway-rbac.yaml` 的三個 AI 按鈕都一併綁定 `netops.pa.read`、`netops.ad.read`、`netops.kb.read`。
- 稽核:分析、問答、立即同步、外部 IP 學習都設 `x-audit-level: meta`。
- 翻譯(舊版 `POST /ai/translate`)與整理筆記(舊版 `POST /ai/note`)依 2026-11-09 決定不搬(D25、`docs/AI-FEATURE-INVENTORY.md`)。

| 事件 | 資料 | 出現在 |
| --- | --- | --- |
| `open` | `{ requestId, heartbeatSec }` | 全部 |
| `meta` | 分析:`{ model, from, to, files, missing, rows, contextChars, notes, vectorError }`;問答:`{ model, from, to, files, ips, ports, source }` | 分析、問答 |
| `scan` | `{ label, filesScanned, files, matched, rows?, mode? }`(`mode: 'flows'` = 查連線組合統計) | 問答(有 IP / Port) |
| `evidence` | `{ label, matched, allow, block, flows, filesScanned, files, flowFiles, rows, seconds, partial, cached }`;沒有 IP 時 `{ label, summary: true, files, missing }` | 問答 |
| `events` | `{ hits: [{ type, label, total, kinds }] }` 或 `{ summary: true }` | 問答(PA 其他 log) |
| `ad` | `{ label, total }`(`total` 0 = 沒有已匯入的 AD 事件) | 問答 |
| `notes` | `{ used: [{ id, title, related }], omitted, vectorError }` | 問答 |
| `thinking` | `{ chars }`(思考內容不顯示,只回字數) | 分析、問答(`think: true`) |
| `content` | `{ text }`(Markdown 片段) | 分析、問答 |
| `done` | `{ finish, truncated }` | 全部 |
| `error` | `{ code, message }` | 全部 |
| `heartbeat` | `{ time }` | 全部 |

**資料不完整要明確標示**(AGENT.md §5):`missing` 是摘要檔讀不到的檔案數;`evidence.partial` 為 true 表示 FTP 掃描逾時;`vectorError` 為 true 表示向量庫失敗、筆記改用關鍵字 / IP 比對。模型收到的資料也會註明(舊版既有的文字,例如「掃描逾時…資料不完整」)。

與舊版不同:問答期間最長 31 天;參數超過長度上限回 400(舊版截斷);模型連不到時以 `error` 事件回傳(舊版串流前回 5xx);`meta` 的 `from` / `to` 改 ISO 8601;`status` 不回主機位址;錯誤訊息不含上游原文;`meta` / `evidence` / `notes` 多 `missing`、`vectorError`;沒有翻譯與整理筆記(D25)。

### 10.2 知識庫的 AI 功能

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/netops/kb/semantic-search?q&limit` | `netops.kb.read` | 語意搜尋:`{ items: [筆記 + score], vector }`;相近度 0.6 以上、依相近度排序;`x-timeout-ms: 60000` |
| GET | `/api/netops/kb/vector-status` | `netops.kb.read` | `{ enabled, sync, collection, ok, points, lastSync, error, syncing, upserted, deleted }` |
| POST | `/api/netops/kb/vector-syncs` | `netops.kb.write` | 立即同步(202,背景);`VECTOR_SYNC=0` 回 409 `NETOPS_VECTOR_SYNC_DISABLED` |
| GET | `/api/netops/kb/ip-learning` | `netops.kb.read` | 外部 IP 自動學習狀態(含 `hour`:每天自動執行的時間,-1 = 不自動) |
| POST | `/api/netops/kb/ip-learnings` | `netops.kb.write` | `{ days?: 1–60, max?: 1–500, rewrite? }`;202,背景執行,畫面輪詢 `ip-learning` |

- 向量庫沿用舊版 Qdrant `10.10.130.46:6333` 的 `NetOpsKb`(embedding 同為 Qwen3-Embedding-8B 4096 維,2026-11-05 查證)。**`VECTOR_SYNC` 預設 0**:舊版 IIS 仍在同步同一個 collection,兩邊都同步會互刪對方的筆記;關閉時只做語意搜尋,搜尋結果只回新版知識庫存在的筆記。D18 切換、舊版停止寫入後再開(D25;測試區一直關,正式區切換步驟見 AI-FEATURE-INVENTORY §4)。開啟時:筆記異動 3 秒後、啟動 5 秒後、每 30 分鐘同步(同舊版);一次要刪除超過現有 20%(至少 5 筆)或知識庫是空的時整次不同步。
- 外部 IP 自動學習(D10):`IPLEARN_HOUR` 預設 -1(不自動,舊版 3 點;D25:舊版 IIS 停用後正式區改 3);管理者改過的自動學習筆記不覆寫;自動學習筆記上限 1,000 則。
- 時間欄位(`lastSync`、`startedAt`、`finishedAt`)輸出 `+08:00`。
