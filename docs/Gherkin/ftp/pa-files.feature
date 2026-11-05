# language: zh-TW
@B2
功能: FTP Log 檔案 — PA(TRAFFIC 與其他類型 log)
  為了把 PA-560 匯出到 FTP 的 log 分析成摘要
  身為 網通管理人員
  我要瀏覽 FTP 目錄與分析狀態、同步新檔、分析或刪除分析結果,而且 FTP 上的檔案不被改動

  # 依據:docs/API.md §5.1;AGENT.md §7.4(FTP 唯讀)、§6(FTP 同時連線 test 1、prod 2);ARCHITECTURE D8、D9。
  # 權限:讀取 netops.ftp.read、同步與管理 netops.ftp.write(401 / 403 見 api/skeleton.feature)。

  背景:
    假如 使用者已登入且擁有 "netops.ftp.read"、"netops.ftp.write"
    而且 FTP 根目錄下有 TRAFFIC log,/threat 下有威脅 log

  Rule: 瀏覽與狀態(netops.ftp.read)

    # 來源: backend/src/modules/ftp/routes.ts:36
    @auto
    場景: 瀏覽 TRAFFIC 目錄
      當 呼叫 GET /api/netops/ftp/pa/files
      那麼 回應 200
      而且 items 每筆有 state
      而且 資料夾排在前面,已分析的檔案有 rows、day("YYYY-MM-DD")、timeMin / timeMax(ISO 8601 +08:00)
      而且 回應含 root、logDir、pattern 與各類型的 eventDirs,不含本機資料目錄路徑或摘要檔名

    # 來源: backend/src/modules/ftp/routes.ts:26
    @auto
    場景: 瀏覽其他類型目錄
      當 呼叫 GET /api/netops/ftp/pa/files?path=/threat
      那麼 回應 200,type 為 "threat"

    # 來源: backend/src/modules/ftp/routes.ts:41
    @auto @changed
    場景: 不列出系統資料夾
      # 舊版與 D1 測試區都列出 FTP 主機磁碟根目錄的 Windows 系統資料夾(D1 驗收 2026-11-05 §4.1);AD 的清單同樣過濾
      假如 FTP 根目錄有 $RECYCLE.BIN 與 System Volume Information
      當 呼叫 GET /api/netops/ftp/pa/files?path=/
      那麼 回應 200
      而且 items 不含這兩個資料夾

    # 來源: backend/src/modules/ftp/routes.ts:47
    @auto @security
    場景: 超出根目錄
      假如 FTP_ROOT 為 /my-data
      當 呼叫 GET /api/netops/ftp/pa/files?path=/etc
      那麼 回應 403,code 為 "NETOPS_FTP_PATH_FORBIDDEN"
      而且 "/my-data/../etc" 這類路徑也一樣被拒絕

    # 來源: backend/src/infra/ftp/index.ts:168
    @auto @security
    場景: 路徑含控制字元
      當 呼叫 GET /api/netops/ftp/pa/files?path=/a%0D%0ADELE%20x
      那麼 回應 400,code 為 "VALIDATION_FAILED"

    # 來源: backend/src/infra/ftp/index.ts:95
    @auto @changed
    場景: FTP 連線都在使用中
      # 測試區只有 1 條 FTP 連線;畫面瀏覽優先拿連線,最多等 25 秒,不讓請求超過路由逾時
      假如 匯入與明細查詢佔用全部 FTP 連線超過 25 秒
      當 呼叫 GET /api/netops/ftp/pa/files
      那麼 回應 503,code 為 "NETOPS_FTP_BUSY"

    # 來源: backend/src/infra/ftp/index.ts:188
    @untested
    場景: FTP 連不上
      假如 FTP 主機無法連線或帳密錯誤
      當 呼叫 GET /api/netops/ftp/pa/files
      那麼 回應 502,code 為 "NETOPS_FTP_UNAVAILABLE",訊息含 FTP 回應、不含帳密

    # 來源: backend/src/infra/ftp/index.ts:159
    @auto
    場景: 開發環境沒有設定 FTP
      假如 GW_ENV 為 "dev" 且沒有設定 FTP_HOST
      當 呼叫 GET /api/netops/ftp/pa/files
      那麼 回應 503,code 為 "NETOPS_FTP_NOT_CONFIGURED"

    # 來源: backend/src/modules/ftp/routes.ts:73
    @auto
    場景: 查詢匯入進度
      當 呼叫 GET /api/netops/ftp/pa/status
      那麼 回應 200
      而且 回應含 traffic 與 events,各有 busy、total、done、failed、queued、syncing、lastSyncAt、lastSyncError、running

  Rule: 同步與分析(netops.ftp.write)

    # 來源: backend/src/modules/ftp/routes.ts:90
    @auto @changed
    場景: 送出同步
      # 舊版同步等列完目錄才回應;新版背景執行回 202
      假如 使用者擁有 netops.ftp.write
      當 呼叫 POST /api/netops/ftp/pa/syncs
      那麼 回應 202
      而且 之後 GET /api/netops/ftp/pa/status 的 lastSyncAt 會更新
      而且 只有新的、已變更與上次失敗的檔案加入分析,已分析的不重複分析

    # 來源: backend/src/modules/ftp/routes.ts:117
    @auto
    場景: 分析選取的檔案
      當 呼叫 POST /api/netops/ftp/pa/analyses 帶 1 個檔案
      那麼 回應 200
      而且 added 為 1
      而且 分析完成後存下的摘要、連線組合統計與舊版 server/lib 對同一個檔案的結果完全一致

    # 來源: backend/src/modules/ftp/routes.ts:122
    @auto
    場景: 沒有選擇檔案
      當 呼叫 POST /api/netops/ftp/pa/analyses 帶空的 items
      那麼 回應 400 VALIDATION_FAILED

    # 來源: backend/src/modules/ftp/routes.ts:146
    @auto @security @changed
    場景: 只分析 log 目錄下的 log 檔,大小與時間以 FTP 為準
      # 舊版信任畫面傳入的 size / modified(modified 格式錯誤會讓程序結束);新版改取 FTP 實際值(資安審查 High)
      當 呼叫 POST /api/netops/ftp/pa/analyses 帶 FTP 上不存在的檔案、非 log 檔、其他資料夾的檔案,以及 modified 為 "garbage" 的 log 檔
      那麼 回應 200,只有 log 檔加入分析,其餘算在 skipped
      而且 存下的大小與修改時間是 FTP 上的實際值

    # 來源: frontend/src/composables/ftpFiles.ts:87(fix/d1-uat-findings)
    @auto @changed
    場景: 不能分析的目錄不顯示勾選框
      # 後端只分析 TRAFFIC 目錄直屬與各類型目錄的檔案;D1 測試區 /my-data 可以勾選卻一定被略過(D1 驗收 2026-11-05 §3.1)
      假如 使用者有 "netops.pa-files.manage",FTP_LOG_DIR 為 /my-data
      當 在「FTP Log 檔案」瀏覽 /my-data 或 /threat
      那麼 log 檔可以勾選、分析
      當 瀏覽 FTP 根目錄或 /my-data/old 等其他目錄
      那麼 不顯示勾選框與分析按鈕,改顯示「這個目錄的檔案只能瀏覽,不能分析」與 TRAFFIC 目錄

    # 來源: backend/src/modules/pa/importer.ts:56
    @untested @changed
    場景: 分析佇列已滿
      假如 TRAFFIC 或其他類型 log 的佇列中已有 5,000 個檔案(兩種佇列各自計算)
      當 再分析更多檔案
      那麼 回應 409,code 為 "NETOPS_IMPORT_QUEUE_FULL"

    # 來源: backend/src/modules/pa/importer.ts:81
    @auto @changed
    場景: 傳輸不完整或檔案格式錯誤時標成失敗
      # 舊版讀取失敗時不中斷 FTP 傳輸;新版立即中斷並釋放連線
      當 分析的檔案傳輸中斷,或第一列不是 PA 匯出的欄位名稱
      那麼 該檔案 state 為 "error",error 說明原因
      而且 FTP 傳輸被中斷、連線釋放,後面的檔案照常分析
      而且 寫檔失敗時 error 不含本機資料目錄路徑

    # 來源: backend/src/modules/ftp/routes.ts:177
    @auto
    場景: 取消分析
      假如 佇列中有 3 個檔案
      當 呼叫 DELETE /api/netops/ftp/pa/analyses
      那麼 回應 200
      而且 cancelled 為 3
      而且 再呼叫一次 cancelled 為 0

    # 來源: backend/src/modules/ftp/routes.ts:193
    @auto
    場景: 刪除分析結果
      假如 檔案已分析
      當 呼叫 POST /api/netops/ftp/pa/result-deletions 帶該檔案路徑
      那麼 回應 200
      而且 deleted 為 1
      而且 FTP 上的檔案不變
      而且 該檔案 state 回到 "new"
