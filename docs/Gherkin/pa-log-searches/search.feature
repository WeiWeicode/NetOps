# language: zh-TW
@B2 @changed
功能: PA Log 明細查詢與匯出(工作模式)
  為了查證特定 IP、Port、App 的連線紀錄
  身為 網通管理人員
  我要依時間與條件從 FTP 上的原始 log 篩選明細,完成後分頁查看或匯出 CSV

  # 依據:docs/API.md §4.3;ARCHITECTURE D6(舊版 POST /palog/search 同步等待最長 180 秒,改成工作模式);
  #       核心 scan.js 只改成注入 openStream,篩選沿用 palog.js 的 buildFilter / buildPrefilter。
  # 權限:netops.pa-log.read(401 / 403 見 api/skeleton.feature);查詢、結果、匯出 x-audit-level: meta。
  # 狀態轉換的共通規則見 api/jobs.feature。

  背景:
    假如 使用者 S112009 已登入且擁有 "netops.pa-log.read"
    而且 2026-11-01、2026-11-02 有已分析的 TRAFFIC 檔案

  Rule: 送出與狀態

    # 來源: backend/src/modules/pa/log-routes.ts:201
    @auto
    場景: 送出明細查詢
      假如 2026-11-02 08:00–09:00 有已分析的 TRAFFIC 檔案
      當 呼叫 POST /api/netops/pa/log-searches 帶 from、to 與 src
      那麼 回應 202,status 為 "queued" 或 "running"
      而且 之後 GET /api/netops/pa/log-searches/{id} 的 status 會變成 "done"
      而且 result 為 { from, to, total, limit, files, filesScanned, scanned, seconds, stopReason },不含資料列

    # 來源: backend/src/modules/pa/log-routes.ts:207
    @auto
    場景: 期間沒有資料
      當 呼叫 POST /api/netops/pa/log-searches 的期間沒有已分析的檔案
      那麼 回應 404,code 為 "NETOPS_PA_NO_DATA"

    # 來源: backend/src/modules/pa/log-routes.ts:341
    @auto
    場景: 查詢自己的工作
      假如 S112009 已送出明細查詢
      當 呼叫 GET /api/netops/pa/log-searches/{id}
      那麼 回應 200
      而且 執行中時 progress 為 { filesScanned, files, rows, found }

    # 來源: backend/src/modules/pa/log-routes.ts:341
    @auto @security
    場景: 別人的工作
      假如 S112009 已送出明細查詢
      當 S999999 以同一個 id 呼叫 GET、/rows 或 /export
      那麼 回應 404,code 為 "NETOPS_JOB_NOT_FOUND"

    # 來源: backend/src/modules/pa/log-routes.ts:122
    @auto
    場景大綱: 條件與舊版相同
      當 送出 <條件> 的明細查詢並等到完成
      那麼 依時間排序的結果列,與舊版 scanFiles + buildFilter 對同一批 log 的結果相同

      例子:
        | 條件                                     |
        | src 為 "10.10.1.*"(萬用字元)            |
        | ip 為 "10.10.0.0/16"、action 為 "block"  |
        | port 為 "443,53"、app 為 "ssl"           |
        | q 為 "dropbox"、limit 為 50              |
        | rule 為 "Internal \"Core\""(含引號)     |

    # 來源: backend/src/modules/pa/log-routes.ts:194
    @auto
    場景: 找到上限筆數就停止
      當 送出 limit 為 50 的明細查詢,符合的列超過 50
      那麼 status 為 "done",result.total 為 50,stopReason 為 "limit"

  Rule: 取得結果

    # 來源: backend/src/modules/pa/log-routes.ts:359
    @auto
    場景: 取第一頁
      假如 明細工作已完成
      當 呼叫 GET /api/netops/pa/log-searches/{id}/rows?page=1&pageSize=50
      那麼 回應 200
      而且 回應含 items、total、page、pageSize
      而且 每筆 items 是欄位物件(順序同舊版 ROW_FIELDS),time 為 ISO 8601 +08:00

    # 來源: backend/src/modules/pa/log-routes.ts:384
    @auto
    場景: 匯出 CSV
      假如 明細工作已完成
      當 呼叫 GET /api/netops/pa/log-searches/{id}/export
      那麼 回應 200
      而且 Content-Type 為 text/csv
      而且 內容以 UTF-8 BOM 開頭,第一列為中文欄名(時間、類型、動作、來源 IP…)
      而且 檔名為 "PA_log_{開始}_{結束}.csv"

    # 來源: backend/src/modules/pa/log-routes.ts:394
    @auto @changed
    場景: 結果不完整時匯出檔名標出來
      # AGENT.md §5:資料不完整要明確標示
      假如 明細工作因超過掃描秒數停止,stopReason 為 "timeout"
      當 匯出 CSV
      那麼 檔名結尾為 "_不完整.csv"

    # 來源: backend/src/infra/jobs/index.ts:147
    @auto
    場景: 工作尚未完成或已取消時沒有結果
      假如 明細工作 status 為 "running"、"failed" 或 "cancelled"
      當 呼叫 GET /api/netops/pa/log-searches/{id}/rows
      那麼 回應 409,code 為 "NETOPS_JOB_NOT_DONE"

  Rule: 取消

    # 來源: backend/src/modules/pa/log-routes.ts:411
    @auto
    場景: 取消工作
      當 呼叫 DELETE /api/netops/pa/log-searches/{id}
      那麼 回應 204
      而且 再呼叫一次也回 204

    # 來源: backend/src/modules/pa/log-routes.ts:274
    @auto
    場景: 執行中取消會中斷 FTP 掃描並釋放連線
      假如 明細工作 status 為 "running"
      當 呼叫 DELETE /api/netops/pa/log-searches/{id}
      那麼 status 變成 "cancelled"
      而且 FTP 傳輸被中斷,之後的匯入與查詢能拿到 FTP 連線

    # 來源: backend/src/modules/pa/log-routes.ts:417
    @auto @changed
    場景: 取消已完成的工作會丟棄結果
      # 結果最多 PA_SEARCH_LIMIT 筆 × 28 欄,取消即釋放記憶體(資安審查建議)
      假如 明細工作已完成
      當 呼叫 DELETE /api/netops/pa/log-searches/{id}
      那麼 回應 204
      而且 之後查詢這個 id 回 404 "NETOPS_JOB_NOT_FOUND"

    # 來源: backend/src/modules/pa/log-routes.ts:417
    @auto @security
    場景: 別人取消不影響我的工作
      假如 S112009 的明細工作已完成
      當 S999999 呼叫 DELETE /api/netops/pa/log-searches/{id}
      那麼 回應 204
      而且 S112009 查詢時 status 仍為 "done"

  Rule: 輸入驗證與上限

    # 來源: backend/src/modules/pa/log-routes.ts:253
    @auto
    場景大綱: 輸入錯誤回 400
      當 呼叫 POST /api/netops/pa/log-searches 帶 <內容>
      那麼 回應 400,code 為 "VALIDATION_FAILED"

      例子:
        | 內容                                         |
        | 期間超過 31 天                               |
        | 時間沒有時區(2026-11-01T00:00)              |
        | to 早於 from                                 |
        | port 為 "443;rm"                             |
        | limit 超過 PA_SEARCH_LIMIT                   |

    # 來源: backend/src/modules/pa/log-routes.ts:98
    @auto @security @changed
    場景: IP 萬用字元過多會被拒絕
      # 資安審查 High(ReDoS):核心 ipMatcher 把每個 * 轉成 .*,大量 * 會讓比對時間指數成長、卡住整個服務;
      # 舊版同樣有此問題,核心依 D4 不改,在路由擋
      當 呼叫 POST /api/netops/pa/log-searches 帶 src 為 "**********x" 或 ip 為 "1*2*3*4*5*6"
      那麼 回應 400,code 為 "VALIDATION_FAILED"
      而且 IP 條件只能用 IP / CIDR 字元,"*" 最多 4 個

    # 來源: backend/src/modules/pa/log-routes.ts:100
    @auto @changed
    場景: 連續的萬用字元視為一個
      當 分別送出 src 為 "10.10.*.5" 與 "10.10.***.5" 的明細查詢
      那麼 兩者的結果筆數相同

    # 來源: backend/src/infra/jobs/index.ts:90
    @auto
    場景: 每人同時最多 2 個明細查詢
      假如 S777777 已有 2 個進行中的明細查詢
      當 再送出一個
      那麼 回應 409,code 為 "NETOPS_JOB_LIMIT_EXCEEDED"

    # 來源: backend/src/modules/pa/log-routes.ts:95
    @untested @changed
    場景: 同時只執行 1 個明細查詢
      # FTP 連線至少留給匯入輪流使用(資安審查 Medium);測試區只有 1 條 FTP 連線
      假如 已有一個明細查詢在執行
      當 另一位使用者送出明細查詢
      那麼 新的工作 status 為 "queued",前一個完成後才開始

    # 來源: backend/src/modules/pa/log-routes.ts:95
    @untested @changed
    場景: 每人保留最近 5 次查詢結果
      假如 S112009 已有 5 個已完成的明細查詢
      當 再送出一個並完成
      那麼 最舊的一個查詢回 404 "NETOPS_JOB_NOT_FOUND",其他人的結果不受影響

    # 來源: backend/src/modules/pa/log-routes.ts:279
    @untested
    場景: 等不到 FTP 連線超過掃描秒數時回部分結果
      假如 匯入佔用唯一的 FTP 連線,明細查詢一直在排隊
      當 超過掃描秒數(PA_SEARCH_SECONDS)
      那麼 明細工作 status 為 "done",stopReason 為 "timeout",結果為已找到的部分

  # ───── C3 查詢切換(ClickHouse;docs/API.md §4.3、ARCHITECTURE D6、D29、手冊 §12 CQ10)─────

  # 來源: backend/src/modules/pa/log-routes.ts:211
  @C3 @auto
  場景: 明細查 ClickHouse
    假如 2026-11-12 08:00–09:00 在 ClickHouse 範圍內
    當 呼叫 POST /api/netops/pa/log-searches 帶 from、to、src 與 source "clickhouse"
    那麼 回應 202
    而且 完成後 result.source 為 "clickhouse",資料列與 FTP 來源欄位相同
    而且 資料列依時間由舊到新;超過 limit 時 stopReason 為 "limit"

  # 來源: backend/src/modules/pa/log-routes.ts:217
  @C3 @auto
  場景: ClickHouse 明細超過 30 天
    當 呼叫 POST /api/netops/pa/log-searches 帶 source "clickhouse" 且期間 31 天
    那麼 回應 400 VALIDATION_FAILED

  # 來源: backend/src/config.ts:285
  @C3 @auto
  場景: 並行對帳期間明細預設仍查 FTP
    # CQ10:FTP 與 ClickHouse 並行對帳 2 週沒有未處理缺口後,需求方把 NETOPS_PA_DETAIL_SOURCE 改成 auto
    假如 NETOPS_PA_DETAIL_SOURCE 未設定(預設 ftp)
    當 呼叫 POST /api/netops/pa/log-searches 沒有帶 source
    那麼 查詢走 FTP 掃描,result.source 為 "ftp"

  # 來源: backend/src/modules/pa/log-routes.ts:138
  @C3 @auto
  場景: ClickHouse 無法使用
    假如 ClickHouse 連不上
    當 呼叫 POST /api/netops/pa/log-searches 帶 source "clickhouse"
    那麼 回應 503 NETOPS_CLICKHOUSE_UNAVAILABLE
    但是 source 為 "auto" 時改走 FTP 掃描

  # 來源: backend/src/modules/pa/log-routes.ts:138
  @C3 @auto
  場景: ClickHouse 期間沒有資料
    當 呼叫 POST /api/netops/pa/log-searches 帶 source "clickhouse",期間 ClickHouse 沒有 log
    那麼 回應 404 NETOPS_PA_NO_DATA
