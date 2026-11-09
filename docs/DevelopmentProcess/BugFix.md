# Bug 修改紀錄

> Bug 修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

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
