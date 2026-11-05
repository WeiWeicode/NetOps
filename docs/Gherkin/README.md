# NetOps — Gherkin 行為規格

> 以 Gherkin(繁體中文關鍵字,`# language: zh-TW`)描述 NetOps 新版(接入 Gateway 後)的**目標行為**。寫法沿用員工入口網 `giga-Portal/docs/Gherkin/`。
> 依據:`backend/src` 各路由的 `x-gherkin`、[API.md](../API.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)(D6、D8、D14–D18、§5)、[UI-GUIDE.md](../UI-GUIDE.md)。舊版 `server/`、`src/` 只作比對,行為不同處標 `@changed`。
> AI 功能(問答、分析、翻譯、整理筆記、語意搜尋、向量同步、外部 IP 自動學習)不搬移(D17),不寫。
> **最後更新:2026-11-05**(`feature/s0-sse`:S0 串流驗證場景 `pa-live/stream-test.feature`;`fix/d1-uat-findings`:D1 驗收修正的場景;2026-11-03 依 `develop` e3475f8:B0–B2 全部合併;前端依 `origin/feature/netops-f1-*`)。

## 1. 檔案一覽

| 檔案 | 內容 | 依據 | 階段 |
| --- | --- | --- | --- |
| `api/skeleton.feature` | 連線驗證、內部 Token、錯誤格式、`/readyz`、OpenAPI、**全部 API 的 401 / 403 權限表**、設定 | API.md §2、§3、§8;ARCHITECTURE §5、D15 | B0、B1 |
| `api/jobs.feature` | 工作模式共通規則:狀態轉換、本人才能查、數量與保留上限 | API.md §1.1;ARCHITECTURE D6、D9 | B1 |
| `pa/overview.feature` | PA 有資料的日期、流量總覽、篩選選項 | API.md §4.1 | B2 |
| `pa-events/overview.feature` | 安全事件(其他類型 log)類型與總覽 | API.md §4.2 | B2 |
| `pa-log-searches/search.feature` | PA Log 明細查詢、分頁、匯出、取消(工作模式) | API.md §4.3;D6 | B2 |
| `ftp/pa-files.feature` | FTP Log 檔案(PA):瀏覽、進度、同步、分析、取消、刪除分析結果 | API.md §5.1 | B2 |
| `ftp/ad-files.feature` | FTP Log 檔案(AD):清單(工作模式)、同步、重新匯入、刪除 | API.md §5.2;D14 | B2 |
| `ad/events.feature` | AD 已匯入日期、總覽、明細查詢、匯出 | API.md §6 | B2 |
| `kb/notes.feature` | 知識庫筆記查詢、下載、匯整檔、新增、修改、刪除 | API.md §7;D17 | B2 |
| `pa-live/stream-test.feature` | S0 SSE 串流驗證:open / heartbeat、重連、連線上限、經 Gateway 長連線 | API.md §3.1;IMPL-PLAN S0 | S0 |
| `ui/navigation.feature` | 應用層守衛(`/?denied=netops`)、選單依權限、403、一般連結 | UI-GUIDE §5;FRONTEND-GUIDE §7.4 | F1 |
| `ui/requests.feature` | CSRF、不存 Token、下載、工作輪詢與取消、資料不完整提示、DOMPurify | FRONTEND-GUIDE §6;API.md §1 | F1 |
| `check-scenarios.mjs` | 比對 `x-gherkin` 與本目錄場景的腳本(§5) | — | — |

## 2. 標籤

| 標籤 | 意義 | 如何驗證 |
| --- | --- | --- |
| `@B0` `@B1` `@B2` `@F1` `@S0` | 所屬工作項目(IMPL-PLAN) | — |
| `@auto` | 已有自動化測試涵蓋(測試名稱不一定與場景相同,§4 列對照) | `backend/`:`npm test`;`frontend/`:`npm test` |
| `@manual` | 以瀏覽器或主控台操作驗證 | 修正紀錄或 MR 寫明步驟 |
| `@e2e` | 要經 Gateway(BFF 檢查登入與 `x-permission`)才能驗證 | 測試區瀏覽器 |
| `@untested` | 已實作,尚無自動化測試也還沒手動驗證 | 補測試時改成 `@auto` |
| `@pending-ui` | 前端尚未實作或未確認(F1 進行中) | F1 該頁完成後改標籤 |
| `@changed` | 與舊版 IIS 行為不同;場景內以註解寫原因 | — |
| `@security` | 安全相關 | — |

## 3. 撰寫原則

- 關鍵字用 zh-TW:`功能`、`背景`、`場景`、`場景大綱`、`例子`、`假如`、`當`、`那麼`、`而且`、`但是`;分組用 `Rule:`。
- 場景描述**可觀察的行為**:HTTP 狀態、`code`、回應欄位、畫面。路徑寫對外路徑 `/api/netops/*`;直連服務的場景寫後端路徑 `/v1/*`。
- 每個場景上方以 `# 來源: 檔案:行號` 標出依據的程式(前端來源註明分支);`x-gherkin` 的場景指到場景名稱所在的行。
- `x-gherkin` 的每個場景在這裡都有**名稱完全相同**的場景(§5 用腳本比對);這裡另補權限、輸入錯誤、狀態轉換與 `@changed` 的場景。
- 401 / 403 由 BFF 回應(`UNAUTHENTICATED`、`PERMISSION_DENIED`,Gateway 專用代碼);netops-api 自己的錯誤一律 `NETOPS_*` 或 `VALIDATION_FAILED`。全部 API 的權限表集中在 `api/skeleton.feature`,各模組不重複。
- 帳號一律用假工號(S112009、S094009、S999999…);不寫真實帳密。

## 4. 進度

`@auto` 對應的測試:`backend/test/unit/{app,config,jobs,store,ftp,pa,ad,kb,logs,pa-live}.test.ts`、F1 的 `frontend/test/{guard,menu,links,useJob,usePolling,ftpFiles}.test.ts`。

| 檔案 | 場景 | `@auto` | `@manual` / `@e2e` | `@untested` | `@pending-ui` | `@changed` |
| --- | --- | --- | --- | --- | --- | --- |
| `api/skeleton.feature` | 14 | 11 | 4 | 0 | 0 | 3 |
| `api/jobs.feature` | 14 | 14 | 0 | 0 | 0 | 整個功能 |
| `pa/overview.feature` | 9 | 7 | 0 | 2 | 0 | 2 |
| `pa-events/overview.feature` | 4 | 4 | 0 | 0 | 0 | 1 |
| `pa-log-searches/search.feature` | 21 | 18 | 0 | 3 | 0 | 整個功能 + 6 |
| `ftp/pa-files.feature` | 18 | 16 | 0 | 2 | 0 | 7 |
| `ftp/ad-files.feature` | 15 | 13 | 1 | 1 | 0 | 5 |
| `ad/events.feature` | 11 | 10 | 0 | 1 | 0 | 4 |
| `kb/notes.feature` | 18 | 16 | 0 | 2 | 0 | 7 |
| `pa-live/stream-test.feature` | 8 | 6 | 5 | 0 | 0 | 0 |
| `ui/navigation.feature` | 11 | 9 | 0 | 1 | 2 | 2 |
| `ui/requests.feature` | 9 | 2 | 1 | 2 | 4 | 2 |
| **合計** | **152** | **126** | **11** | **14** | **6** | **39 + 2 個功能** |

(場景數含 `場景大綱`;數字以 §5 的腳本輸出為準。)

## 5. API → 場景 → 檔案對照

**`x-gherkin` 55 個場景全部對應到同名場景**(36 個 operation;`check-scenarios.mjs` 於 2026-11-05 比對,0 個問題)。重新比對:

```bash
cd backend && npm run -s openapi > ../openapi.tmp.json && node ../docs/Gherkin/check-scenarios.mjs ../openapi.tmp.json --table
```

| API | `x-gherkin` 場景 | 檔案 |
| --- | --- | --- |
| `GET /api/netops/ping` | 有權限的使用者取得自己的身分 | `api/skeleton.feature` |
| `GET /api/netops/ping` | 沒有權限時拒絕 | `api/skeleton.feature` |
| `GET /api/netops/ping` | 直連服務沒有內部 Token | `api/skeleton.feature` |
| `GET /api/netops/pa-live/stream-test` | 連線後立即收到 open 事件 | `pa-live/stream-test.feature` |
| `GET /api/netops/pa-live/stream-test` | 每 15 秒收到 heartbeat | `pa-live/stream-test.feature` |
| `GET /api/netops/pa-live/stream-test` | 斷線後重連序號接續 | `pa-live/stream-test.feature` |
| `GET /api/netops/pa-live/stream-test` | 沒有權限時拒絕 | `pa-live/stream-test.feature` |
| `GET /api/netops/pa/days` | 列出有資料的日期 | `pa/overview.feature` |
| `GET /api/netops/pa/overview` | 查詢期間總覽 | `pa/overview.feature` |
| `GET /api/netops/pa/overview` | 沒有資料的期間 | `pa/overview.feature` |
| `GET /api/netops/pa/overview` | 日期格式錯誤 | `pa/overview.feature` |
| `GET /api/netops/pa/options` | 取得篩選選項 | `pa/overview.feature` |
| `POST /api/netops/pa/log-searches` | 送出明細查詢 | `pa-log-searches/search.feature` |
| `POST /api/netops/pa/log-searches` | 期間沒有資料 | `pa-log-searches/search.feature` |
| `GET /api/netops/pa/log-searches/{id}` | 查詢自己的工作 | `pa-log-searches/search.feature` |
| `GET /api/netops/pa/log-searches/{id}` | 別人的工作 | `pa-log-searches/search.feature` |
| `DELETE /api/netops/pa/log-searches/{id}` | 取消工作 | `pa-log-searches/search.feature` |
| `GET /api/netops/pa/log-searches/{id}/rows` | 取第一頁 | `pa-log-searches/search.feature` |
| `GET /api/netops/pa/log-searches/{id}/export` | 匯出 CSV | `pa-log-searches/search.feature` |
| `GET /api/netops/pa-events/types` | 列出類型 | `pa-events/overview.feature` |
| `GET /api/netops/pa-events/overview` | 查詢威脅總覽 | `pa-events/overview.feature` |
| `GET /api/netops/pa-events/overview` | 不支援的類型 | `pa-events/overview.feature` |
| `GET /api/netops/ad/days` | 列出已匯入的日期 | `ad/events.feature` |
| `GET /api/netops/ad/overview` | 查詢期間總覽 | `ad/events.feature` |
| `GET /api/netops/ad/events` | 查詢登入失敗 | `ad/events.feature` |
| `GET /api/netops/ad/events` | 期間太長 | `ad/events.feature` |
| `GET /api/netops/ad/events/export` | 匯出 CSV | `ad/events.feature` |
| `GET /api/netops/ad/events/export` | 超過 20000 筆 | `ad/events.feature` |
| `POST /api/netops/ftp/ad/listings` | 送出清單工作 | `ftp/ad-files.feature` |
| `GET /api/netops/ftp/ad/listings/{id}` | 查詢自己的工作 | `ftp/ad-files.feature` |
| `GET /api/netops/ftp/ad/listings/{id}` | 別人的工作 | `ftp/ad-files.feature` |
| `DELETE /api/netops/ftp/ad/listings/{id}` | 取消工作 | `ftp/ad-files.feature` |
| `GET /api/netops/ftp/ad/status` | 查詢同步狀態 | `ftp/ad-files.feature` |
| `POST /api/netops/ftp/ad/syncs` | 送出同步 | `ftp/ad-files.feature` |
| `POST /api/netops/ftp/ad/syncs` | 正在同步 | `ftp/ad-files.feature` |
| `POST /api/netops/ftp/ad/imports` | 重新匯入一天 | `ftp/ad-files.feature` |
| `POST /api/netops/ftp/ad/result-deletions` | 刪除一天 | `ftp/ad-files.feature` |
| `GET /api/netops/kb/notes` | 查詢筆記 | `kb/notes.feature` |
| `POST /api/netops/kb/notes` | 新增筆記 | `kb/notes.feature` |
| `POST /api/netops/kb/notes` | 內容空白 | `kb/notes.feature` |
| `GET /api/netops/kb/notes/{id}` | 取得筆記 | `kb/notes.feature` |
| `GET /api/netops/kb/notes/{id}` | 不存在 | `kb/notes.feature` |
| `PUT /api/netops/kb/notes/{id}` | 修改筆記 | `kb/notes.feature` |
| `DELETE /api/netops/kb/notes/{id}` | 刪除筆記 | `kb/notes.feature` |
| `GET /api/netops/kb/notes/{id}/markdown` | 下載筆記 | `kb/notes.feature` |
| `GET /api/netops/kb/compilation` | 下載匯整檔 | `kb/notes.feature` |
| `GET /api/netops/ftp/pa/files` | 瀏覽 TRAFFIC 目錄 | `ftp/pa-files.feature` |
| `GET /api/netops/ftp/pa/files` | 不列出系統資料夾 | `ftp/pa-files.feature` |
| `GET /api/netops/ftp/pa/files` | 超出根目錄 | `ftp/pa-files.feature` |
| `GET /api/netops/ftp/pa/status` | 查詢匯入進度 | `ftp/pa-files.feature` |
| `POST /api/netops/ftp/pa/syncs` | 送出同步 | `ftp/pa-files.feature` |
| `POST /api/netops/ftp/pa/analyses` | 分析選取的檔案 | `ftp/pa-files.feature` |
| `POST /api/netops/ftp/pa/analyses` | 沒有選擇檔案 | `ftp/pa-files.feature` |
| `DELETE /api/netops/ftp/pa/analyses` | 取消分析 | `ftp/pa-files.feature` |
| `POST /api/netops/ftp/pa/result-deletions` | 刪除分析結果 | `ftp/pa-files.feature` |

## 6. 與舊版不同(`@changed` 摘要)

| 項目 | 舊版 | 新版 | 原因 |
| --- | --- | --- | --- |
| 登入與權限 | 自簽 JWT、`.env` 名單(空白 = 全部在職員工)、`KB_ADMINS` | BFF 檢查 `x-permission`;新權限預設沒有人擁有 | AGENT.md §7.1;D15 |
| PA 明細查詢、AD FTP 清單 | 同步等待最長 180 / 120 秒 | 工作模式(202 → 輪詢 → 結果 / 匯出 / 取消),只有本人可查 | D6 |
| 明細查詢資源 | 每次查詢獨立 | 同時只跑 1 個、每人進行中 2 個、每人保留最近 5 次結果;取消已完成的工作會丟棄結果 | 資安審查(FTP 連線、記憶體) |
| IP 萬用字元 | 每個 `*` 轉成 `.*`,大量 `*` 卡死服務 | 只允許 IP 字元、`*` 最多 4 個、連續的合併 | 資安審查 High(ReDoS) |
| 知識庫標籤 | 標籤內含換行可偽造記錄人與建立時間 | 每個欄位壓成一行,API 拒絕換行 | 資安審查 High |
| FTP 同步、AD 匯入 | 等完成才回應 | 背景執行回 202,畫面輪詢狀態 | 路由逾時(BACKEND-GUIDE §5.2) |
| 分析 API | 信任畫面傳入的大小與時間 | 取 FTP 實際值,只接受 log 目錄下的 log 檔 | 資安審查(格式錯誤會讓程序結束) |
| 總覽期間 | 不限 | 最長 92 天;明細最長 31 天 | 路由逾時 |
| 資料不完整 | 讀不到摘要就略過 | `missing`、`import`、`stopReason`、`_不完整` 檔名、`NETOPS_DATA_CORRUPT` | AGENT.md §5 |
| 回應格式 | `{ status, data, message }`、本地時間字串 | 直接回資料、ISO 8601 含時區、分頁 | BACKEND-GUIDE §5.2 |
| 匯出 | 前端產生 CSV | 後端產生(UTF-8 BOM、公式字元加 `'`) | 一致的欄位與稽核 |
| 刪除筆記 | 不存在回 404 | 冪等 204 | BACKEND-GUIDE §5.1 |
| AI 問答、Veeam | 系統內功能、同步登入 | 一般連結到舊版 / Veeam,另行登入 | D11、D17、D18 |
| FTP 清單 | 列出 `$RECYCLE.BIN`、`System Volume Information`;任何目錄的 log 檔都能勾選 | 不列系統資料夾;只有 TRAFFIC 與各類型目錄可勾選 | D1 驗收 2026-11-05 |
| AD FTP 清單 | 開頁就列出 | 有管理權限的人按「列出 FTP 資料夾」才列出 | 需求方 2026-11-05 決定 |

## 7. 發現的不一致

| # | 位置 | 內容 | 建議 |
| --- | --- | --- | --- |
| 1 | API.md §1.1 ↔ `backend/src/modules/pa/log-routes.ts:95` | 文件寫「每人同時最多 2 個、全系統最多 6 個進行中的工作」。明細查詢用自己的工作佇列,與 AD 清單分開計算,所以一個人實際最多 2 個明細查詢 + 2 個 AD 清單,全系統各 6 個 | 修 API.md 的說法(依工作類型分開計算);程式不必改 |
| 2 | API.md §1.1 ↔ `backend/src/infra/jobs/index.ts:58` | 每人保留的已完成工作:明細查詢 5 筆(§4.3 有寫),AD 清單沿用預設 10 筆(文件沒寫) | 在 API.md §5.2 補上,或改成一致 |
| 3 | IMPL-PLAN F1「下載帶 CSRF」↔ FRONTEND-GUIDE §6 | Gateway 規定 CSRF 只用在 `POST` / `PUT` / `PATCH` / `DELETE`;新版的下載(匯出、`.md`、匯整檔)都是 `GET`,不需要 CSRF | IMPL-PLAN 改成「下載經 web-kit、不帶 Bearer」(docs MR 統一處理) |
| 4 | `x-gherkin`「沒有權限時拒絕」(ping)等 401 / 403 場景 | 由 BFF 回應,netops-api 的單元測試無法驗證 | 標 `@e2e`,在測試區驗(B0 已驗 ping) |
| 5 | F1 `frontend/src/config/links.ts:4`(origin/feature/netops-f1-pa-dashboard) | 舊版 NetOps 正式網址標 TODO,待使用者確認;AI 問答連結依賴它 | 使用者確認網址 |
| 6 | 匯出的 `/openapi.json` ↔ API.md §1.1、§4.3、§5.2、§7 | `DELETE /pa/log-searches/{id}`、`/ftp/ad/listings/{id}`、`/kb/notes/{id}` 實際回 204,但路由沒有宣告 204,OpenAPI 的 responses 只有預設的 200 | 另開 fix 分支在這三支路由的 response schema 加 204 |

## 8. `@pending-ui`(F1 進行中)

| 場景 | 檔案 | 待確認 |
| --- | --- | --- |
| 目前 Tab 沒有權限時改到同頁第一個可看的 Tab | `ui/navigation.feature` | guard 已實作並有測試;各頁還沒有 Tab |
| 編輯按鈕依按鈕權限顯示 | `ui/navigation.feature` | FTP Log 檔案、知識庫頁的按鈕權限 |
| 下載匯出檔與知識庫 .md | `ui/requests.feature` | 明細查詢、知識庫頁尚未改寫 |
| 明細查詢結果不完整時提示 | `ui/requests.feature` | 明細查詢頁尚未改寫 |
| 總覽沒有資料或不完整時提示 | `ui/requests.feature` | 總覽頁已改寫,提示是否齊全待逐頁核對 |
| 知識庫內容顯示前經 DOMPurify | `ui/requests.feature` | 知識庫頁尚未改寫 |
