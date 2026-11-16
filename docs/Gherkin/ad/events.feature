# language: zh-TW
@B2
功能: AD 事件總覽、明細查詢與匯出
  為了追查網域的登入失敗、帳號鎖定與特權異動
  身為 網通管理人員
  我要查看已匯入的 AD 事件統計,依條件查明細並匯出

  # 依據:docs/API.md §6;ARCHITECTURE D4(核心 adlog.js 逐字搬移)。資料已在本機,查詢不掃 FTP,維持同步回應。
  # 權限:總覽 netops.ad.read、明細與匯出 netops.ad-log.read(401 / 403 見 api/skeleton.feature);明細與匯出 x-audit-level: meta。
  # AI 用的 adContext、isAdQuestion 等不搬移(D17),不寫。

  背景:
    假如 使用者已登入且擁有 "netops.ad.read"、"netops.ad-log.read"
    而且 2026-11-01、2026-11-02 已匯入 AD 事件

  Rule: 總覽(netops.ad.read)

    # 來源: backend/src/modules/ad/routes.ts:64
    @auto
    場景: 列出已匯入的日期
      當 呼叫 GET /api/netops/ad/days
      那麼 回應 200
      而且 回應含 days、channels、securityEvents
      而且 days 依日期新的在前,day 為 "YYYY-MM-DD"

    # 來源: backend/src/modules/ad/routes.ts:73
    @auto @security @changed
    場景: 同步失敗的細節只給有 FTP 權限的人看
      # 錯誤細節可能含 FTP 主機資訊;netops.ad.read 範圍比 FTP 權限廣(資安審查 Low)
      假如 上一次 AD 同步失敗
      當 呼叫 GET /api/netops/ad/days
      那麼 import.lastSyncError 為「同步失敗,詳見 FTP Log 檔案頁」
      而且 細節只在 GET /api/netops/ftp/ad/status(netops.ftp.read)

    # 來源: backend/src/modules/ad/routes.ts:90
    @auto
    場景: 查詢期間總覽
      假如 2026-11-02 已匯入 AD 事件
      當 呼叫 GET /api/netops/ad/overview?from=2026-11-02
      那麼 回應 200
      而且 days 為 1、total 大於 0
      而且 統計與舊版 summarizeAd 的結果相同,時間改為 ISO 8601 +08:00
      而且 建立帳號後隨即加入特權群組的異動排在 accountChanges 前面,privileged 為 true

    # 來源: backend/src/shared/time.ts:52
    @auto @changed
    場景: AD 總覽期間超過 92 天
      當 呼叫 GET /api/netops/ad/overview?from=2026-01-01&to=2026-11-01
      那麼 回應 400,code 為 "VALIDATION_FAILED"

  Rule: 明細查詢(netops.ad-log.read)

    # 來源: backend/src/modules/ad/routes.ts:137
    @auto @changed
    場景: 查詢登入失敗
      # 舊版一次回最多 5,000 筆由畫面分頁;新版改 page / pageSize 分頁
      當 呼叫 GET /api/netops/ad/events?from=2026-11-02T00:00:00+08:00&to=2026-11-02T23:59:00+08:00&eventId=4625
      那麼 回應 200
      而且 items 的 eventId 都是 4625
      而且 回應含 total、page、pageSize、scanned(篩選前的總數),items 新的在前

    # 來源: backend/src/modules/ad/routes.ts:142
    @auto
    場景: 期間太長
      當 呼叫 GET /api/netops/ad/events 的期間超過 31 天
      那麼 回應 400 VALIDATION_FAILED

    # 來源: backend/src/modules/ad/routes.ts:127
    @auto
    場景大綱: 明細查詢的輸入錯誤
      當 呼叫 GET /api/netops/ad/events 帶 <內容>
      那麼 回應 400,code 為 "VALIDATION_FAILED"

      例子:
        | 內容                                 |
        | 時間沒有時區(from=2026-11-01T00:00)|
        | eventId 為 "abc"                     |
        | pageSize 為 101                      |

    # 來源: backend/src/modules/ad/routes.ts:127
    @auto
    場景: 只看需要注意的事件
      當 呼叫 GET /api/netops/ad/events 帶 issueOnly=true
      那麼 items 只含錯誤、警告、登入失敗、帳號鎖定與帳號異動的事件(與舊版 buildAdFilter 相同)

  Rule: 匯出(netops.ad-log.read)

    # 來源: backend/src/modules/ad/routes.ts:175
    @auto @changed
    場景: 匯出 CSV
      # 舊版在前端產生 CSV;新版由後端產生,欄位同舊版畫面
      當 呼叫 GET /api/netops/ad/events/export?from=2026-11-02T00:00:00+08:00&to=2026-11-02T23:59:00+08:00
      那麼 回應 200
      而且 Content-Type 為 text/csv
      而且 內容以 UTF-8 BOM 開頭,欄名為「時間、記錄、事件 ID、等級、來源、主機、帳號、執行者、對象、群組、來源 IP、工作站、原因、訊息」

    # 來源: backend/src/modules/ad/routes.ts:180
    @untested
    場景: 超過 20000 筆
      當 條件符合的事件超過上限
      那麼 回應 422 NETOPS_EXPORT_TOO_LARGE

    # 來源: backend/src/shared/csv.ts:7
    @auto @security
    場景: 匯出時避免被 Excel 當成公式
      假如 某筆事件的帳號以 "="、"+"、"-"、"@"(含全形與前置空白)開頭
      當 匯出 CSV
      那麼 該欄位前面加上 "'"
