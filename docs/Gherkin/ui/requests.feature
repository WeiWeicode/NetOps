# language: zh-TW
@F1
功能: 前端呼叫 API、下載與工作輪詢
  為了讓畫面安全地呼叫 netops-api,並正確顯示長時間工作與不完整的資料
  身為 使用者
  我要寫入帶 CSRF、下載不帶 Bearer、工作會輪詢與取消、錯誤顯示 requestId

  # 依據:Gateway FRONTEND-GUIDE §6(CSRF:非 GET 帶 X-CSRF-Token,值為 gn_csrf Cookie)、§7;IMPL-PLAN F1;
  #       docs/API.md §1、§1.1;AGENT.md §7.1(前端不存 Token)、§7.4(DOMPurify);
  #       F1 程式(origin/feature/netops-f1-pa-dashboard:frontend/src/api/gateway.ts、api/jobs.ts、composables/useJob.ts)。

  Rule: 呼叫 API

    # 來源: frontend/src/api/gateway.ts:2(origin/feature/netops-f1-pa-dashboard)
    @untested
    場景: 寫入請求帶 CSRF
      當 畫面送出 POST / PUT / DELETE 到 /api/netops/*
      那麼 請求帶 X-CSRF-Token 標頭,值為 gn_csrf Cookie
      而且 一律經 web-kit,頁面不直接 fetch

    # 來源: frontend/src/api/gateway.ts:2(origin/feature/netops-f1-pa-dashboard)
    @manual @security @changed
    場景: 前端不存 Token
      # 舊版把自簽 JWT 存在 localStorage 並帶 Bearer;新版身分只在 BFF 的 httpOnly Cookie
      當 檢查 localStorage、sessionStorage 與請求標頭
      那麼 沒有任何 Token,也沒有 Authorization 標頭

  Rule: 下載

    # 來源: frontend/src/api/gateway.ts:2(origin/feature/netops-f1-pa-dashboard)
    @pending-ui @changed
    場景: 下載匯出檔與知識庫 .md
      # IMPL-PLAN F1「下載帶 CSRF、不再帶 Bearer」;F1 尚未實作下載(明細查詢、知識庫頁仍為 WipPage)
      當 使用者在明細查詢頁按「匯出 CSV」,或在知識庫頁按「下載 .md」「下載匯整 .md」
      那麼 以 GET /api/netops/.../export、/markdown、/compilation 取得檔案並下載
      而且 不帶 Authorization 標頭
      而且 檔名使用回應 Content-Disposition 的檔名

  Rule: 工作模式

    # 來源: frontend/src/composables/useJob.ts:3(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 送出工作後輪詢到結束
      當 畫面送出明細查詢或 AD 的 FTP 檔案清單
      那麼 每 1.5 秒查詢一次工作狀態,顯示進度
      而且 status 為 done、failed 或 cancelled 時停止查詢

    # 來源: frontend/src/composables/useJob.ts:48(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 離開頁面時取消尚未結束的工作
      假如 明細查詢還在執行
      當 使用者離開頁面
      那麼 前端送出 DELETE …/{id} 取消工作,不佔用每人 2 個的名額

    # 來源: frontend/src/api/jobs.ts:22(origin/feature/netops-f1-pa-dashboard)
    @untested
    場景大綱: 工作錯誤顯示說明
      當 工作查詢或建立回 code "<代碼>"
      那麼 畫面顯示「<說明>」並附 requestId

      例子:
        | 代碼                      | 說明                                         |
        | NETOPS_JOB_NOT_FOUND      | 工作已失效(逾期或服務重新啟動),請重新送出 |
        | NETOPS_JOB_LIMIT_EXCEEDED | 進行中的工作太多                             |
        | NETOPS_JOB_TIMEOUT        | 工作超過執行時間上限                         |

    # 來源: docs/API.md:§4.3
    @pending-ui
    場景: 明細查詢結果不完整時提示
      # 明細查詢頁尚未改寫(WipPage)
      假如 明細工作 stopReason 為 "timeout",或 filesScanned 小於 files
      那麼 結果上方標示「結果不完整」與原因

  Rule: 資料不完整與內容安全

    # 來源: docs/API.md:§4.1
    @pending-ui
    場景: 總覽沒有資料或不完整時提示
      假如 總覽回 files 為 0、missing 大於 0,或 import.busy 為 true
      那麼 畫面說明「沒有已分析的資料」或「資料可能不完整」,不顯示成流量為 0
      # AGENT.md §5:查無紀錄不等於沒有發生;F1 總覽頁已改寫,此提示是否齊全待逐頁核對

    # 來源: docs/API.md:§7
    @pending-ui @security
    場景: 知識庫內容顯示前經 DOMPurify
      # 知識庫頁尚未改寫(WipPage)
      假如 筆記內容含 <script> 或 onerror 屬性
      當 在知識庫頁顯示 Markdown
      那麼 經 DOMPurify 清除,不執行任何腳本
