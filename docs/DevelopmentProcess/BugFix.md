# Bug 修改紀錄

> Bug 修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

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
