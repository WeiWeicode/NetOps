# Bug 修改紀錄

> Bug 修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-04 安全事件頁沒有分析資料時回 400
- 工作項目:D1(測試區驗收發現;netops-api 記了 5 筆 400)
- 內容:某類型 log 還沒有分析資料時,期間是空的。`rangeError` 在這個情況回空字串(畫面另有「尚無分析資料」的空狀態),`load()` 只看 `rangeError`,所以仍送出 `GET /api/netops/pa-events/overview?type=…&from=&to=`,後端 `from` 必填而回 400 `VALIDATION_FAILED`。後端行為正確(API.md §4.2、OpenAPI `from` 必填),改前端:期間檢查抽成 `composables/dates.ts` 的 `checkDayRange()`,訊息與「是否送出」用同一個結果,期間空白時不送出(同流量總覽、AD 事件總覽已有的判斷)。
- 檔案:`frontend/src/composables/dates.ts`、`frontend/src/pages/firewall/Events.vue`、`frontend/test/dates.test.ts`
- 驗證:`npm run typecheck`、`npm test`(12 檔 63 項通過,新增 4 項)、`npm run build`
