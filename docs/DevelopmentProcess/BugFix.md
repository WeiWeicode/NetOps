# Bug 修改紀錄

> Bug 修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-13 V-b2 C7 重驗不通過:Top 10 來源 IP 帶成任一方 IP、Log 明細頁的未套用提示消失、時段明細逾時卡住

- 內容:
  - 抽屜點來源 / 目的 IP(Top 10 與明細表)原本帶 `ip=`(任一方),改為 `src=` / `dst=`(`SearchExtra.filterSrc` / `filterDst`)。
  - Log 明細查詢頁收到 `type=THREAT`、`threat`、`severity` 時的「未套用」提示原本跟著網址算,自動查詢 `router.replace` 改寫網址後提示馬上消失;改成進頁時算一次。Log 明細查詢(前端與後端 `POST /pa/log-searches`)只查 TRAFFIC,不支援威脅類與嚴重度,真正帶入要另開工作由需求方決定。
  - `useSlice` 第一個請求沒有用戶端逾時,網路逾時時抽屜停在「查詢時段明細中…」直到瀏覽器放棄;改成 45 秒中止 → `state = 'error'`(`SliceTimeoutError`),新增 `retryable`,換條件或關閉時中止舊請求。
- 檔案:`frontend/src/composables/useSlice.ts`、`frontend/src/api/slice.ts`、`frontend/src/components/SliceDrawer.vue`、`frontend/src/composables/searchQuery.ts`、`frontend/src/pages/firewall/Search.vue`
- 驗證:frontend `npm run typecheck`、`npm test`(見 MR)

## 2026-11-13 V-b2 第一輪驗收:熱力圖未彙總時段畫成 0、嚴重度篩選與跳 Log 條件(C1、C3–C5、C7–C9)
- 工作項目:V-a、V-b1(`docs/HANDOFF.md`「2026-11-13 V-b2 畫面驗收(第一輪)」;Gemini 畫面修正 U1–U10 commit `ba410a4` 一起進 MR)
- 內容:C1 熱力圖 11-13 00:00–08:30(彙總上線前)回 `v=0`、`gaps=[]`,違反「沒有資料不等於 0」:彙總表沒有該格一律 `v=null`,並把 `since` 之後的連續缺格列進 `coverage.gaps`(`reason: no-data`)。C3 威脅類時段明細總流量顯示 0 B:`useSlice.summary` 把威脅類的流量欄位轉成 `null`,抽屜顯示「不適用」。C4 嚴重度 chip 只做前端過濾:`useSlice.setSeverity()` 帶 `severity` 重查(後端早已支援)。C5 移除 AD 異常指標。C7 `openInSearch(extra?)` 帶點選的項目與威脅類條件。C8 mock 威脅明細補 `severity`、`name`。C9 `viz.mount.test.ts` 4 項舊規格改新規格。前後端細節見 `BackendCorrection.md`、`FrontendCorrection.md` 同日紀錄。
- 檔案:同上
- 驗證:見前後端紀錄

## 2026-11-13 冷歸檔 NAS 準備腳本:權限檢查誤報
- 工作項目:C4
- 內容:`deploy/host2-setup-pa-archive.sh` 的群組權限檢查 `case "$G" in "1000 d???r?x"*)` 把萬用字元 `?` 放在引號內,被當成字面字元,永遠比對不到,權限正確(群組 1000、`r-x`)也印 WARN(需求方 2026-11-13 在主機 2 執行時發現)。改成 `"1000 d"???r?x*`(引號外才是萬用字元)。只影響提示訊息:目錄、標記檔與寫入測試本來就正確,不需要重跑腳本。
- 檔案:`deploy/host2-setup-pa-archive.sh`
- 驗證:同一段比對在本機 sh 與主機 2 WSL(dash)執行:`1000 drwxr-x---`、`1000 drwxr-xr-x`、`1000 drwxrwx---` 通過;`0 drwxr-x---`、`1000 drwx------`、`1000 drwxr-----`、`10000 drwxr-x---` 警告;`sh -n` 語法檢查

## 2026-11-13 測試區部署從 V-a 起卡在 ClickHouse 建表(熱力圖表沒建立)
- 工作項目:V-a、C1(develop pipeline 884、889、890、910 失敗)
- 內容:`deploy/clickhouse/apply-schema.sh` 先跑 `schema.sql` 再跑 `migrations/`。V-a 在 `schema.sql` 的 `pa_traffic_hourly_src_mv` 加了 `bytes_sent`、`bytes_recv`,這兩欄要等 `migrations/003` 才會加到既有的 `pa_traffic_hourly_src`;ClickHouse 26.3 即使 MV 已存在,`CREATE MATERIALIZED VIEW IF NOT EXISTS` 也會先檢查輸出欄位,所以失敗(`THERE_IS_NO_COLUMN`),003 與後面的熱力圖表 / MV 都沒有建立。CI 的整合測試只從空資料庫建表,所以沒抓到。修正:`schema.sql` 在這個 MV 之前先 `ADD COLUMN IF NOT EXISTS`(和 003 相同,可重複執行),檔頭寫明規則;CI 加升級測試(V-a 前的 schema → `apply-schema.sh`)。修正內容見 `BackendCorrection.md` 同日紀錄。
- 檔案:同上

## 2026-11-10 即時監控排行切換與 log 暫停鈕沒有渲染等驗收問題
- 工作項目:R1(驗收報告 `docs/test-reports/2026-11-10-pa-live-uat.md` §4.1、§4.4、§7)
- 內容:`Live.vue` 對 `GCard` 用了不存在的 `#extra` 插槽(只有 `header` / `actions` / `footer`),排行的類型與 5 / 15 / 60 分鐘切換、即時 log 的暫停鈕都沒有渲染,Vue 不會報錯,原有單元測試只測純函式也沒抓到;改 `#actions`,並補掛載測試與全前端插槽名稱檢查(沒有找到其他用錯的地方)。另修:輪詢暫停時介面流量仍顯示最後一輪的值;URL 過濾 log 的「名稱」欄顯示 `9999(9999)`;串流重連遇 401 不會換發 Token。修正內容見 `FrontendCorrection.md` 同日紀錄。
- 檔案:同上

## 2026-11-09 即時監控驗收發現的顯示問題與每次部署的 `/v1/ping` 401
- 工作項目:R1(驗收報告 `docs/test-reports/2026-11-09-a1-r1-uat.md` §4.4、§4.5、§6-5、§7.4)
- 內容:頁首沒有輪詢 / 接收狀態;接收未啟用時排行與 log 說明誤導;沒有設備狀態最後更新時間;串流 429 只寫「中斷」且每 10 秒重試;路由未發佈只顯示 `ROUTE_NOT_FOUND` 的訊息;CI 冒煙測試每次部署留一筆 `/v1/ping` 401。修正內容見 `FrontendCorrection.md`、`BackendCorrection.md` 同日紀錄。
- 檔案:同上

## 2026-11-09 PA-560 介面計數查詢在 PAN-OS 12.1.7-h3 失敗
- 工作項目:R1(需求方在開發機 10.10.112.13 對實機跑 `python -m netops_pa check`,5 項中 1 項失敗)
- 內容:輪詢指令 `show counter interface all` 經 pan-os-python `cmd_xml` 轉成 `<show><counter><interface><all></all></interface></counter></show>`(沒加引號的字會變成元素),PAN-OS 要的是值,回「`show -> counter -> interface -> all needs to have non NULL value`」。改成 `show counter interface "all"`(轉成 `<interface>all</interface>`,與既有的 `second last "1"` 同寫法)。假 PA 原本只比對 `<counter><interface` 前綴所以沒抓到,改成照實機對錯誤寫法回同樣的錯誤,並補回歸測試;`check` 對這類 PAN-OS 指令錯誤(`non NULL value`)給「版本差異」提示。假 PA 的計數回應依 PAN-OS 文件格式補上 hw 區段的位元組計數(解析仍以 ifnet 為準),12.1 的實際回應格式待實機確認。規格 `docs/PA-FORWARDING-SPEC.md`:G2 填 10.10.115.35、G3 填 12.1.7-h3、G4 記錄出廠自簽憑證(SAN 只有序號);B.4 加註 12.1 Decryption 欄位分成 client / server 兩側、名稱待對照設備。
- 檔案:`pa-collector/netops_pa/poller.py`、`pa-collector/netops_pa/check.py`、`pa-collector/tests/fake_pa.py`、`pa-collector/tests/test_poller.py`、`pa-collector/tests/test_check.py`、`docs/PA-FORWARDING-SPEC.md`
- 驗證:`ruff check`、`pytest`(75 passed,新增 3 項);白名單暫時改回沒加引號的寫法時 5 項失敗(含 `check`),確認假 PA 能重現實機錯誤。code-reviewer:無必須修正,建議已採用

## 2026-11-05 D1 驗收發現的問題(FTP 目錄、系統資料夾、AD 自動掃描、空白錯誤)
- 工作項目:D1(驗收報告 `docs/test-reports/2026-11-05-d1-uat-pending.md`)
- 內容:測試區 `FTP_LOG_DIR` 未設定導致 TRAFFIC 無法分析(§3.1);FTP 清單列出系統資料夾(§4.1);AD FTP 頁一開就掃 FTP(§4.2);未登入導回時前端回報空白錯誤(§4.4);知識庫備份容器沒有 healthcheck(§5.4)。修正內容見 `BackendCorrection.md`、`FrontendCorrection.md` 同日紀錄。
- 檔案:同上
- 驗證:同上

## 2026-11-04 安全事件頁沒有分析資料時回 400
- 工作項目:D1(測試區驗收發現;netops-api 記了 5 筆 400)
- 內容:某類型 log 還沒有分析資料時,期間是空的。`rangeError` 在這個情況回空字串(畫面另有「尚無分析資料」的空狀態),`load()` 只看 `rangeError`,所以仍送出 `GET /api/netops/pa-events/overview?type=…&from=&to=`,後端 `from` 必填而回 400 `VALIDATION_FAILED`。後端行為正確(API.md §4.2、OpenAPI `from` 必填),改前端:期間檢查抽成 `composables/dates.ts` 的 `checkDayRange()`,訊息與「是否送出」用同一個結果,期間空白時不送出(同流量總覽、AD 事件總覽已有的判斷)。
- 檔案:`frontend/src/composables/dates.ts`、`frontend/src/pages/firewall/Events.vue`、`frontend/test/dates.test.ts`
- 驗證:`npm run typecheck`、`npm test`(12 檔 63 項通過,新增 4 項)、`npm run build`
