# language: zh-TW
@V-b1
功能: PA 分析儀表板
  為了用圖表看出流量走向與威脅來源,並點圖表看那段時間的明細
  身為 網通管理人員
  我要看流量與安全威脅兩個視角的儀表板

  # 依據:docs/API.md §4.5;docs/VIZ-RULES-DESIGN.md §4.4;ARCHITECTURE D40、D41(需求方 2026-11-11 決策 V9、V10、X14)。
  # 權限:netops.pa.read(畫面節點 netops.pa-insight.read;點圖表開時段明細另要 netops.pa-log.read,同一節點 includes)。
  # 畫面(圖表元件、版面、動畫)由 Gemini 在 V-b2 實作,場景在 V-b2 補上。

  背景:
    假如 使用者已登入且擁有 "netops.pa.read"

  # 來源: backend/src/modules/pa-insight/routes.ts:34
  @auto
  場景: 流量儀表板
    當 呼叫 GET /api/netops/pa/insight/traffic?from=2026-11-05&to=2026-11-11
    那麼 回應 200
    而且 回應含 trend、sankey、topIp、topApp、allowDeny 與 coverage
    而且 trend 的 sessions 加總等於流量總覽同期間的連線數

  # 來源: backend/src/modules/pa-insight/routes.ts:40
  @auto
  場景: 儀表板期間超過 90 天
    當 呼叫 GET /api/netops/pa/insight/traffic 的期間 91 天
    那麼 回應 400 VALIDATION_FAILED

  # 來源: backend/src/modules/pa-insight/routes.ts:61
  @auto
  場景: 威脅儀表板
    當 呼叫 GET /api/netops/pa/insight/threat?from=2026-11-05&to=2026-11-11
    那麼 回應 200
    而且 countries 每筆有 country、iso2、count,內網範圍不列入
    而且 伺服器網段尚未設定時 topServerDst 為 null 且 notes 有說明
