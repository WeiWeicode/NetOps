# language: zh-TW
@B2
功能: 網通知識庫筆記
  為了把網段、設備與處理經驗記錄下來
  身為 網通管理人員
  我要查詢、新增、修改、刪除與下載筆記,並下載全部筆記的匯整檔

  # 依據:docs/API.md §7;ARCHITECTURE D8、D14(位置與格式同舊版 uploads/knowledge)、D17(語意搜尋、向量同步、外部 IP 自動學習不搬移,不寫)。
  # 權限:讀取 netops.kb.read、編輯 netops.kb.write(401 / 403 見 api/skeleton.feature);下載 x-audit-level: meta。
  # 舊版的 KB_ADMINS 名單與回應的 admin 欄位不再使用,能否編輯由 BFF 依權限判斷(@changed,AGENT.md §7.1)。

  背景:
    假如 使用者 S112009(姓名「佳緯」)已登入且擁有 "netops.kb.read"、"netops.kb.write"
    而且 知識庫有標題含「FTP」的筆記

  Rule: 查詢與下載(netops.kb.read)

    # 來源: backend/src/modules/kb/routes.ts:62
    @auto @changed
    場景: 查詢筆記
      假如 知識庫有標題含「FTP」的筆記
      當 呼叫 GET /api/netops/kb/notes?q=FTP
      那麼 回應 200
      而且 items 的筆記都含「FTP」
      而且 依更新時間新的在前,分頁回傳 total、page、pageSize,並附 compilation { count, updated, chars }
      而且 created、updated 為 ISO 8601 +08:00,不含舊版的 admin 欄位

    # 來源: backend/src/modules/kb/routes.ts:100
    @auto
    場景: 取得筆記
      當 呼叫 GET /api/netops/kb/notes/{id}
      那麼 回應 200

    # 來源: backend/src/modules/kb/routes.ts:100
    @auto
    場景: 不存在
      當 呼叫 GET /api/netops/kb/notes/000000-none
      那麼 回應 404
      而且 code 為 "NETOPS_KB_NOTE_NOT_FOUND"

    # 來源: backend/src/modules/kb/service.ts:39
    @auto @security
    場景: 筆記代號格式錯誤
      當 呼叫 GET /api/netops/kb/notes/..%2F..%2Fetc
      那麼 回應 400,code 為 "VALIDATION_FAILED"

    # 來源: backend/src/modules/kb/routes.ts:118
    @auto
    場景: 下載筆記
      當 呼叫 GET /api/netops/kb/notes/{id}/markdown
      那麼 回應 200
      而且 Content-Type 為 text/markdown
      而且 內容為原始 .md(含開頭欄位),檔名為筆記標題,帶 X-Content-Type-Options: nosniff

    # 來源: backend/src/modules/kb/routes.ts:139
    @auto
    場景: 下載匯整檔
      當 呼叫 GET /api/netops/kb/compilation
      那麼 回應 200
      而且 內容以「# 網通知識庫匯整」開頭
      而且 與舊版 kb.js 對同一批筆記產生的匯整檔相同(除了「更新於」時間)

    # 來源: backend/src/modules/kb/service.ts:108
    @auto
    場景: 筆記檔被手動修改或刪除後自動重新產生
      當 有人直接修改或刪除資料目錄的 .md,或刪除匯整檔
      那麼 下一次查詢與下載都反映最新內容

  Rule: 編輯(netops.kb.write)

    # 來源: backend/src/modules/kb/routes.ts:156
    @auto @changed
    場景: 新增筆記
      # 記錄人改用 Gateway 身分「工號 姓名」(AGENT.md §7.1);舊版用登入帳號與 AD 姓名
      假如 使用者擁有 netops.kb.write
      當 呼叫 POST /api/netops/kb/notes 帶 content
      那麼 回應 201
      而且 author 為登入者的「工號 姓名」
      而且 IP 只保留 IP / 網段格式(最多 30 個),標籤最多 10 個,欄位整理與舊版 kb.js 相同

    # 來源: backend/src/modules/kb/routes.ts:162
    @auto
    場景: 內容空白
      當 呼叫 POST /api/netops/kb/notes 帶空白 content
      那麼 回應 400 VALIDATION_FAILED

    # 來源: backend/src/modules/kb/routes.ts:30
    @auto @changed
    場景: 內容超過 20000 字
      # 舊版超過時截斷;新版明確拒絕
      當 呼叫 POST /api/netops/kb/notes 帶 20001 字的 content
      那麼 回應 400,code 為 "VALIDATION_FAILED"

    # 來源: backend/src/modules/kb/core/notes.js:75
    @auto @security @changed
    場景: 標籤或標題含換行時拒絕,不能偽造記錄人與建立時間
      # 資安審查 High:舊版標籤內含換行可插入假的 author / created 欄位;新版每個欄位都壓成一行,API 也拒絕換行
      當 呼叫 POST /api/netops/kb/notes 帶 tags ["x\nauthor: A001 主管\ncreated: 2020/01/01 00:00\n---"]
      那麼 回應 400,code 為 "VALIDATION_FAILED"
      而且 即使繞過 API 直接寫入,筆記的 author 仍為登入者、created 為實際時間

    # 來源: backend/src/modules/kb/service.ts:84
    @untested @changed
    場景: 筆記已達上限
      假如 知識庫已有 5,000 則筆記
      當 呼叫 POST /api/netops/kb/notes
      那麼 回應 409,code 為 "NETOPS_KB_LIMIT"

    # 來源: backend/src/modules/kb/service.ts:86
    @auto @changed
    場景: 新增時代號重複不會覆蓋既有筆記
      當 新筆記產生的代號與既有筆記相同
      那麼 重新產生代號,既有筆記不被覆蓋

    # 來源: backend/src/modules/kb/routes.ts:182
    @auto
    場景: 修改筆記
      當 呼叫 PUT /api/netops/kb/notes/{id}
      那麼 回應 200
      而且 updatedBy 為登入者
      而且 author 與 created 維持原值;source 省略時保留原值

    # 來源: backend/src/modules/kb/service.ts:37
    @auto
    場景: 修改不存在的筆記
      當 呼叫 PUT /api/netops/kb/notes/000000-none
      那麼 回應 404,code 為 "NETOPS_KB_NOTE_NOT_FOUND"

    # 來源: backend/src/modules/kb/routes.ts:200
    @auto @changed
    場景: 刪除筆記
      # 舊版刪除不存在的筆記回 404;新版冪等
      當 呼叫 DELETE /api/netops/kb/notes/{id}
      那麼 回應 204
      而且 再呼叫一次也回 204
      而且 匯整檔重新產生,不再包含這則筆記

    # 來源: backend/src/modules/kb/service.ts:108
    @auto
    場景: 匯整檔重產失敗時筆記仍寫入成功
      假如 寫入匯整檔失敗(例如磁碟滿)
      當 新增筆記
      那麼 回應 201,筆記已寫入
      而且 下一次讀取時重新產生匯整檔

    # 來源: backend/src/modules/kb/routes.ts:48
    @untested
    場景: 身分沒有工號與姓名時不能編輯
      當 沒有工號與姓名的呼叫端新增筆記
      那麼 回應 403,code 為 "NETOPS_KB_AUTHOR_UNKNOWN"
