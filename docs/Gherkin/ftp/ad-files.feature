# language: zh-TW
@B2
功能: FTP Log 檔案 — AD
  為了把 DC 每天匯出到 FTP 的事件記錄匯入本系統
  身為 網通管理人員
  我要列出 FTP 上的日期資料夾與匯入狀態、同步、重新匯入或刪除匯入結果

  # 依據:docs/API.md §5.2;ARCHITECTURE D6、D14(簽章格式同舊版,複製舊資料後不重新匯入);AGENT.md §7.4。
  # 權限:讀取 netops.ftp.read、同步與管理 netops.ftp.write(401 / 403 見 api/skeleton.feature)。
  # 工作狀態轉換的共通規則見 api/jobs.feature。

  背景:
    假如 使用者 S112009 已登入且擁有 "netops.ftp.read"、"netops.ftp.write"
    而且 FTP /AD_Log_Backup 下有 20261101、20261102 兩個日期資料夾

  Rule: 日期資料夾清單(工作模式)

    # 來源: backend/src/modules/ftp/ad-routes.ts:41
    @auto @changed
    場景: 送出清單工作
      # 舊版 GET /ad/browse 同步等待最長 120 秒;新版工作模式(D6)
      當 呼叫 POST /api/netops/ftp/ad/listings
      那麼 回應 202
      而且 status 為 "queued" 或 "running"

    # 來源: backend/src/modules/ftp/ad-routes.ts:66
    @auto
    場景: 查詢自己的工作
      假如 使用者已送出清單工作
      當 呼叫 GET /api/netops/ftp/ad/listings/{id}
      那麼 回應 200
      而且 完成時 result 為 { dir, days },每天有 day("YYYY-MM-DD")、state、events、importedAt、files

    # 來源: backend/src/modules/ftp/ad-routes.ts:71
    @auto @security
    場景: 別人的工作
      當 另一位使用者呼叫 GET /api/netops/ftp/ad/listings/{id}
      那麼 回應 404 NETOPS_JOB_NOT_FOUND

    # 來源: backend/src/modules/ftp/ad-routes.ts:91
    @auto
    場景: 取消工作
      當 呼叫 DELETE /api/netops/ftp/ad/listings/{id}
      那麼 回應 204
      而且 再呼叫一次也回 204

    # 來源: backend/src/modules/ftp/ad-routes.ts:57
    @auto
    場景: id 不是 UUID
      當 呼叫 GET /api/netops/ftp/ad/listings/not-a-uuid
      那麼 回應 400,code 為 "VALIDATION_FAILED"

    # 來源: backend/src/modules/ad/importer.ts:139
    @auto @changed
    場景: 多人同時列清單時共用一次 FTP 列表
      # 避免重複送出工作佔滿 FTP 連線(資安審查 Medium)
      假如 兩位使用者同時送出清單工作
      那麼 只對 FTP 列一次目錄,兩個工作得到相同結果

    # 來源: backend/src/modules/ad/importer.ts:163
    @auto
    場景大綱: 日期資料夾的狀態
      假如 <情況>
      當 清單工作完成
      那麼 該日期的 state 為 "<狀態>"

      例子:
        | 情況                                       | 狀態    |
        | 這一天尚未匯入                             | new     |
        | 已匯入,FTP 上的檔名、大小、時間都沒變      | done    |
        | 已匯入,之後 FTP 上的檔案有變更             | changed |
        | 已匯入,FTP 上已沒有這個資料夾              | orphan  |
        | 由舊版複製過來的資料(同樣的簽章格式)      | done    |

  Rule: 同步、重新匯入與刪除(netops.ftp.write)

    # 來源: backend/src/modules/ftp/ad-routes.ts:110
    @auto
    場景: 查詢同步狀態
      當 呼叫 GET /api/netops/ftp/ad/status
      那麼 回應 200
      而且 回應含 running 與 lastSyncAt
      而且 lastResult.imported 的 day 為 "YYYY-MM-DD"

    # 來源: backend/src/modules/ftp/ad-routes.ts:127
    @auto @changed
    場景: 送出同步
      # 舊版同步等待完成才回應;新版背景執行回 202
      當 呼叫 POST /api/netops/ftp/ad/syncs
      那麼 回應 202
      而且 只有檔案有變更的日期重新匯入
      而且 匯入的事件與舊版 parseAdCsv + 去除重複 + 排序的結果相同(UTF-16 / UTF-8、跨行訊息、新舊檔名重複)

    # 來源: backend/src/modules/ftp/ad-routes.ts:131
    @auto
    場景: 正在同步
      假如 AD 正在同步
      當 呼叫 POST /api/netops/ftp/ad/syncs
      那麼 回應 409 NETOPS_AD_SYNC_BUSY

    # 來源: backend/src/modules/ftp/ad-routes.ts:25
    @auto @changed
    場景: 沒有設定 FTP 時不能同步
      假如 GW_ENV 為 "dev" 且沒有設定 FTP_HOST
      當 呼叫 POST /api/netops/ftp/ad/syncs
      那麼 回應 503,code 為 "NETOPS_FTP_NOT_CONFIGURED"

    # 來源: backend/src/modules/ftp/ad-routes.ts:154
    @auto
    場景: 重新匯入一天
      當 呼叫 POST /api/netops/ftp/ad/imports 帶 days ["2026-11-02"]
      那麼 回應 202
      而且 不比對檔案,一律重新匯入這一天

    # 來源: backend/src/modules/ftp/ad-routes.ts:174
    @auto
    場景: 刪除一天
      假如 2026-11-02 已匯入
      當 呼叫 POST /api/netops/ftp/ad/result-deletions 帶 days ["2026-11-02"]
      那麼 回應 200
      而且 deleted 為 1
      而且 FTP 上的檔案不變

    # 來源: backend/src/modules/ftp/ad-routes.ts:15
    @auto
    場景: 日期格式錯誤或超過 60 天
      當 呼叫 POST /api/netops/ftp/ad/result-deletions 帶 days ["2026/11/01"]
      那麼 回應 400,code 為 "VALIDATION_FAILED"
      當 呼叫 POST /api/netops/ftp/ad/imports 帶超過 60 個日期
      那麼 回應 400
