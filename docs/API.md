# NetOps API

> `netops-api` 的對外介面:前端(F1)照本文件串接。決策見 [ARCHITECTURE.md](ARCHITECTURE.md),工作項目見 [IMPL-PLAN.md](IMPL-PLAN.md)。
> **狀態:B1 定稿;B2-pa 已實作 §4.1、§5.1;B2-ad 已實作 §4.2、§5.2、§6;B2-kb 已實作 §7;B2-logs 已實作 §4.3(B2 全部完成);A1(AI 搬移)第 2 批 `feature/a1-ai-api` 實作 §10**。各模組在 B2 分批實作,「批次」欄是預定交付的 MR;實作與本文件不同時,以 MR 描述的「API 變更」為準並同步更新本文件。
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
| `netops.pa.read` | PA 防火牆:查詢 | §4.1、§4.2 |
| `netops.pa-log.read` | PA Log 明細:查詢 | §4.3 |
| `netops.ftp.read` | FTP Log 檔案:查詢 | §5 讀取 |
| `netops.ftp.write` | FTP Log 檔案:同步與管理 | §5 寫入 |
| `netops.ad.read` | AD 事件:查詢 | §6.1 |
| `netops.ad-log.read` | AD Log 明細:查詢 | §6.2 |
| `netops.kb.read` | 知識庫:查詢 | §7 讀取、§10.2 讀取(語意搜尋、向量庫與外部 IP 學習狀態) |
| `netops.kb.write` | 知識庫:編輯 | §7 寫入、§10.1 整理筆記、§10.2 立即同步 / 學習 |
| `netops.ai.use` | AI 分析與問答:使用 | §10.1(分析、問答、翻譯、狀態)。不是 `.read`:選單不能綁定,由按鈕 `netops.pa-ask.use`、`netops.ad-ask.use`、`netops.pa-dashboard.ai` 綁定(`gateway-rbac.yaml`);給 `netops-admin`、`netops-viewer`(2026-11-05 決定) |

稽核:Log 明細查詢與匯出、知識庫下載、AI 分析與問答(§10.1)設 `x-audit-level: meta`。

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
| 429 | `NETOPS_STREAM_BUSY` | 串流連線數已達上限:串流驗證(§3.1,每人 2 條、全系統 20 條)、AI 回答(§10.1,每人 2 個、全系統 6 個);不用 5xx,避免累積 BFF 斷路器失敗 |
| 422 | `NETOPS_EXPORT_TOO_LARGE` | 匯出筆數超過上限 |
| 502 | `NETOPS_FTP_UNAVAILABLE` | FTP 連線或讀取失敗。訊息為「動作 + FTP 路徑:原因」,原因只有分類(連線逾時、拒絕連線、找不到主機、連線中斷、TLS 憑證驗證失敗、帳號或密碼錯誤(FTP 530)、檔案或目錄不存在,或沒有權限(FTP 550)…),不含 FTP 主機、port 與原始錯誤;原始錯誤只寫服務日誌。匯入狀態的 `lastSyncError`、檔案的 `error`、工作的 `error.message` 同樣規則 |
| 503 | `NETOPS_FTP_NOT_CONFIGURED` | 未設定 FTP(只會在 dev) |
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
| `POST /ai/note` | `POST /ai/notes`(SSE,舊版同步回應) |
| `POST /ai/translate` | `POST /ai/translations`(SSE,舊版同步回應) |
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

舊版的 `.env` 名單(`VIEW_USERS`、`VIEW_DEPTS`、`KB_ADMINS`)與 `JWT_*` 不再使用,權限改由 Gateway RBAC(D15)。

---

## 10. AI — 批次 `feature/a1-ai-api`(IMPL-PLAN A1)

由舊版 `server/routes/ai.js` 搬移,直接呼叫 AI 主機(ARCHITECTURE D23;`LLM_URL`、`LLM_MODEL`、`EMBED_URL`、`QDRANT_URL` 只從設定讀)。送給模型的內容與舊版相同,**只送統計與彙整,不送原始 log 檔**(AGENT.md §7.4;問答的彙整含最多 15 筆範例紀錄、AD 事件訊息前 400 字,同舊版,為 §7.4 的例外,ARCHITECTURE D25)。哪些功能保留見 [AI-FEATURE-INVENTORY.md](AI-FEATURE-INVENTORY.md)。沒有設定 `LLM_URL` 時回 409 `NETOPS_AI_DISABLED`。

### 10.1 分析、問答、翻譯、整理筆記(SSE)

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/netops/ai/status` | `netops.ai.use` | `{ enabled, ok, model, message }`;不回主機位址 |
| POST | `/api/netops/ai/analyses` | `netops.ai.use` | 期間分析;`{ from, to?, think?, question? }`(`YYYY-MM-DD`,最長 92 天) |
| POST | `/api/netops/ai/questions` | `netops.ai.use` | 問答;`{ from, to, question, history?, think?, source? }`(ISO 8601,最長 31 天;`source: 'ad'` 只看 AD) |
| POST | `/api/netops/ai/translations` | `netops.ai.use` | `{ text, target }`(`en`、`zh`、`ja`、`th`;30,000 字內、分段最多 12 段,同時翻 3 段;超過回 400) |
| POST | `/api/netops/ai/notes` | `netops.kb.write` | 整理成知識庫筆記;`{ text, history? }`(4,000 字內) |

- **全部回 SSE**(`text/event-stream`):掃描 FTP 與模型回答可能超過路由逾時(AGENT.md §7.3),寫法依 S0(本文件 §3.1、`docs/test-reports/2026-11-05-s0-sse.md` §3.6):`x-timeout-ms: 60000`、立即送 `open`、每 15 秒 `heartbeat`、`X-Accel-Buffering: no`。POST,前端以 `fetch` 讀串流(`EventSource` 只能 GET);一次性回答,不重連。
- 參數錯誤、沒有資料(404 `NETOPS_PA_NO_DATA`)、AI 未設定在串流開始前回 4xx;開始後的錯誤以 `error` 事件回傳(§8)。
- 同時進行的 AI 回答(四支共用名額)每人 2 個、全系統 6 個(`AI_MAX_STREAMS`、`AI_MAX_STREAMS_PER_USER`,程式預設值,compose 未列出),超過回 429 `NETOPS_STREAM_BUSY`;單一回答最長 15 分鐘;使用者關頁時中斷掃描與模型呼叫。問答需要從 FTP 掃原始 log 時,全系統同時只掃 1 個(FTP 連線與匯入、明細查詢共用),其餘排隊並送 `scan` 事件 `{ waiting: true }`;掃描並行數為 `FTP_MAX_CONNECTIONS`(舊版另開一條)。
- `history`:最多 100 則、每則 20,000 字;只送最近 6 則、每則前 4,000 字(同舊版)。問答的問題沒有 IP / Port 時沿用前面的條件(追問);同樣的條件 10 分鐘內不重複掃描(所有人共用,同舊版;資料不完整的結果不快取)。
- **`netops.ai.use` 的資料範圍是 PA + AD + 知識庫**:問答依問題帶入 PA log 彙整、AD 事件與筆記標題,分析帶入 PA 摘要;所以 `gateway-rbac.yaml` 的三個 AI 按鈕都一併綁定 `netops.pa.read`、`netops.ad.read`、`netops.kb.read`。
- 稽核:分析、問答、翻譯、整理筆記、立即同步、外部 IP 學習都設 `x-audit-level: meta`。

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
| `done` | 分析 / 問答:`{ finish, truncated }`;翻譯:`{ target, text, seconds }`;整理筆記:`{ note }`(§7 的筆記格式) | 全部 |
| `error` | `{ code, message }` | 全部 |
| `heartbeat` | `{ time }` | 全部 |

**資料不完整要明確標示**(AGENT.md §5):`missing` 是摘要檔讀不到的檔案數;`evidence.partial` 為 true 表示 FTP 掃描逾時;`vectorError` 為 true 表示向量庫失敗、筆記改用關鍵字 / IP 比對。模型收到的資料也會註明(舊版既有的文字,例如「掃描逾時…資料不完整」)。

與舊版不同:翻譯、整理筆記改 SSE(舊版同步回應,最長 180 秒);問答期間最長 31 天;參數超過長度上限回 400(舊版截斷);模型連不到時以 `error` 事件回傳(舊版串流前回 5xx);`meta` 的 `from` / `to` 改 ISO 8601;`status` 不回主機位址;錯誤訊息不含上游原文;`meta` / `evidence` / `notes` 多 `missing`、`vectorError`;整理筆記的標題與標籤壓成一行(新版筆記規則)。

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
