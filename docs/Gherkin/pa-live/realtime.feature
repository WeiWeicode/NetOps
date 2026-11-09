# language: zh-TW
@R1
功能: PA 即時監控
  為了即時掌握 PA-560 的狀態與最新 log
  身為 網通管理人員
  我要看到設備狀態、即時排行與最新 log,資料停止更新時要明確知道

  # 依據:IMPL-PLAN R1、PA-LIVE-PLAN §3–§4、§8、API.md §3.2。資料由 netops-pa 寫入 netops-redis,netops-api 只讀。
  # 本機單元測試用假 Redis(backend/test/fixtures/fake-redis.ts)與縮短的串流間隔;經 Gateway 與真實 PA-560 的行為要在測試區驗證(@e2e)。
  # 收集器(pa-collector/)的接收、修剪、輪詢由 pytest 驗證(pa-collector/tests/)。

  Rule: GET /api/netops/pa-live/snapshot

    # 來源: backend/src/modules/pa-live/live-routes.ts:92
    @auto @e2e
    場景: 收集器運作中時回傳設備快照
      假如 收集器心跳在 30 秒內更新且 Session 快照存在
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 回應 200
      而且 collector.state 為 "ok"、metrics.session.active 為數字

    # 來源: backend/src/modules/pa-live/live-routes.ts:98
    @auto @e2e
    場景: 收集器停止時不顯示舊快照
      假如 收集器心跳超過 30 秒沒有更新
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 collector.state 為 "stopped"
      而且 metrics 的每個指標都是 null

    # 來源: backend/src/modules/pa-live/live-routes.ts:104
    @auto @e2e
    場景: 收集器未啟用
      假如 收集器的輪詢與接收都關閉
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 collector.state 為 "disabled"

    # 來源: backend/src/modules/pa-live/live-routes.ts:109
    @auto
    場景: Redis 連不上
      假如 netops-redis 停止
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 回應 200 且 collector.state 為 "unavailable"

  Rule: PUT /api/netops/pa-live/collector-control(測試區手動開關,2026-11-09 需求方決定)

    # 來源: backend/src/modules/pa-live/live-routes.ts:135
    @auto @e2e
    場景: 測試區暫停輪詢
      假如 部署區為測試區且使用者擁有 netops.pa-realtime.write
      當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"pollPaused": true}
      那麼 回應 200
      而且 control.pollPaused 為 true、control.updatedBy 為操作人
      而且 收集器在下一次輪詢前停止查詢 PA-560,心跳 collector.poll.paused 變為 true

    # 來源: backend/src/modules/pa-live/live-routes.ts:142
    @auto @e2e
    場景: 繼續接收
      假如 接收已暫停
      當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"receivePaused": false}
      那麼 回應 200 且 control.receivePaused 為 false

    # 來源: backend/src/modules/pa-live/live-routes.ts:147
    @auto
    場景: 沒有給任何欄位
      當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {}
      那麼 回應 400 VALIDATION_FAILED

    # 來源: backend/src/modules/pa-live/live-routes.ts:151
    @auto
    場景: 正式區不能切換
      假如 部署區為正式區
      當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"pollPaused": true}
      那麼 回應 403 且 code 為 "NETOPS_PA_CONTROL_DISABLED"

    # 來源: backend/src/modules/pa-live/live-routes.ts:156
    @e2e
    場景: 檢視者不能切換
      假如 使用者只有 netops.pa-realtime.read
      當 呼叫 PUT /api/netops/pa-live/collector-control
      那麼 回應 403

    # 來源: backend/src/modules/pa-live/live-routes.ts:1
    @auto
    場景: Redis 連不上
      假如 netops-redis 停止
      當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"pollPaused": true}
      那麼 回應 424 NETOPS_REDIS_UNAVAILABLE

  Rule: GET /api/netops/pa-live/series

    # 來源: backend/src/modules/pa-live/live-routes.ts:199
    @auto @e2e
    場景: 查詢最近 1 小時 CPU 趨勢
      當 呼叫 GET /api/netops/pa-live/series?metric=cpu&minutes=60
      那麼 回應 200
      而且 points 依時間由舊到新

  Rule: GET /api/netops/pa-live/top

    # 來源: backend/src/modules/pa-live/live-routes.ts:228
    @auto @e2e
    場景: 查詢最近 15 分鐘 TRAFFIC 排行
      當 呼叫 GET /api/netops/pa-live/top?type=traffic&minutes=15
      那麼 回應 200
      而且 tops.src 依次數由大到小

    # 來源: backend/src/modules/pa-live/live-routes.ts:233
    @auto
    場景: 不支援的期間
      當 呼叫 GET /api/netops/pa-live/top?type=traffic&minutes=30
      那麼 回應 400 VALIDATION_FAILED

  Rule: GET /api/netops/pa-live/logs

    # 來源: backend/src/modules/pa-live/live-routes.ts:267
    @auto @e2e
    場景: 查詢最新 TRAFFIC log
      當 呼叫 GET /api/netops/pa-live/logs?type=traffic&limit=50
      那麼 回應 200
      而且 items 依時間由新到舊、最多 50 筆
      而且 earliest 為 Redis 內最早一筆的時間

    # 來源: backend/src/modules/pa-live/live-routes.ts:273
    @auto
    場景: 依 IP 篩選
      當 呼叫 GET /api/netops/pa-live/logs?type=threat&ip=10.1.2.3
      那麼 items 的來源或目的 IP 都是 10.1.2.3

    # 來源: backend/src/modules/pa-live/live-routes.ts:277
    @auto
    場景: Redis 連不上時明確失敗
      假如 netops-redis 停止
      當 呼叫 GET /api/netops/pa-live/logs?type=traffic
      那麼 回應 424 NETOPS_REDIS_UNAVAILABLE

  Rule: GET /api/netops/pa-live/stream

    # 來源: backend/src/modules/pa-live/live-routes.ts:318
    @auto @e2e
    場景: 連線後立即收到 open 與 snapshot
      假如 使用者已登入且擁有 netops.pa-realtime.read
      當 以 EventSource 連線 GET /api/netops/pa-live/stream
      那麼 回應 200 且 Content-Type 為 text/event-stream
      而且 立即收到 open 與 snapshot 事件

    # 來源: backend/src/modules/pa-live/live-routes.ts:324
    @auto @e2e
    場景: 有新 log 時收到 logs 事件
      假如 已連線 GET /api/netops/pa-live/stream?types=traffic
      當 收集器寫入新的 TRAFFIC log
      那麼 收到 event 為 "logs" 的事件,id 為游標

    # 來源: backend/src/modules/pa-live/live-routes.ts:329
    @auto @e2e
    場景: 斷線後以 Last-Event-ID 接續
      假如 上一次連線最後收到的 id 為 traffic 的游標
      當 以 Last-Event-ID 重新連線
      那麼 只收到游標之後的 log

    # 來源: backend/src/modules/pa-live/live-routes.ts:334
    @auto
    場景: 連線數超過上限
      假如 同一使用者已有 2 條串流
      當 再連線 GET /api/netops/pa-live/stream
      那麼 回應 429 NETOPS_STREAM_BUSY

    # 來源: backend/src/modules/pa-live/live-routes.ts:69
    @auto @e2e
    場景: 單一連線最長 5 分鐘
      假如 已連線 GET /api/netops/pa-live/stream 超過 5 分鐘
      那麼 伺服器結束連線
      而且 瀏覽器 5 秒後自動重連,BFF 重新檢查登入與權限

  Rule: 收集器(netops-pa)

    # 來源: pa-collector/netops_pa/config.py:7
    @auto
    場景: 測試區預設不輪詢、不接收
      假如 netops.env 沒有設定 PA_POLL_ENABLED 與 PA_RECEIVE_ENABLED
      當 netops-pa 啟動
      那麼 不連 PA-560、不開 51293 / 51294
      而且 心跳的 pollEnabled 與 receiveEnabled 為 "0"

    # 來源: pa-collector/netops_pa/poller.py:29
    @auto
    場景: SDK 只執行唯讀查詢
      當 收集器輪詢 PA-560
      那麼 只送出 show session info、show system resources、show running resource-monitor、show counter interface all

    # 來源: pa-collector/netops_pa/receiver_http.py:1
    @auto @e2e
    場景: HTTP 接收驗證 Token 與來源
      假如 PA-560 以 HTTP 轉送威脅 log 到 :51293
      當 X-NetOps-Token 不符或來源不在允許清單
      那麼 拒收並計入 rejected,不寫入 Redis

    # 來源: pa-collector/netops_pa/keys.py:25
    @auto
    場景: 依保留時間修剪
      當 收集器寫入 log
      那麼 TRAFFIC 明細只保留 1 小時、統計 1 天
      而且 其他類型明細與統計保留 2 天

    # 來源: pa-collector/netops_pa/control.py:1
    @auto
    場景: 測試區暫停輪詢時不查 PA-560
      假如 netops:pa:control 的 pollPaused 為 "1" 且 GW_ENV 不是 prod
      當 輪詢執行緒準備下一次輪詢
      那麼 不送任何查詢給 PA-560,心跳 pollPaused 為 "1"
      而且 繼續後第一輪介面流量為 null(不拿暫停前的計數相減)

    # 來源: pa-collector/netops_pa/pipeline.py:75
    @auto
    場景: 測試區暫停接收時丟棄並計數
      假如 netops:pa:control 的 receivePaused 為 "1" 且接收總開關已開
      當 PA-560 送來 log
      那麼 不寫入 Redis,計入心跳 paused
      而且 HTTP 仍回 200(避免 PA-560 重送),5 秒內套用

    # 來源: pa-collector/netops_pa/control.py:1
    @auto
    場景: 正式區不讀手動開關
      假如 GW_ENV 為 prod
      當 netops:pa:control 被設定為暫停
      那麼 輪詢與接收照常進行

  Rule: 即時監控畫面(2026-11-09 驗收 §4.4、§6-5、§7.4)

    # 來源: frontend/src/composables/paLive.ts:48(feature/pa-live-uat-1109)
    @auto @e2e
    場景: 頁首分開顯示輪詢與接收狀態
      假如 測試區輪詢已開、接收總開關關閉
      當 開啟即時監控
      那麼 頁首顯示「輪詢中」「接收未啟用」
      而且 輪詢有錯誤時顯示「輪詢失敗」、暫停時顯示「輪詢暫停」、接收開啟時顯示「接收中」

    # 來源: frontend/src/composables/paLive.ts:74(feature/pa-live-uat-1109)
    @auto @e2e
    場景: 接收未啟用時排行與即時 log 說明沒有 log 來源
      假如 接收總開關關閉
      當 即時排行與即時 log 沒有資料
      那麼 顯示「接收端點未啟用,沒有 log 來源」
      而且 不顯示「收集器有在運作,這段期間沒有收到這種 log」

    # 來源: frontend/src/composables/paLive.ts:85(feature/pa-live-uat-1109)
    @auto @e2e
    場景: 設備狀態顯示最後更新時間
      假如 收集器輪詢正常
      當 開啟即時監控
      那麼 設備狀態上方顯示「設備狀態最後更新」為快照的 time

    # 來源: frontend/src/composables/paLive.ts:106(feature/pa-live-uat-1109)
    @auto @e2e
    場景: 測試區顯示暫停 / 繼續按鈕
      假如 部署區為測試區且使用者有 netops.pa-live.manage
      當 開啟即時監控
      那麼 顯示「輪詢:停用」「接收:停用」按鈕
      而且 主機設定未開啟接收時,接收按鈕停用並說明「主機設定未開啟接收(PA_RECEIVE_ENABLED)」
      而且 正式區或檢視者看不到按鈕

    # 來源: frontend/src/composables/paLive.ts:131(feature/pa-live-uat-1109)
    @auto @manual
    場景: 串流名額滿時說明並拉長重試間隔
      假如 同一帳號已開 2 條即時串流
      當 第 3 個分頁開啟即時監控,串流回 429
      那麼 顯示「串流連線數已達上限,請關閉其他即時監控分頁」
      而且 重試間隔從 30 秒起倍增到 5 分鐘,不再每 10 秒重試

    # 來源: frontend/src/api/gateway.ts:118(feature/pa-live-uat-1109)
    @auto @e2e
    場景: 路由未發佈時顯示功能尚未啟用
      假如 netops-api 已註冊但 Gateway 路由草稿還沒發佈
      當 頁面呼叫該 API 收到 404 ROUTE_NOT_FOUND
      那麼 顯示「功能尚未啟用(路由未發佈)」與 requestId
