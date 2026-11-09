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

    # 來源: backend/src/modules/pa-live/live-routes.ts:90
    @auto @e2e
    場景: 收集器運作中時回傳設備快照
      假如 收集器心跳在 30 秒內更新且 Session 快照存在
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 回應 200
      而且 collector.state 為 "ok"、metrics.session.active 為數字

    # 來源: backend/src/modules/pa-live/live-routes.ts:96
    @auto @e2e
    場景: 收集器停止時不顯示舊快照
      假如 收集器心跳超過 30 秒沒有更新
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 collector.state 為 "stopped"
      而且 metrics 的每個指標都是 null

    # 來源: backend/src/modules/pa-live/live-routes.ts:102
    @auto @e2e
    場景: 收集器未啟用
      假如 收集器的輪詢與接收都關閉
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 collector.state 為 "disabled"

    # 來源: backend/src/modules/pa-live/live-routes.ts:107
    @auto
    場景: Redis 連不上
      假如 netops-redis 停止
      當 呼叫 GET /api/netops/pa-live/snapshot
      那麼 回應 200 且 collector.state 為 "unavailable"

  Rule: GET /api/netops/pa-live/series

    # 來源: backend/src/modules/pa-live/live-routes.ts:128
    @auto @e2e
    場景: 查詢最近 1 小時 CPU 趨勢
      當 呼叫 GET /api/netops/pa-live/series?metric=cpu&minutes=60
      那麼 回應 200
      而且 points 依時間由舊到新

  Rule: GET /api/netops/pa-live/top

    # 來源: backend/src/modules/pa-live/live-routes.ts:157
    @auto @e2e
    場景: 查詢最近 15 分鐘 TRAFFIC 排行
      當 呼叫 GET /api/netops/pa-live/top?type=traffic&minutes=15
      那麼 回應 200
      而且 tops.src 依次數由大到小

    # 來源: backend/src/modules/pa-live/live-routes.ts:162
    @auto
    場景: 不支援的期間
      當 呼叫 GET /api/netops/pa-live/top?type=traffic&minutes=30
      那麼 回應 400 VALIDATION_FAILED

  Rule: GET /api/netops/pa-live/logs

    # 來源: backend/src/modules/pa-live/live-routes.ts:196
    @auto @e2e
    場景: 查詢最新 TRAFFIC log
      當 呼叫 GET /api/netops/pa-live/logs?type=traffic&limit=50
      那麼 回應 200
      而且 items 依時間由新到舊、最多 50 筆
      而且 earliest 為 Redis 內最早一筆的時間

    # 來源: backend/src/modules/pa-live/live-routes.ts:202
    @auto
    場景: 依 IP 篩選
      當 呼叫 GET /api/netops/pa-live/logs?type=threat&ip=10.1.2.3
      那麼 items 的來源或目的 IP 都是 10.1.2.3

    # 來源: backend/src/modules/pa-live/live-routes.ts:206
    @auto
    場景: Redis 連不上時明確失敗
      假如 netops-redis 停止
      當 呼叫 GET /api/netops/pa-live/logs?type=traffic
      那麼 回應 424 NETOPS_REDIS_UNAVAILABLE

  Rule: GET /api/netops/pa-live/stream

    # 來源: backend/src/modules/pa-live/live-routes.ts:247
    @auto @e2e
    場景: 連線後立即收到 open 與 snapshot
      假如 使用者已登入且擁有 netops.pa-realtime.read
      當 以 EventSource 連線 GET /api/netops/pa-live/stream
      那麼 回應 200 且 Content-Type 為 text/event-stream
      而且 立即收到 open 與 snapshot 事件

    # 來源: backend/src/modules/pa-live/live-routes.ts:253
    @auto @e2e
    場景: 有新 log 時收到 logs 事件
      假如 已連線 GET /api/netops/pa-live/stream?types=traffic
      當 收集器寫入新的 TRAFFIC log
      那麼 收到 event 為 "logs" 的事件,id 為游標

    # 來源: backend/src/modules/pa-live/live-routes.ts:258
    @auto @e2e
    場景: 斷線後以 Last-Event-ID 接續
      假如 上一次連線最後收到的 id 為 traffic 的游標
      當 以 Last-Event-ID 重新連線
      那麼 只收到游標之後的 log

    # 來源: backend/src/modules/pa-live/live-routes.ts:263
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
