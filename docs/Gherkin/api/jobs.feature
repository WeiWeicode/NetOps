# language: zh-TW
@B1 @changed
功能: 長時間工作(送出工作 → 查詢結果)
  為了讓超過路由逾時的操作不累積 BFF 斷路器失敗
  身為 使用者
  我要送出工作後輪詢狀態,完成後取得結果,而且只有自己看得到自己的工作

  # 依據:ARCHITECTURE D6、D9;AGENT.md §7.3;docs/API.md §1.1。
  # 舊版明細查詢與 AD 檔案清單同步等待(最長 180 / 120 秒),新版改成工作模式(@changed)。
  # 使用工作模式的 API:PA Log 明細(pa-log-searches/search.feature)、AD 的 FTP 檔案清單(ftp/ad-files.feature)。

  Rule: 狀態轉換 queued → running → done / failed / cancelled

    # 來源: backend/src/infra/jobs/index.ts:186
    @auto
    場景: 排隊的工作在前一個結束後自動開始
      假如 同時執行上限為 1,已有一個工作在執行
      當 送出第二個工作
      那麼 第二個工作的 status 為 "queued"
      當 第一個工作完成
      那麼 第二個工作的 status 依序變成 "running"、"done"

    # 來源: backend/src/infra/jobs/index.ts:219
    @auto
    場景: 完成的工作帶回結果
      當 工作順利結束
      那麼 status 為 "done",finishedAt 為 ISO 8601 時間,result 有內容
      而且 progress 保留最後一次回報的進度

    # 來源: backend/src/infra/jobs/index.ts:127
    @auto
    場景: 取消排隊中與執行中的工作
      當 取消 status 為 "queued" 或 "running" 的工作
      那麼 status 立即變成 "cancelled"
      而且 執行中的工作收到中止訊號,停止 FTP 掃描
      而且 再取消一次狀態不變

    # 來源: backend/src/infra/jobs/index.ts:203
    @auto
    場景: 超過執行時間上限的工作失敗
      當 工作執行超過上限
      那麼 status 為 "failed",error.code 為 "NETOPS_JOB_TIMEOUT"

    # 來源: backend/src/infra/jobs/index.ts:63
    @auto @security
    場景: 非預期錯誤不回傳內部細節
      當 工作因非預期錯誤失敗(例如本機檔案錯誤)
      那麼 status 為 "failed",error 為 { code: "NETOPS_JOB_FAILED", message: "工作執行失敗" }
      而且 細節只寫入服務日誌
      但是 已知錯誤(例如 FTP 連線失敗 "NETOPS_FTP_UNAVAILABLE")照實回報

    # 來源: backend/src/infra/jobs/index.ts:152
    @auto
    場景: 服務關閉時中止全部工作
      當 服務關閉
      那麼 排隊與執行中的工作 status 為 "failed",error.code 為 "NETOPS_JOB_ABORTED"
      而且 不再接受新工作(503 "NETOPS_JOB_ABORTED")

  Rule: 只有建立者本人可查(比對工號)

    # 來源: backend/src/infra/jobs/index.ts:166
    @auto @security
    場景: 別人的工作與不存在的工作一律 404
      假如 S112009 送出了一個工作
      當 S094009 查詢、取結果或匯出這個工作
      那麼 回應 404,code 為 "NETOPS_JOB_NOT_FOUND"
      而且 不透露工作是否存在

    # 來源: backend/src/infra/jobs/index.ts:166
    @auto
    場景: 服務重新啟動後工作失效
      假如 工作只存在記憶體(單一容器,D9)
      當 服務重新啟動後查詢原來的工作 id
      那麼 回應 404,code 為 "NETOPS_JOB_NOT_FOUND",訊息請使用者重新送出

    # 來源: backend/src/infra/jobs/index.ts:85
    @auto
    場景: 沒有工號也沒有 sub 時不能建立工作
      當 身分沒有工號與 sub 的呼叫端送出工作
      那麼 回應 403,code 為 "NETOPS_JOB_OWNER_UNKNOWN"

  Rule: 數量與保留上限

    # 來源: backend/src/infra/jobs/index.ts:90
    @auto
    場景: 每人同時最多 2 個進行中的工作
      假如 使用者已有 2 個 queued 或 running 的工作
      當 再送出一個
      那麼 回應 409,code 為 "NETOPS_JOB_LIMIT_EXCEEDED"

    # 來源: backend/src/infra/jobs/index.ts:91
    @auto
    場景: 全系統進行中的工作有上限
      假如 全系統已有 6 個進行中的工作
      當 任何人再送出一個
      那麼 回應 409,code 為 "NETOPS_JOB_LIMIT_EXCEEDED"

    # 來源: backend/src/infra/jobs/index.ts:139
    @auto @security
    場景: 取消後要等工作真正停止才釋放名額
      假如 使用者取消了一個還在執行的工作
      當 工作尚未停止就再送出新工作
      那麼 仍以 2 個名額計算,不能藉由「送出 → 取消」累積背景工作

    # 來源: backend/src/infra/jobs/index.ts:237
    @auto
    場景: 完成後保留 30 分鐘
      當 工作完成超過 30 分鐘後查詢
      那麼 回應 404,code 為 "NETOPS_JOB_NOT_FOUND"

    # 來源: backend/src/infra/jobs/index.ts:94
    @auto @security
    場景: 每人保留的結果有上限,只丟自己最舊的
      假如 使用者已保留上限筆數的已完成工作
      當 再送出一個工作
      那麼 先丟掉這位使用者自己最舊的已完成工作
      而且 其他人的結果不受影響
