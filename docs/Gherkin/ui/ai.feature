# language: zh-TW
@A1
功能: AI 畫面
  為了在新版直接使用 AI 分析與問答(取消 AI 中控台,ARCHITECTURE D23)
  身為 MIS 人員
  我要在流量總覽、AI 問答與知識庫頁使用 AI,不再連到舊版 NetOps

  # 依據:IMPL-PLAN A1、API.md §10、UI-GUIDE §3。舊版 src/views/PaAsk.vue、src/components/{AiAnalysis,TranslateBox}.vue、src/views/Knowledge.vue。
  # 來源標示分支 feature/a1-ai-frontend;前端只是體驗,BFF 一定再以 netops.ai.use / netops.kb.write 檢查。

  Rule: 串流請求

    # 來源: frontend/src/api/ai.ts:79(feature/a1-ai-frontend)
    @auto @security
    場景: AI 串流以 POST 帶 CSRF,不帶 Token
      當 畫面送出 AI 問答或分析
      那麼 以 fetch POST 到 /api/netops/ai/*,帶 Cookie 與 X-CSRF-Token,沒有 Authorization
      而且 略過 open 與 heartbeat 事件,依序處理其餘事件
      而且 收到 error 事件時顯示錯誤訊息;串流開始前的 4xx(例如 429)顯示 message

    # 來源: frontend/src/composables/aiChat.ts:68(feature/a1-ai-frontend)
    @auto
    場景: 問答顯示查詢進度與查到的資料
      當 AI 問答收到 meta、scan、evidence、notes、content、done
      那麼 依序顯示「查詢 IP 的 log」「掃描 log n / m 個檔」「AI 分析中」「AI 撰寫中」
      而且 evidence 的 partial 為 true 時標示「掃描逾時,資料不完整」
      而且 notes 的 vectorError 為 true 時標示「語意搜尋失敗,筆記改用關鍵字與 IP 比對」

  Rule: 權限與入口

    # 來源: frontend/src/pages/ai/Ask.vue:27(feature/a1-ai-frontend)
    @manual
    場景: 沒有使用 AI 的按鈕權限
      假如 使用者有 "netops.pa-ask.read" 但沒有 "netops.pa-ask.use"
      當 開啟 /netops/firewall/ask
      那麼 顯示「沒有使用 AI 問答的權限」,輸入框與送出按鈕停用

    # 來源: frontend/src/pages/firewall/Dashboard.vue:203(feature/a1-ai-frontend)
    @manual
    場景: 流量總覽的 AI 分析
      假如 使用者有 "netops.pa-dashboard.ai"
      而且 期間內有已分析的檔案
      當 按「AI 分析」並開始分析
      那麼 對話框串流顯示分析結果,摘要讀不到的檔案數大於 0 時提示資料不完整

    # 來源: frontend/src/config/links.ts:7(feature/a1-ai-frontend)
    @auto @changed
    場景: 不再連到舊版 NetOps
      # 舊版選單的「AI 問答(舊版)」、流量總覽「AI 分析(舊版)」、知識庫「語意搜尋 / 自動學習(舊版)」都改成新版畫面
      那麼 一般連結只有 Veeam
      而且 安全事件頁點 IP 會到新版 AI 問答並帶入問題,由使用者送出

  Rule: 知識庫

    # 來源: frontend/src/pages/knowledge/Knowledge.vue:48(feature/a1-ai-frontend)
    @manual
    場景: 語意搜尋
      假如 向量庫已啟用
      當 勾選「語意搜尋」並輸入關鍵字查詢
      那麼 依相近度排序並顯示相近度
      而且 向量庫只搜尋不同步時註明「只搜尋、不同步(與舊版共用)」

    # 來源: frontend/src/components/IpLearning.vue:38(feature/a1-ai-frontend)
    @manual
    場景: 外部 IP 自動學習
      假如 使用者有 "netops.kb-page.write"
      當 在「外部 IP 自動學習」按「立即學習」
      那麼 每 2 秒更新進度與紀錄,完成後重新整理知識庫清單
      但是 沒有編輯權限的人只看得到狀態
