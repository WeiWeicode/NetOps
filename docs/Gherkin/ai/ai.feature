# language: zh-TW
@A1
功能: AI 分析與問答
  為了用公司內部 AI 主機分析防火牆 log 與 AD 事件
  身為 MIS 人員
  我要在新版直接使用舊版 IIS 的 AI 分析與問答(取消 AI 中控台,ARCHITECTURE D23)

  # 依據:IMPL-PLAN A1、PA-LIVE-PLAN §6、API.md §10。由舊版 server/routes/ai.js 搬移,送給模型的內容與舊版相同(backend/test/unit/ai-core.test.ts 比對)。
  # 串流寫法依 S0(docs/test-reports/2026-11-05-s0-sse.md §3.6);經 Gateway 的長連線要在測試區驗證(@e2e)。
  # 權限:netops.ai.use(netops-admin、netops-viewer;D25 維持一個權限)。

  Rule: GET /api/netops/ai/status

    # 來源: backend/src/modules/ai/routes.ts:37
    @auto
    場景: 查詢 AI 服務狀態
      假如 使用者擁有 netops.ai.use
      當 呼叫 GET /api/netops/ai/status
      那麼 回應 200
      而且 回應有 enabled、ok、model
      而且 回應不含 AI 主機位址

  Rule: POST /api/netops/ai/analyses

    # 來源: backend/src/modules/ai/routes.ts:59
    @auto @e2e
    場景: 期間分析以 SSE 串流回答
      假如 使用者擁有 netops.ai.use
      而且 2026-11-02 有已分析的 TRAFFIC 檔案
      當 呼叫 POST /api/netops/ai/analyses 帶 from "2026-11-02"
      那麼 回應 200 且 Content-Type 為 text/event-stream
      而且 回應標頭 X-Accel-Buffering 為 "no"
      而且 依序收到 open、meta、content、done 事件

    # 來源: backend/src/modules/ai/routes.ts:67
    @auto
    場景: 期間沒有已分析的 log
      當 呼叫 POST /api/netops/ai/analyses 帶 from "2026-12-01"
      那麼 回應 404 NETOPS_PA_NO_DATA

    # 來源: backend/src/modules/ai/routes.ts:71
    @auto
    場景: AI 回答數量已達上限
      假如 使用者已有 2 個進行中的 AI 回答
      當 再呼叫 POST /api/netops/ai/analyses
      那麼 回應 429 NETOPS_STREAM_BUSY

  Rule: POST /api/netops/ai/questions

    # 來源: backend/src/modules/ai/routes.ts:114
    @auto @e2e
    場景: 問題有 IP 時查 log 後回答
      假如 使用者擁有 netops.ai.use
      而且 2026-11-02 有已分析的 TRAFFIC 檔案
      當 呼叫 POST /api/netops/ai/questions 帶時間範圍與問題 "10.10.1.5 為什麼連不到 8.8.8.8"
      那麼 回應 200 且 Content-Type 為 text/event-stream
      而且 meta 事件的 ips 為 ["10.10.1.5", "8.8.8.8"]
      而且 收到 evidence 事件,matched 為符合的筆數
      而且 收到 notes、content、done 事件

    # 來源: backend/src/modules/ai/routes.ts:123
    @untested
    場景: 掃描逾時時標示資料不完整
      假如 FTP 掃描超過上限秒數
      那麼 evidence 事件的 partial 為 true

    # 來源: backend/src/modules/ai/routes.ts:127
    @auto
    場景: 期間超過 31 天
      當 呼叫 POST /api/netops/ai/questions 帶 32 天的時間範圍
      那麼 回應 400 VALIDATION_FAILED

  Rule: 共通(與舊版不同之處)

    # 來源: backend/src/modules/ai/service.ts:81
    @auto @changed
    場景: 沒有設定 AI 服務時回 409
      # 舊版 LLM_URL 有預設主機;新版主機位址只從設定讀(AGENT.md §7.4),沒設定時不提供。回 409 不回 5xx,避免累積 BFF 斷路器失敗
      假如 netops-api 沒有設定 LLM_URL
      當 呼叫 POST /api/netops/ai/analyses
      那麼 回應 409 NETOPS_AI_DISABLED
      而且 GET /api/netops/ai/status 的 enabled 為 false

    # 來源: backend/src/modules/ai/sse.ts:105
    @auto @changed
    場景: 模型連不到時以 error 事件回傳
      # 舊版 error 事件帶上游原文(可能含主機位址);新版只回分類過的訊息,原文寫日誌
      假如 AI 主機無法連線
      當 呼叫 POST /api/netops/ai/questions 問 AD 的問題
      那麼 回應 200 且收到 error 事件,code 為 NETOPS_AI_UNAVAILABLE
      而且 訊息不含 AI 主機位址

    # 來源: backend/src/modules/ai/routes.ts:1
    @auto @changed
    場景: 翻譯與整理筆記不搬
      # 負向場景,沒有對應的 x-gherkin(來源行號指檔頭說明)。需求方 2026-11-09 依 docs/AI-FEATURE-INVENTORY.md 決定不搬(ARCHITECTURE D25);舊版 POST /ai/translate、POST /ai/note
      當 呼叫 POST /api/netops/ai/translations 或 POST /api/netops/ai/notes
      那麼 回應 404(新版沒有這兩支 API)
      而且 管理者在知識庫頁自己新增筆記
