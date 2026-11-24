# 2026-11-24 審查:Gemini 的 AD-2 / AD-3 修正、AD-3 前端(!189)、AD-6(!191)

- 審查者:Claude(主串自審 AD-2、AD-3 修正;前端與 AD-6 由 `code-reviewer` 子代理逐檔審查,主串抽查確認關鍵發現)。
- 方式:唯讀 `git diff` / `git show`,未執行測試;測試數字取自 Gemini 回報與 CI(MR pipeline 全部 success)。
- 實作者:Gemini(需求方 2026-11-24 指派)。

## 總結

| MR | 範圍 | 結論 |
| --- | --- | --- |
| !186 | AD-2 審查修正(`6c9914f` ~ `3d0a8cb`) | **通過**(無阻擋項) |
| !187 | AD-3 審查修正(`1584d1e` ~ `87c63de`) | **通過**(無阻擋項) |
| !189 | AD-3 前端 | **有條件通過**:修 M1、M2 |
| !191 | AD-6 擴充事件 | **有條件通過**:修 M1、M2、M5;M3、M4 由需求方決定 |

## !186 AD-2 修正

- M1(`Install-NetOpsAdAgent.ps1`):升級改用 CIM `Win32_Service.Change`,檢查 `ReturnValue`,服務名稱有格式檢查。正確。**實機升級尚未驗證**,在測試 VM(RUNBOOK §7.1)裝兩次確認。
- M2(`winlog.rs`、`agent.rs`):`newest` 改用反向 `EvtQuery` 讀最新一筆;`newest < 水位` 時再確認一次才換世代。Log 被清空時回 `Some(0)` 仍會換世代,行為正確。
- M3(`agent.rs`):整批被過濾、且讀滿或還沒追上最新時立即接續讀。只在「有推進水位」時才立即接續,不會空轉。
- 觀察(Low,既有行為):解析失敗的事件不會推進 `through`;若它剛好是最新一筆,在新事件進來前每輪都會重讀並重複計入 `skippedEvents`。不影響資料,建議之後讓 `skippedEvents` 不重複計數。

## !187 AD-3 修正

- M1:`ridBounds` / 迴圈取代展開運算子。正確。
- M2:`createChAdSource` 用 `dcKey()`、`adWhere` 用 `upper(splitByChar('.', computer)[1])` 與 `lower(ad_domain)`,條件仍參數化。正確。
  - 觀察(Low):對欄位套函式會讓 `computer` 無法用排序鍵縮小範圍(仍有時間分區)。寫入端已正規化(Agent 大寫短名、FTP 補寫正規化),之後可改回 `computer = {大寫短名}` 直接比對。
- L1、L2、L3:正確。L2 以 `hours` 的日期計天數,`hour` 為 +08:00,日期切片正確。

## !189 AD-3 前端

**Medium(合併前修)**

1. `frontend/src/composables/adReconcile.ts` 約 108–112、140–143 行:`load()` 對每天最近一次補漏工作呼叫 `pollJob`;工作已是 `done` 時 `pollJob` 會自動 `runDay(day)` → `POST /ad/reconciliations`。**每次進頁面都對每個有已完成補漏的日子打一次寫入 API**(有稽核紀錄);沒有 `netops.ftp.write` 的人會 403,且被 `.catch(() => undefined)` 吞掉(違反 AGENT.md §5)。
   - 改法:只有本頁觀察到 `queued` / `running` → `done` 的工作才自動重新對帳;載入時已完成的只顯示結果。重新對帳失敗要顯示在該日。
2. `frontend/test/ad3.mount.test.ts` 匯出 422 段只斷言 `toast.fromError` 被呼叫,沒驗證錯誤碼 `NETOPS_EXPORT_TOO_LARGE` 與顯示文字;409 三種錯誤碼一併檢查斷言是否有驗證內容。

**Low**

1. `adReconcile.ts` 約 198–201 行:頁面恢復可見時 `day` 可能是 `''`,完成後會 `runDay('')`;補漏輪詢沒有進行中旗標,恢復時可能重疊請求(可比照 `useAdAgents` 的 `seq`)。
2. `pages/ad/Events.vue` 約 295–298 行:503 時 `GAlert` 與 `GEmpty` 同時出現,訊息重複。
3. `ui/components/GSourceBadge.vue:34`:每個徽章 `role="status"`,表格 50 列就有 50 個 live region;`ui/charts/viz-types.ts:136` 的 `GSourceBadgeProps` 型別未同步;FTP 補寫借用冷資料樣式。
4. `pages/ad/Search.vue`:網址帶入的 `computer` 不在下拉選項時顯示空白,應把目前值補進選項。
5. `composables/adEvents.ts` `isClickHouseUnavailable`:改為檢查 `code === 'NETOPS_CLICKHOUSE_UNAVAILABLE'`,不要只看 503。
6. 測試報告有「下午交由 Claude 審查」等暫時字句,合併前刪除。

**確認無問題**:欄位 / 路徑 / 錯誤碼與後端一致;錯誤不顯示成空資料且附 requestId;ftp 來源不顯示 DC 狀態列;`lastError`、`detail` 無 `v-html`(有 XSS 測試);agents 輪詢隱藏停止、離開清除;`GSourceBadge` 對 PA 頁面無影響;mock 只在 dev server,不進正式版。

## !191 AD-6

**結論**:`filter.rs` 符合 §9(27 種無條件 ID 不多不少;4616、4624、4768、4769、4662、5136 條件正確,`0x00000017` 與十進位都能解析);三個開關 `#[serde(default)]` 預設 false,舊設定檔可讀;`--check-config` 不印 Token;FTP 對帳仍只算 23 種(單元與整合測試都有);`ACCOUNT_CHANGES` 與 MV、`ad-receiver.test.ts:486` 守門一致,migration 未動。

**Medium**

1. **前端事件名稱沒補**(§9.5 第 2 點):`frontend/src/pages/ad/Search.vue:32` 的 `evName` 只認 `Security`,System / Directory_Service / DNS_Server 的新名稱在明細查詢不顯示。改用後端新回的 `channelEvents`(`api/ad.ts` 型別一併補)。這會改 `frontend/`,要和 !189 錯開:**在 !189 修完後,從 `feature/ad-3-frontend` merge 進 AD-6 再改**,或留給 !189 一起改。
2. `backend/src/modules/ad/routes.ts` 約 157–158 行:`GET /v1/ad/days` 新增 `channelEvents`,OpenAPI 描述與 `x-gherkin` 沒更新。
3. **`is_issue` 範圍擴大**(規格沒要求):`adlog.js` `SECURITY_ISSUE_IDS` 把 4723(自行改密碼)、4742(電腦帳號變更,每台電腦約 30 天一筆)、4735 / 4737 / 4755(群組屬性變更)、4730 / 4734 / 4758(群組刪除)等營運事件也標成「需要注意」,`is_issue` 寫進 ClickHouse,`issue_events` 會膨脹。**由需求方決定**;建議只保留高風險 ID。
4. **既有事件的解析結果改變**(規格外):4768 成功時 `reason` 由 `0x0` 變空;帳號異動事件的 `target` 改為優先取「目標帳戶名稱」;4624 `reason` 改為「登入類型 N」。都合理,但屬既有資料語意變更。**由需求方決定是否接受**;接受的話要列進測試報告,並補 4768 成功、4624 的比對案例。
5. `deploy/RUNBOOK-ad.md` §9.3:Security Log 上限寫 `4194304` KB 與 `wevtutil sl Security /ms:4294967296`,GPO 上限是 **4194240 KB**(64 KB 倍數),位元組要對應改成 `4293918720`;請 IT 在 DC 確認。

**測試放寬(`backend/test/unit/ad.test.ts` B2)**:原本逐字比對新舊 `adlog.js`,AD-6 本來就要擴充該檔,改成比對是合理的,且「舊版與新版結果完全一致」「總覽 = 舊版」「明細 = 舊版」三組行為比對都保留。但新斷言只比「鍵存在」,沒比值(例如 4723 名稱已改仍會過)。**條件**:加上「舊 `SECURITY_EVENTS`、`ACCOUNT_CHANGES` 的值逐一相等,只允許明列的例外」。

**Low**

1. RUNBOOK §9.1 子類別表正確,但沒列已在收的 4776(Credential Validation)、4704(Authorization Policy Change)。
2. `adlog.js` `toEvent` 的 ID 條件沒限 `channel === 'Security'`,其他通道同號事件也會走 Security 解析。
3. `adlog.js` `field()` 用短標籤(`DN`、`值`、`Class`、`類別`)組 regex,可能誤配;補一筆真實英文與中文 5136 全文測試。
4. `filter.rs` 測試補 `"0x00000017"`、4662 大寫 GUID 與 `%{...}` 格式的案例(實作已能處理)。
5. `is_weak_tgs_4769` 另外排除 `krbtgt/<REALM>`,合理,寫進測試報告。

## 合併順序

!184 → !186 → !187 → !189 → !191(!190 計畫書可先合併)。!184 合併前仍需需求方照 `RUNBOOK-ad.md` §2 做主機設定、主串唯讀確認資料表。
