# language: zh-TW
@V-a
功能: PA 活動熱力圖與時段明細
  為了一眼看出哪些時段流量、阻擋或威脅異常,並點進去看那段時間的明細
  身為 網通管理人員
  我要看年 / 月 / 日三級的熱力圖,點格子開時段明細

  # 依據:docs/API.md §4.4;docs/VIZ-RULES-DESIGN.md §3、§4.2、§4.3;ARCHITECTURE D34、D35(需求方 2026-11-11 決策 V1、V3、X4、X8、X9)。
  # 權限:熱力圖 netops.pa.read;時段明細 netops.pa-log.read(401 / 403 見 api/skeleton.feature)。
  # 畫面(熱力圖頁、抽屜、動畫)由 Gemini 在 V-b2 實作,場景在 V-b2 補上。

  背景:
    假如 使用者已登入且擁有 "netops.pa.read" 與 "netops.pa-log.read"
    而且 ClickHouse 熱力圖彙總表 pa_heat_5m、pa_heat_1h、pa_heat_1d 已建立

  # 來源: backend/src/modules/pa-heat/routes.ts:33
  @auto
  場景: 月視圖
    假如 ClickHouse 熱力圖彙總有 2026-11 的資料
    當 呼叫 GET /api/netops/pa/heatmap?granularity=month&metric=traffic&date=2026-11-11
    那麼 回應 200
    而且 bucketSeconds 為 3600,cells 只到現在,每格有 t、v、level、partial、tip

  # 來源: backend/src/modules/pa-heat/routes.ts:39
  @auto
  場景: 沒有資料的格子是 null
    假如 彙總表最早的資料是 2026-11-10 15:00
    當 呼叫 GET /api/netops/pa/heatmap?granularity=month&metric=traffic&date=2026-11-11
    那麼 2026-11-10 15:00 之前的格子 v 為 null、level 為 0
    而且 之後沒有流量的格子 v 為 0

  # 來源: backend/src/modules/pa-heat/routes.ts:45
  @auto
  場景: 威脅依最高嚴重度分級
    當 呼叫 GET /api/netops/pa/heatmap?granularity=day&metric=threat
    那麼 有 critical 的格子 level 為 4,v 為 10×critical + 5×high + 2×medium + 1×low

  # 來源: backend/src/modules/pa-heat/routes.ts:49
  @auto
  場景: AD 指標尚未開放
    當 呼叫 GET /api/netops/pa/heatmap?granularity=year&metric=ad
    那麼 回應 409 NETOPS_HEATMAP_METRIC_UNAVAILABLE

  # 來源: backend/src/modules/pa-heat/routes.ts:53
  @auto
  場景: 日視圖超過 1 年
    當 呼叫 GET /api/netops/pa/heatmap?granularity=day&metric=traffic 帶 366 天前的 date
    那麼 回應 422 NETOPS_HEATMAP_OUT_OF_RETENTION
    而且 details.earliest 為最早可查的日期

  # 來源: backend/test/integration/heat.int.test.ts:66
  @auto
  場景: 彙總表總數和原始表一致
    假如 netops-ingest 寫入 TRAFFIC 與威脅 log
    當 物化檢視寫進 pa_heat_5m、pa_heat_1h、pa_heat_1d
    那麼 三張表的筆數、位元組、阻擋數和原始列一致
    而且 威脅只算 log_type 為 threat 的筆數,不乘 Repeat Count
    而且 同一批用同一個 token 重送不重複計算

  # 來源: backend/src/modules/pa-heat/routes.ts:83
  @auto
  場景: 熱資料時段明細
    假如 2026-11-11 08:00–09:00 在 ClickHouse 原始表保留範圍內
    當 呼叫 GET /api/netops/pa/slice?start=2026-11-11T08:00:00%2B08:00&end=2026-11-11T09:00:00%2B08:00
    那麼 回應 200
    而且 source 為 "hot",回應含 summary、top、rows,rows 最多 rows 參數的筆數

  # 來源: backend/src/modules/pa-heat/routes.ts:89
  @auto
  場景: 超過 30 秒轉成工作
    假如 查詢 30 秒內沒有完成
    當 呼叫 GET /api/netops/pa/slice
    那麼 回應 202 與工作狀態
    而且 之後 GET /api/netops/pa/slices/{id} 的 status 會變成 "done",result 為明細

  # 來源: backend/src/modules/pa-heat/routes.ts:95
  @auto
  場景: 同條件重送重用同一個工作
    假如 同一人同條件的工作還在執行
    當 再呼叫一次 GET /api/netops/pa/slice
    那麼 回應同一個工作 id,不重複查詢

  # 來源: backend/src/modules/pa-heat/routes.ts:100
  @auto
  場景: 時段超過 1 天
    當 呼叫 GET /api/netops/pa/slice 的 end − start 超過 1 天
    那麼 回應 400 VALIDATION_FAILED

  # 來源: backend/src/modules/pa-heat/routes.ts:104
  @auto
  場景: 冷資料尚未提供
    假如 冷歸檔(C4)尚未提供
    當 呼叫 GET /api/netops/pa/slice 的 start 早於原始表保留範圍
    那麼 回應 409 NETOPS_COLD_ARCHIVE_DISABLED

  # 來源: backend/src/modules/pa-heat/routes.ts:109
  @auto
  場景: 已有冷查詢在執行
    假如 冷歸檔已提供且已有另一個冷查詢在執行
    當 呼叫 GET /api/netops/pa/slice 查冷資料
    那麼 回應 429 NETOPS_COLD_QUERY_BUSY
    而且 回應標頭有 Retry-After

  # 來源: backend/src/modules/pa-heat/routes.ts:163
  @auto
  場景: 查詢時段明細工作
    當 呼叫 GET /api/netops/pa/slices/{id}
    那麼 回應 200
    而且 完成時 result 含 summary、top、rows

  # 來源: backend/src/modules/pa-heat/routes.ts:163
  @auto
  場景: 別人的時段明細工作
    當 另一位使用者查詢同一個 id
    那麼 回應 404 NETOPS_JOB_NOT_FOUND

  # 來源: backend/src/modules/pa-heat/routes.ts:180
  @auto
  場景: 取消時段明細工作
    當 呼叫 DELETE /api/netops/pa/slices/{id}
    那麼 回應 204
    而且 再呼叫一次也回 204
