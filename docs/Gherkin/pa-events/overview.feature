# language: zh-TW
@B2
功能: PA 安全事件(其他類型 log)總覽
  為了查看威脅、URL 過濾、WildFire 等 TRAFFIC 以外的事件
  身為 網通管理人員
  我要依類型與期間查看已分析的摘要

  # 依據:docs/API.md §4.2;ARCHITECTURE D4(核心 paevents.js 逐字搬移)。
  # 權限:netops.pa.read(401 / 403 見 api/skeleton.feature)。AI 用的 eventsForIps、eventsContext 不搬移(D17),不寫。

  背景:
    假如 使用者已登入且擁有 "netops.pa.read"
    而且 2026-11-01 有已分析的威脅 log

  # 來源: backend/src/modules/pa-events/routes.ts:23
  @auto
  場景: 列出類型
    當 呼叫 GET /api/netops/pa-events/types
    那麼 回應 200
    而且 types 含 threat,有 label、FTP 目錄 dir、files、rows、days("YYYY-MM-DD",新的在前)
    而且 只列出有設定 FTP 目錄的類型

  # 來源: backend/src/modules/pa-events/routes.ts:41
  @auto
  場景: 查詢威脅總覽
    當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-11-01&top=15
    那麼 回應 200
    而且 type 為 "threat"
    而且 rows、kpis、tops 與舊版 mergeEventSummaries 的結果相同
    而且 hours 的時間為 ISO 8601 +08:00,missing 為 0

  # 來源: backend/src/modules/pa-events/routes.ts:46
  @auto
  場景: 不支援的類型
    當 呼叫 GET /api/netops/pa-events/overview?type=nope&from=2026-11-01
    那麼 回應 400,code 為 "VALIDATION_FAILED",details 指出 type

  # 來源: backend/src/shared/time.ts:52
  @auto @changed
  場景: 安全事件總覽期間超過 92 天
    當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-01-01&to=2026-11-01
    那麼 回應 400,code 為 "VALIDATION_FAILED"

  # ───── C3 查詢切換(ClickHouse;docs/API.md §4.2)─────

  # 來源: backend/src/modules/pa-events/routes.ts:50
  @C3 @auto
  場景: 威脅類查 ClickHouse
    假如 ClickHouse 從 2026-11-11 08:00 起有資料,總覽來源設定為 auto
    當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-11-12
    那麼 回應 200
    而且 source 為 "clickhouse"
    而且 rows、kpis、tops 為 ClickHouse 每小時摘要合併的結果(次數乘 Repeat Count,同 FTP)

  # 來源: backend/src/modules/pa-events/routes.ts:56
  @C3 @auto
  場景: 不在 ClickHouse 的類型查 FTP
    當 呼叫 GET /api/netops/pa-events/overview?type=userid&from=2026-11-12
    那麼 回應 200
    而且 source 為 "ftp"
