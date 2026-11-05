# language: zh-TW
@A1
功能: 知識庫的 AI 功能
  為了讓 AI 問答參考管理者記錄的知識
  身為 MIS 人員
  我要語意搜尋筆記、同步向量庫、自動學習外部 IP 的擁有者

  # 依據:IMPL-PLAN A1、API.md §10.2;舊版 server/routes/kb.js(semantic、vector-sync、learn-ips)、lib/vector.js、lib/iplearn.js。
  # 向量庫與舊版共用 Qdrant NetOpsKb:VECTOR_SYNC 預設 0,只搜尋不寫入(@changed)。

  Rule: GET /api/netops/kb/semantic-search

    # 來源: backend/src/modules/kb/ai-routes.ts:50
    @auto
    場景: 語意搜尋
      假如 使用者擁有 netops.kb.read
      而且 向量庫已同步
      當 呼叫 GET /api/netops/kb/semantic-search?q=備份主機
      那麼 回應 200
      而且 items 依 score 由高到低排序

    # 來源: backend/src/modules/kb/ai-routes.ts:57
    @untested
    場景: 向量庫連不到
      假如 Qdrant 無法連線
      當 呼叫 GET /api/netops/kb/semantic-search?q=備份主機
      那麼 回應 200 且 items 為空
      而且 vector.error 不是空字串

  Rule: GET /api/netops/kb/vector-status

    # 來源: backend/src/modules/kb/ai-routes.ts:88
    @auto
    場景: 查詢向量庫狀態
      當 呼叫 GET /api/netops/kb/vector-status
      那麼 回應 200
      而且 回應有 enabled、sync、points、lastSync

  Rule: POST /api/netops/kb/vector-syncs

    # 來源: backend/src/modules/kb/ai-routes.ts:107
    @auto @changed
    場景: 沒有啟用同步
      假如 VECTOR_SYNC 為 0
      當 呼叫 POST /api/netops/kb/vector-syncs
      那麼 回應 409 NETOPS_VECTOR_SYNC_DISABLED

    # 來源: backend/src/modules/kb/ai-routes.ts:112
    @untested
    場景: 立即同步
      假如 VECTOR_SYNC 為 1
      當 呼叫 POST /api/netops/kb/vector-syncs
      那麼 回應 202
      而且 之後 vector-status 的 lastSync 更新

  Rule: GET /api/netops/kb/ip-learning

    # 來源: backend/src/modules/kb/ai-routes.ts:146
    @auto
    場景: 查詢外部 IP 自動學習狀態
      當 呼叫 GET /api/netops/kb/ip-learning
      那麼 回應 200
      而且 回應有 enabled、busy、hour

  Rule: POST /api/netops/kb/ip-learnings

    # 來源: backend/src/modules/kb/ai-routes.ts:165
    @auto
    場景: 開始學習
      假如 使用者擁有 netops.kb.write
      當 呼叫 POST /api/netops/kb/ip-learnings 帶 days 7
      那麼 回應 202 且 busy 為 true

    # 來源: backend/src/modules/kb/ai-routes.ts:170
    @auto
    場景: 執行中再送出
      假如 外部 IP 自動學習正在執行
      當 呼叫 POST /api/netops/kb/ip-learnings
      那麼 回應 409 NETOPS_IPLEARN_BUSY

  Rule: 與舊版不同之處

    # 來源: backend/src/modules/kb/core/vector.js:78
    @auto @changed
    場景: 一次要刪除太多向量時停止同步
      # 向量庫與舊版共用:知識庫讀不到(空的)或一次要刪除超過現有 20%(至少 5 筆)時整次不同步
      假如 VECTOR_SYNC 為 1
      而且 向量庫有 10 筆、知識庫是空的
      當 同步向量庫
      那麼 不刪除任何 point
      而且 vector-status 的 error 說明超過安全上限

    # 來源: backend/src/modules/iplearn/core/iplearn.js:254
    @auto @changed
    場景: 管理者改過的自動學習筆記不覆寫
      # 舊版每次學習都覆寫同一則筆記;新版管理者拿掉「自動學習」標籤或修改過的筆記不覆寫(AGENT.md §7.4)
      假如 外部 IP 自動學習寫過某組織的筆記
      而且 管理者修改了那則筆記
      當 再次學習並 rewrite 為 true
      那麼 那則筆記不變
      而且 學習紀錄寫明「不覆寫」
