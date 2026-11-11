# language: zh-TW
@B2 @C3
功能: PA 安全事件(其他類型 log)總覽
  為了查看威脅、URL 過濾、WildFire 等 TRAFFIC 以外的事件
  身為 網通管理人員
  我要依類型與期間查看摘要

  # 依據:docs/API.md §4.2;ARCHITECTURE D4(核心 paevents.js 逐字搬移)、D43(2026-11-11:威脅類只查 ClickHouse)。
  # 解密、GlobalProtect、User-ID 不進 ClickHouse(AGENT.md §7.2),仍是 FTP 已分析的摘要。
  # 權限:netops.pa.read(401 / 403 見 api/skeleton.feature)。

  背景:
    假如 使用者已登入且擁有 "netops.pa.read"
    而且 ClickHouse 從 2026-11-11 起有威脅 log

  # 來源: backend/src/modules/pa-events/routes.ts:26
  @auto
  場景: 列出類型
    當 呼叫 GET /api/netops/pa-events/types
    那麼 回應 200
    而且 types 含 threat(source "clickhouse",days 為 ClickHouse 有資料的日期、coverage 為範圍)
    而且 解密、GlobalProtect、User-ID 為 source "ftp"(只列有設定 FTP 目錄的)

  # 來源: backend/src/modules/pa-events/routes.ts:63
  @auto
  場景: 查詢威脅總覽
    假如 ClickHouse 有 2026-11-12 的威脅 log
    當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-11-12
    那麼 回應 200
    而且 type 為 "threat"、source 為 "clickhouse"
    而且 rows、kpis、tops 為 ClickHouse 每小時摘要合併的結果(次數乘 Repeat Count,同舊版 mergeEventSummaries)

  # 來源: backend/src/modules/pa-events/routes.ts:69
  @auto
  場景: 不支援的類型
    當 呼叫 GET /api/netops/pa-events/overview?type=nope&from=2026-11-01
    那麼 回應 400 VALIDATION_FAILED

  # 來源: backend/src/modules/pa-events/routes.ts:73
  @auto @changed
  場景: 威脅類超過保留期限
    # 舊版查 FTP;新版只查 ClickHouse(正式區威脅類保留 90 天),超過不回 0
    假如 ClickHouse 從 2026-11-11 起有威脅 log
    當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-10-01
    那麼 回應 404 NETOPS_PA_OUT_OF_RETENTION

  # 來源: backend/src/modules/pa-events/routes.ts:78
  @auto
  場景: 不在 ClickHouse 的類型查 FTP
    當 呼叫 GET /api/netops/pa-events/overview?type=userid&from=2026-11-12
    那麼 回應 200
    而且 source 為 "ftp"

  # 來源: backend/src/shared/time.ts:52
  @auto @changed
  場景: 安全事件總覽期間超過 92 天
    當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-01-01&to=2026-11-01
    那麼 回應 400,code 為 "VALIDATION_FAILED"
