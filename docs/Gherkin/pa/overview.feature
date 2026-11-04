# language: zh-TW
@B2
功能: PA 流量總覽
  為了掌握防火牆流量、阻擋與異常來源
  身為 網通管理人員
  我要依期間查看已分析的 TRAFFIC log 摘要,並清楚知道資料是否完整

  # 依據:docs/API.md §4.1;ARCHITECTURE D4(核心 palog.js 逐字搬移,SUMMARY_VERSION = 4)、D8;AGENT.md §5。
  # 權限:netops.pa.read(沒有登入 401、沒有權限 403,見 api/skeleton.feature 的權限場景大綱)。

  背景:
    假如 使用者已登入且擁有 "netops.pa.read"
    而且 2026-11-01、2026-11-02 各有已分析的 TRAFFIC 檔案

  # 來源: backend/src/modules/pa/routes.ts:36
  @auto
  場景: 列出有資料的日期
    當 呼叫 GET /api/netops/pa/days
    那麼 回應 200
    而且 days 依日期新的在前,每筆有 day("YYYY-MM-DD")、files、rows
    而且 import 為匯入狀態(不含分析中的檔案清單)

  # 來源: backend/src/modules/pa/routes.ts:58
  @auto
  場景: 查詢期間總覽
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-01&to=2026-11-02&top=15
    那麼 回應 200
    而且 rows、allow、block、bytes、actions、top、topBytes、scan 與舊版 mergeSummaries 的結果相同
    而且 hours 的 hour 與 timeMin、timeMax 為 ISO 8601 +08:00
    而且 hours 只含期間內的小時

  # 來源: backend/src/modules/pa/routes.ts:64
  @auto
  場景: 沒有資料的期間
    當 呼叫 GET /api/netops/pa/overview?from=2020-01-01
    那麼 回應 200
    而且 files 為 0、rows 為 0(畫面要說明「沒有已分析的資料」,不是沒有流量)

  # 來源: backend/src/modules/pa/routes.ts:69
  @auto
  場景: 日期格式錯誤
    當 呼叫 GET /api/netops/pa/overview?from=2026/11/02
    那麼 回應 400,code 為 "VALIDATION_FAILED"

  # 來源: backend/src/shared/time.ts:52
  @auto @changed
  場景: 期間超過 92 天或結束早於開始
    # 舊版沒有期間上限;新版合併在程序內計算,期間太長會超過路由逾時
    當 呼叫 GET /api/netops/pa/overview?from=2026-01-01&to=2026-11-01
    那麼 回應 400,code 為 "VALIDATION_FAILED",details 指出 to
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-02&to=2026-11-01
    那麼 回應 400

  # 來源: backend/src/modules/pa/routes.ts:17
  @auto @changed
  場景: 摘要檔遺失時標出不完整
    # 舊版讀不到摘要時直接略過;新版回 missing(AGENT.md §5)
    假如 期間內有一個已分析的檔案,摘要檔已不存在
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-03
    那麼 回應 200,missing 為 1

  # 來源: backend/src/modules/pa/routes.ts:84
  @untested
  場景: 匯入中或分析失敗時提示可能不完整
    假如 還有檔案在分析中
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-02
    那麼 import.busy 為 true

  # 來源: backend/src/modules/pa/routes.ts:106
  @auto
  場景: 取得篩選選項
    當 呼叫 GET /api/netops/pa/options?from=2026-11-01&to=2026-11-02
    那麼 回應 200
    而且 回應含 apps、rules、zones、actions(期間內出現過的值;zones 由「來源 → 目的」拆開)

  # 來源: backend/src/modules/pa/routes.ts:98
  @untested
  場景: 篩選選項缺少開始日期
    當 呼叫 GET /api/netops/pa/options
    那麼 回應 400,code 為 "VALIDATION_FAILED"
