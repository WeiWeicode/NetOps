# language: zh-TW
@S0
功能: SSE 串流驗證
  為了讓 AI 問答串流(A1)與 PA 即時監控(R1)可以經 Gateway 推送資料
  身為 系統負責人
  我要確認 SSE 經 Nginx 與 BFF 不被緩衝、不因閒置逾時中斷、斷線可重連

  # 依據:IMPL-PLAN S0、PA-LIVE-PLAN §7、API.md §3.1。測試區驗證步驟見 docs/test-reports/2026-11-05-s0-sse.md。
  # 本機單元測試用真實 HTTP 連線並把心跳縮短;經 Gateway 的行為(緩衝、60 秒逾時、斷路器)要在測試區驗證(@e2e)。

  Rule: GET /api/netops/pa-live/stream-test

    # 來源: backend/src/modules/pa-live/routes.ts:70
    @auto @e2e
    場景: 連線後立即收到 open 事件
      假如 使用者已登入且擁有 "netops.ping.read"
      當 以 EventSource 連線 GET /api/netops/pa-live/stream-test
      那麼 回應 200 且 Content-Type 為 text/event-stream
      而且 回應標頭 X-Accel-Buffering 為 "no"、Cache-Control 為 "no-cache, no-transform"
      而且 立即收到 retry 5000 與 event 為 "open"、id 為 "0" 的事件

    # 來源: backend/src/modules/pa-live/routes.ts:77
    @auto @e2e
    場景: 每 15 秒收到 heartbeat
      假如 已連線 GET /api/netops/pa-live/stream-test
      當 經過 60 秒
      那麼 至少收到 4 個 event 為 "heartbeat" 的事件
      而且 每個事件的 seq 遞增、time 為 ISO 8601

    # 來源: backend/src/modules/pa-live/routes.ts:83
    @auto @e2e
    場景: 斷線後重連序號接續
      假如 上一次連線最後收到的 id 為 "7"
      當 以 Last-Event-ID: 7 重新連線
      那麼 open 事件的 resumedFrom 為 7
      而且 下一個 heartbeat 的 seq 為 8

    # 來源: backend/src/modules/pa-live/routes.ts:89
    @e2e
    場景: 沒有權限時拒絕
      假如 使用者已登入但沒有 "netops.ping.read"
      當 呼叫 GET /api/netops/pa-live/stream-test
      那麼 回應 403,code 為 "PERMISSION_DENIED"(BFF 回應)

    # 來源: backend/src/modules/pa-live/routes.ts:111
    @auto
    場景: Last-Event-ID 格式不符時從頭開始
      當 以 Last-Event-ID: "-1; drop" 連線
      那麼 open 事件的 resumedFrom 為 null、id 為 "0"

    # 來源: backend/src/modules/pa-live/routes.ts:102
    @auto
    場景: 同時連線數超過上限
      假如 全系統已有 20 條串流連線,或同一人已有 2 條
      當 再連線 GET /api/netops/pa-live/stream-test
      那麼 回應 429,code 為 "NETOPS_STREAM_BUSY"(不用 5xx,避免累積 BFF 斷路器失敗)
      而且 任一條連線中斷後可以再連上

    # 來源: backend/src/modules/pa-live/routes.ts:139
    @auto
    場景: 單一連線到最長時間由伺服器結束
      假如 已連線 10 分鐘
      那麼 伺服器結束連線,瀏覽器 5 秒後以 Last-Event-ID 自動重連

    # 來源: docs/test-reports/2026-11-05-s0-sse.md:63
    @manual @e2e
    場景: 經 Gateway 長時間連線不中斷、不累積斷路器失敗
      假如 路由 netops.pa-live.stream-test 已發佈且逾時為 60000 ms
      當 以 backend/scripts/sse-probe.mjs 連線 6 分鐘,第 120 秒主動斷線一次
      那麼 除了主動斷線外沒有中斷,單一連線超過 65 秒
      而且 giga-observe 沒有 netops-api 的逾時或斷路器開啟紀錄
