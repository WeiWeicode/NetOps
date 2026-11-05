# NetOps API

> `netops-api` 的對外介面:前端(F1)照本文件串接。決策見 [ARCHITECTURE.md](ARCHITECTURE.md),工作項目見 [IMPL-PLAN.md](IMPL-PLAN.md)。
> **狀態:B1 定稿;B2-pa 已實作 §4.1、§5.1;B2-ad 已實作 §4.2、§5.2、§6;B2-kb 已實作 §7;B2-logs 已實作 §4.3(B2 全部完成)**。各模組在 B2 分批實作,「批次」欄是預定交付的 MR;實作與本文件不同時,以 MR 描述的「API 變更」為準並同步更新本文件。
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

明細查詢、AD 的 FTP 檔案清單使用工作模式。工作**只有建立者本人可查與取消**,別人的工作回 404;只存在記憶體,服務重新啟動後失效(回 404 `NETOPS_JOB_NOT_FOUND`,前端提示重新送出);完成後保留 30 分鐘。進行中的工作上限依**工作類型**分開計算(明細查詢一組、AD 的 FTP 檔案清單一組):每種每人同時最多 2 個、全系統最多 6 個,超過回 409 `NETOPS_JOB_LIMIT_EXCEEDED`(取消後,要等工作真正停止才釋放名額,通常幾秒內)。每人保留的已完成工作:明細查詢 5 筆(§4.3)、AD 檔案清單 10 筆,超過時先丟自己最舊的。

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
| `netops.pa.read` | PA 防火牆:查詢 | §4.1、§4.2 |
| `netops.pa-log.read` | PA Log 明細:查詢 | §4.3 |
| `netops.ftp.read` | FTP Log 檔案:查詢 | §5 讀取 |
| `netops.ftp.write` | FTP Log 檔案:同步與管理 | §5 寫入 |
| `netops.ad.read` | AD 事件:查詢 | §6.1 |
| `netops.ad-log.read` | AD Log 明細:查詢 | §6.2 |
| `netops.kb.read` | 知識庫:查詢 | §7 讀取 |
| `netops.kb.write` | 知識庫:編輯 | §7 寫入 |

稽核:Log 明細查詢與匯出、知識庫下載、即時 log(§3.2 `logs`、`stream`)設 `x-audit-level: meta`。

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

### 3.2 PA 即時監控(R1)— 批次 `feature/r1-api`

資料來源是 `netops-redis`(`netops-pa` 收集器寫入,PA-LIVE-PLAN §3–§4),本服務只讀。保留:TRAFFIC 明細 1 小時、統計 1 天;其他類型 2 天(D21);更早的資料用 §4.3 Log 明細查詢(FTP)。權限一律 `netops.pa-realtime.read`。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/netops/pa-live/snapshot` | 收集器狀態 `collector` 與設備快照 `metrics`(`session`、`cpu`、`throughput`、`interfaces`) |
| GET | `/api/netops/pa-live/series?metric=&minutes=` | 指標趨勢(`minutes` 1–120,預設 60;由舊到新,最多約 360 點) |
| GET | `/api/netops/pa-live/top?type=&minutes=&limit=&dims=` | 最近 5 / 15 / 60 分鐘的排行與統計 |
| GET | `/api/netops/pa-live/logs?type=&limit=&before=&ip=&port=&action=` | 最新 log(由新到舊;`x-audit-level: meta`) |
| GET | `/api/netops/pa-live/stream?types=&ip=&port=&action=` | SSE 串流(`x-audit-level: meta`、`x-timeout-ms: 60000`) |

**收集器狀態** `collector`:`state` 與中文 `message`、`updatedAt`(心跳時間)、`poll`(`enabled`、`lastOkAt`、`error`、`errorAt`)、`receive`(`enabled`、`tls`、`httpLastAt`、`syslogLastAt`)、`redis`(`error`)、`counters`(`received`、`dropped`、`rejected`、`malformed`、`redisFailed`,收集器啟動後累計)。

| `state` | 條件 | 畫面 |
| --- | --- | --- |
| `ok` | 心跳 30 秒內更新 | 正常顯示 |
| `degraded` | 輪詢有錯誤(連不到 PA-560、Key 失效、某指令失敗)或 Redis 寫入錯誤 | 顯示錯誤;快照過期的指標顯示「停止更新」 |
| `disabled` | `PA_POLL_ENABLED`、`PA_RECEIVE_ENABLED` 都關閉(測試區預設) | 「收集器未啟用」 |
| `stopped` | 心跳超過 30 秒沒更新 | 「資料停止更新」,`metrics` 全為 `null`(**不顯示舊快照**,AGENT §5) |
| `not-running` | Redis 沒有心跳 | 「收集器沒有啟動過」 |
| `unavailable` | Redis 連不上或未設定 | 「無法連線即時資料庫」,`metrics` 全為 `null` |

- `snapshot` 在 Redis 連不上時仍回 **200**(`state: unavailable`):頁面每 10 秒更新,回 5xx 會累積 BFF 斷路器失敗、讓整個 `netops-api` 被短路。其他查詢回 **424** `NETOPS_REDIS_UNAVAILABLE`(同樣不用 5xx;R1 審查時確認 BFF `upstream.ts` 把上游 5xx 計為斷路器失敗)。Redis 回指令錯誤(程式或資料問題)回 500 `INTERNAL_ERROR`。Redis 不可用與恢復時 `netops-api` 各記一筆 warn。
- 收集器心跳裡的錯誤(`poll.error`、`redis.error`)回給畫面前**只留分類**(例 `session:API Key 無效或權限不足`、`連不到主機`、`連線逾時`、`憑證驗證失敗`、`設備不支援此查詢`),不含主機、IP 與網址;原文看 `netops-pa` 容器日誌。
- 查詢成本:`top` 60 分鐘的 TRAFFIC 全部維度約 540 個 Redis 指令(各維度同時送出);畫面每 30 秒查一次。
- 每個快照 60 秒沒更新就過期為 `null`;快照帶 `time`(收集器取得的時間)。`session`:`active`、`max`、`utilization`(%)、`tcp`、`udp`、`icmp`;`throughput`:`bps`、`pps`、`cps`;`cpu`:`mgmt`(管理平面 %)、`dataplane`(資料平面各核心平均 %)、`memUsed`、`memTotal`(bytes);`interfaces.items[]`:`name`、`rxBps`、`txBps`(第一次輪詢或計數歸零時為 `null`)。
- `top`:`totals`(`count`;TRAFFIC 另有 `bytes`、`packets`)、`kpis`(例 `action: { allow: 13, deny: 2 }`;每分鐘每項最多 50 種值,其餘併為 `(其他)`)、`tops[dim]: [{ key, value }]`(每分鐘只保留前 200 名,合併後為近似值;`*Bytes` 維度的 value 是位元組)、`perMinute: [{ minute, count }]`、`retentionSec`。次數已乘 Repeat Count(TRAFFIC 除外)。維度:TRAFFIC `src`、`dst`、`app`、`rule`、`port`、`srcBytes`、`dstBytes`、`appBytes`;其他類型見 `backend/src/infra/redis/index.ts` `TOP_DIMS`。
- `logs`(剛好湊滿 `limit` 時 `nextBefore` 不是 `null`,下一頁可能是空的):`items[]` 為 log 欄位(key 同舊版 `palog.js` / `paevents.js`,PA-LIVE-PLAN §4)加 `id`、`type`、`receivedAt`(收集器收到的時間);`nextBefore`(下一頁游標,沒有更早資料為 `null`)、`scanned`、`truncated`(篩選時一次最多掃描 5000 筆,沒湊滿 `limit` 時為 `true`:結果不完整)、`earliest`(Redis 內最早一筆的時間)、`retentionSec`。`ip` 比對 `src`、`dst`、`natSrc`、`natDst`、`ip`、`publicIp`、`privateIp`;`port` 比對 `dport` 或 `sport`;`action` 完全相同。
- `stream`(SSE,寫法同 §3.1):立即送 `retry: 5000` 與 `open`(`types`、`filter`、`heartbeatSec`、`maxSec`、`resumed`),接著 `snapshot`(同 `GET /snapshot`,之後每 10 秒);有新 log 時每 2 秒最多一次送 `logs`(`items` 由舊到新,最多 200 筆,超過的筆數在 `dropped`;某類型一次超過 500 筆跟不上時跳到最新並列在 `skipped`);每 15 秒 `heartbeat`。`types` 預設 `traffic,threat`。只有 `logs` 事件帶 `id`(游標 `traffic:<StreamID>,threat:<StreamID>`),斷線重連時以 `Last-Event-ID` 接續;沒有游標時只送連線之後的新 log;游標比現在早超過 **5 分鐘**的類型不接續(從最新開始,列在 `open.gap`),重連只補斷線期間,不能用來撈舊明細(舊明細用 `GET /logs`,有稽核)。某類型讀取失敗時該類型的游標不推進(恢復後補上),送 `degraded`(`types`、`message`;恢復時 `types` 為空)。單一連線最長 **5 分鐘**(需求方 2026-11-05 決定;撤權後最晚 5 分鐘停止),每人 2 條、全系統 20 條,超過回 **429** `NETOPS_STREAM_BUSY`。Redis 暫時失敗時串流不中斷,`snapshot` 帶 `state: unavailable`。

---

## 4. 防火牆 PA-560

### 4.1 流量總覽(TRAFFIC)— 批次 `feature/netops-b2-pa`

| 方法 | 路徑 | 權限 | 舊版 |
| --- | --- | --- | --- |
| GET | `/api/netops/pa/days` | `netops.pa.read` | `GET /palog/days` |
| GET | `/api/netops/pa/overview?from&to&top` | `netops.pa.read` | `GET /palog/summary` |
| GET | `/api/netops/pa/options?from&to` | `netops.pa.read` | `GET /palog/options` |

**`GET /pa/days`**:有資料的日期(依 log 內的資料時間,不是檔名日期),新的在前。

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
  "scan": [ { "src": "1.2.3.4", "n": 5000, "dsts": 300, "ports": 2, "zone": "untrust → trust" } ]
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

舊版 `POST /palog/search` 同步等待最長 180 秒,超過路由上限,改成工作模式。查詢依時間挑出已分析的檔案,從 FTP 串流逐列篩選,原始 log 不落地;找到上限筆數或超過掃描秒數就停止。

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

AI 相關(語意搜尋、向量同步、外部 IP 自動學習)不搬移(ARCHITECTURE D17)。內容輸出前端時一律經 DOMPurify(AGENT.md §7.4)。

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
| 429 | `NETOPS_STREAM_BUSY` | 串流連線數已達上限(§3.1 串流驗證、§3.2 即時監控,每人 2 條、全系統 20 條);不用 5xx,避免累積 BFF 斷路器失敗 |
| 422 | `NETOPS_EXPORT_TOO_LARGE` | 匯出筆數超過上限 |
| 502 | `NETOPS_FTP_UNAVAILABLE` | FTP 連線或讀取失敗。訊息為「動作 + FTP 路徑:原因」,原因只有分類(連線逾時、拒絕連線、找不到主機、連線中斷、TLS 憑證驗證失敗、帳號或密碼錯誤(FTP 530)、檔案或目錄不存在,或沒有權限(FTP 550)…),不含 FTP 主機、port 與原始錯誤;原始錯誤只寫服務日誌。匯入狀態的 `lastSyncError`、檔案的 `error`、工作的 `error.message` 同樣規則 |
| 503 | `NETOPS_FTP_NOT_CONFIGURED` | 未設定 FTP(只會在 dev) |
| 424 | `NETOPS_REDIS_UNAVAILABLE` | 即時監控讀不到 `netops-redis`(§3.2;`snapshot` 例外,回 200 `state: unavailable`)。不用 5xx:避免累積 BFF 斷路器失敗。原始錯誤只寫服務日誌 |
| 424 | `NETOPS_PA_LIVE_DISABLED` | 未設定 `REDIS_URL`(只會在 dev) |
| 403 | `NETOPS_STREAM_OWNER_UNKNOWN` | 身分沒有工號也沒有 sub,不能建立即時串流(正常經 Gateway 不會發生) |
| 503 | `NETOPS_FTP_BUSY` | FTP 連線名額都在使用中(匯入或查詢進行中,測試區只有 1 條),等候 25 秒仍拿不到;請稍後再試 |
| 503 | `NETOPS_NOT_READY` | 資料目錄無法讀寫(`/readyz`) |
| 500 | `NETOPS_DATA_CORRUPT` | 本系統的資料檔損壞或無法讀取(不當成沒有資料;請通知系統負責人) |
| 503 | `NETOPS_JOB_ABORTED` | 服務正在關閉,不接受新工作 |
| 500 | `INTERNAL_ERROR` | 非預期錯誤 |

工作失敗時,`error.code` 可能是上表的代碼,或 `NETOPS_JOB_TIMEOUT`(超過執行時間上限)、`NETOPS_JOB_ABORTED`(服務關閉時中止)、`NETOPS_JOB_FAILED`(非預期錯誤)。

---

## 9. 舊版 API 對照與移除清單

舊版共 **41** 支(`server/index.js`、`server/routes/*.js`,2026-11-03 盤點;IMPL-PLAN 原估 39)。搬移 27 支(含 `/health`),移除 14 支(`GET /kb?semantic=1` 是參數,不另計)。

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

### 9.2 移除

| 舊版 | 原因 |
| --- | --- |
| `POST /auth/login`、`GET /auth/sync`、`GET /auth/me` | 登入由 Gateway 處理(AGENT.md §7.1);身分改用 web-kit |
| `POST /jump/:system` | Veeam 改一般連結(D11),不寫 `PortalSolar.SyncLoginInfo` |
| `GET /theme.css` | 新版前端主題由 `src/ui/` 提供(D5) |
| `GET /ai/status`、`POST /ai/analyze`、`POST /ai/ask`、`POST /ai/note`、`POST /ai/translate`、`GET /ai/context` | AI 不搬移,留在舊版 IIS(D17、D18) |
| `GET /kb/learn-ips`、`POST /kb/learn-ips` | 外部 IP 自動學習屬 AI(D10、D17) |
| `POST /kb/vector-sync`、`GET /kb?semantic=1` | 向量同步與語意搜尋屬 AI(D17) |

舊版的 `.env` 名單(`VIEW_USERS`、`VIEW_DEPTS`、`KB_ADMINS`)與 `JWT_*` 不再使用,權限改由 Gateway RBAC(D15)。
