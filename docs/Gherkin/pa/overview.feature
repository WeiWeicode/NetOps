# language: zh-TW
@B2 @C3
功能: PA 流量總覽
  為了掌握防火牆流量、阻擋與異常來源
  身為 網通管理人員
  我要依期間查看 TRAFFIC 統計,並清楚知道資料是否完整、有哪些日期可以查

  # 依據:docs/API.md §4.1;ARCHITECTURE D4(核心 palog.js 逐字搬移)、D29、D42(ClickHouse 每小時摘要)、
  #       D43(2026-11-11 需求方決定:只查 ClickHouse,捨棄 FTP 查詢路徑,不再並行 2 週);AGENT.md §5。
  # 權限:netops.pa.read(沒有登入 401、沒有權限 403,見 api/skeleton.feature 的權限場景大綱)。

  背景:
    假如 使用者已登入且擁有 "netops.pa.read"
    而且 ClickHouse 從 2026-11-11 起有 TRAFFIC

  # 來源: backend/src/modules/pa/routes.ts:35
  @auto
  場景: 列出有資料的日期
    假如 ClickHouse 有 2026-11-11、2026-11-12 的 TRAFFIC
    當 呼叫 GET /api/netops/pa/days
    那麼 回應 200
    而且 days 第一筆的 day 為 "2026-11-12",coverage 為 { from: "2026-11-11", to: "2026-11-12" }

  # 來源: backend/src/modules/pa/routes.ts:66
  @auto
  場景: 查詢期間總覽
    假如 ClickHouse 有 2026-11-12 的 TRAFFIC
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-12
    那麼 回應 200
    而且 source 為 "clickhouse"、files 為有資料的小時數、hours 的時間為 ISO 8601 +08:00

  # 來源: backend/src/modules/pa/ch-overview.ts:91
  @auto
  場景: 筆數來自每小時彙總,排行來自每小時摘要
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-12
    那麼 rows、allow、block、bytes、hours、actions 來自每小時彙總(含進行中的小時)
    而且 top、topBytes、scan、sent、recv、subtypes 來自每小時摘要(與舊版 FTP 摘要同一份核心),只到 topsUntil
    而且 topsState 不是 "ok" 時(剛啟動或 ClickHouse 停止)排行不完整

  # 來源: backend/src/modules/pa/routes.ts:72
  @auto
  場景: 期間有一部分早於 ClickHouse 的資料
    假如 ClickHouse 從 2026-11-11 起有資料
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-10&to=2026-11-11
    那麼 回應 200
    而且 partial 為 true,coverage.from 為 "2026-11-11"

  # 來源: backend/src/modules/pa/routes.ts:78
  @auto @changed
  場景: 超過保留期限
    # 舊版回 files 0;新版明確告知超過保留期限,不回 0 誤導(AGENT.md §5)
    假如 ClickHouse 從 2026-11-11 起有資料
    當 呼叫 GET /api/netops/pa/overview?from=2026-10-01
    那麼 回應 404 NETOPS_PA_OUT_OF_RETENTION

  # 來源: backend/src/modules/pa/routes.ts:83
  @auto
  場景: 日期格式錯誤
    當 呼叫 GET /api/netops/pa/overview?from=2026/11/02
    那麼 回應 400 VALIDATION_FAILED

  # 來源: backend/src/shared/time.ts:52
  @auto @changed
  場景: 期間超過 92 天或結束早於開始
    當 呼叫 GET /api/netops/pa/overview?from=2026-01-01&to=2026-11-01
    那麼 回應 400,code 為 "VALIDATION_FAILED",details 指出 to
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-02&to=2026-11-01
    那麼 回應 400

  # 來源: backend/src/modules/pa/routes.ts:87
  @auto
  場景: ClickHouse 無法使用
    假如 ClickHouse 連不上
    當 呼叫 GET /api/netops/pa/overview?from=2026-11-12
    那麼 回應 503 NETOPS_CLICKHOUSE_UNAVAILABLE

  # 來源: backend/src/modules/pa/routes.ts:121
  @auto
  場景: 取得篩選選項
    當 呼叫 GET /api/netops/pa/options?from=2026-11-12
    那麼 回應 200
    而且 回應含 apps、rules、zones、actions

  # 來源: backend/src/modules/pa/ch-summary.ts:78
  @auto
  場景: ClickHouse 每小時摘要只建已結束的小時,筆數變了就重建
    假如 現在是 2026-11-12 03:10
    當 背景每 5 分鐘檢查一次
    那麼 02:00 以前有資料的小時都有摘要,03:00 還沒有
    而且 某一小時的筆數改變(晚到、FTP 補漏)時,下一輪重建那一小時
    而且 超過 NETOPS_CH_SUMMARY_DAYS 天的摘要被清除
