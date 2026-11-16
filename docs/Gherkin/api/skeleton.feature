# language: zh-TW
@B0 @B1
功能: netops-api 骨架、身分與權限
  為了讓 NetOps 只經 Gateway 提供服務、權限由 GigaItApp 統一管理
  身為 系統負責人
  我要一個只信任 BFF 內部 Token、每支 API 都宣告權限並自動註冊到 Gateway 的後端

  # 依據:ARCHITECTURE §2、§5、D1、D3、D15;AGENT.md §7.1、§8;Gateway BACKEND-GUIDE §4.2、§5.3、§6.1。
  # 「經 Gateway」的場景由 BFF 檢查登入與 x-permission,後端不重複實作;直連服務的場景由 netops-api 自己回應。

  Rule: 連線驗證 GET /api/netops/ping

    # 來源: backend/src/modules/ping/routes.ts:18
    @auto @e2e
    場景: 有權限的使用者取得自己的身分
      假如 使用者 S112009 已登入且擁有 "netops.ping.read"
      當 呼叫 GET /api/netops/ping
      那麼 回應 200
      而且 emp 為 "S112009",並帶出姓名、部門、角色、requestId 與 ISO 8601 時間

    # 來源: backend/src/modules/ping/routes.ts:24
    @e2e
    場景: 沒有權限時拒絕
      假如 使用者已登入但沒有 "netops.ping.read"
      當 呼叫 GET /api/netops/ping
      那麼 回應 403,code 為 "PERMISSION_DENIED"(BFF 回應)

    # 來源: backend/src/modules/ping/routes.ts:29
    @auto @security
    場景: 直連服務沒有內部 Token
      假如 呼叫端不經 Gateway
      當 呼叫 GET /v1/ping 且沒有 X-Internal-Token
      那麼 回應 401,code 為 "NETOPS_INTERNAL_TOKEN_INVALID"

  Rule: 內部 Token 與錯誤格式

    # 來源: backend/src/app.ts:75
    @auto @security
    場景: 對象、簽發者不符或過期的 Token 回 401
      當 以 aud 為其他服務、iss 不是 BFF、已過期或格式錯誤的 Token 呼叫 GET /v1/ping
      那麼 回應 401,code 為 "NETOPS_INTERNAL_TOKEN_INVALID"
      而且 回應格式為 { code, message, requestId },不含堆疊

    # 來源: backend/src/app.ts:109
    @auto
    場景: 健康檢查與 OpenAPI 不需 Token
      當 不帶 Token 呼叫 GET /healthz、GET /readyz、GET /openapi.json
      那麼 回應 200

    # 來源: backend/src/app.ts:109
    @auto
    場景: 資料目錄無法讀寫時尚未就緒
      假如 資料目錄無法寫入
      當 呼叫 GET /readyz
      那麼 回應 503,code 為 "NETOPS_NOT_READY"
      而且 回應不含資料目錄路徑

    # 來源: backend/src/app.ts:104
    @auto
    場景: 不存在的 API
      當 帶有效 Token 呼叫 GET /v1/nope
      那麼 回應 404,code 為 "NETOPS_NOT_FOUND"

    # 來源: backend/src/app.ts:99
    @auto @changed
    場景: 資料檔損壞時明確失敗
      # 舊版讀不到摘要時當成沒有資料;新版明確回報(AGENT.md §5「查無紀錄不等於沒有發生」)
      假如 某個資料檔內容損壞
      當 呼叫讀取它的 API
      那麼 回應 500,code 為 "NETOPS_DATA_CORRUPT"
      而且 訊息不含檔名與資料目錄路徑

  Rule: OpenAPI 與自動註冊

    # 來源: backend/test/unit/app.test.ts:46
    @auto
    場景: 每個 API 都列在 OpenAPI 並有說明、權限與 Gherkin
      當 讀取 /openapi.json
      那麼 根層 x-gateway 為 upstream "netops-api"、system "netops"、project "NetOps"
      而且 每個 operation 都有 operationId(netops.*)、summary、description、x-permission、x-gherkin
      而且 x-permission 都列在 x-permissions,讀取權限以 .read 結尾

  Rule: 權限(ARCHITECTURE §5;BFF 依 x-permission 檢查)

    # 來源: backend/src/openapi.ts:31
    @e2e @security
    場景大綱: 沒有登入或沒有權限時經 Gateway 被拒絕
      當 未登入呼叫 <方法> <路徑>
      那麼 回應 401,code 為 "UNAUTHENTICATED"(BFF 回應)
      當 已登入但沒有 "<權限>" 時呼叫 <方法> <路徑>
      那麼 回應 403,code 為 "PERMISSION_DENIED"(BFF 回應)

      例子:
        | 方法   | 路徑                                         | 權限               |
        | GET    | /api/netops/ping                             | netops.ping.read   |
        | GET    | /api/netops/pa/days                          | netops.pa.read     |
        | GET    | /api/netops/pa/overview?from=2026-11-02      | netops.pa.read     |
        | GET    | /api/netops/pa/options?from=2026-11-02       | netops.pa.read     |
        | GET    | /api/netops/pa-events/types                  | netops.pa.read     |
        | GET    | /api/netops/pa-events/overview?type=threat&from=2026-11-02 | netops.pa.read |
        | POST   | /api/netops/pa/log-searches                  | netops.pa-log.read |
        | GET    | /api/netops/pa/log-searches/{id}             | netops.pa-log.read |
        | GET    | /api/netops/pa/log-searches/{id}/rows        | netops.pa-log.read |
        | GET    | /api/netops/pa/log-searches/{id}/export      | netops.pa-log.read |
        | DELETE | /api/netops/pa/log-searches/{id}             | netops.pa-log.read |
        | GET    | /api/netops/ftp/pa/files                     | netops.ftp.read    |
        | GET    | /api/netops/ftp/pa/status                    | netops.ftp.read    |
        | POST   | /api/netops/ftp/pa/syncs                     | netops.ftp.write   |
        | POST   | /api/netops/ftp/pa/analyses                  | netops.ftp.write   |
        | DELETE | /api/netops/ftp/pa/analyses                  | netops.ftp.write   |
        | POST   | /api/netops/ftp/pa/result-deletions          | netops.ftp.write   |
        | POST   | /api/netops/ftp/ad/listings                  | netops.ftp.read    |
        | GET    | /api/netops/ftp/ad/listings/{id}             | netops.ftp.read    |
        | DELETE | /api/netops/ftp/ad/listings/{id}             | netops.ftp.read    |
        | GET    | /api/netops/ftp/ad/status                    | netops.ftp.read    |
        | POST   | /api/netops/ftp/ad/syncs                     | netops.ftp.write   |
        | POST   | /api/netops/ftp/ad/imports                   | netops.ftp.write   |
        | POST   | /api/netops/ftp/ad/result-deletions          | netops.ftp.write   |
        | GET    | /api/netops/ad/days                          | netops.ad.read     |
        | GET    | /api/netops/ad/overview?from=2026-11-02      | netops.ad.read     |
        | GET    | /api/netops/ad/events                        | netops.ad-log.read |
        | GET    | /api/netops/ad/events/export                 | netops.ad-log.read |
        | GET    | /api/netops/kb/notes                         | netops.kb.read     |
        | GET    | /api/netops/kb/notes/{id}                    | netops.kb.read     |
        | GET    | /api/netops/kb/notes/{id}/markdown           | netops.kb.read     |
        | GET    | /api/netops/kb/compilation                   | netops.kb.read     |
        | POST   | /api/netops/kb/notes                         | netops.kb.write    |
        | PUT    | /api/netops/kb/notes/{id}                    | netops.kb.write    |
        | DELETE | /api/netops/kb/notes/{id}                    | netops.kb.write    |

    # 來源: backend/src/openapi.ts:31
    @e2e @changed
    場景: 新權限預設沒有人擁有
      # 舊版 .env 的 VIEW_USERS / VIEW_DEPTS 空白時開放全部在職員工;新版不沿用(D15)
      假如 系統剛上線、負責人尚未在 GigaItApp 指派 netops-admin 或 netops-viewer
      當 任何已登入的使用者呼叫 GET /api/netops/pa/days
      那麼 回應 403,code 為 "PERMISSION_DENIED"

  Rule: 設定(AGENT.md §6;缺少必要設定時啟動失敗)

    # 來源: backend/src/config.ts:116
    @auto
    場景: 測試區與正式區缺少資料目錄或 FTP 設定時啟動失敗
      假如 GW_ENV 為 "test"
      當 沒有設定 NETOPS_DATA_DIR,或 FTP_HOST、FTP_USER、FTP_PASSWORD_FILE 任一項
      那麼 啟動失敗,錯誤訊息列出缺少的項目

    # 來源: backend/src/config.ts:98
    @auto @security @changed
    場景: 正式區只接受機密檔
      # 舊版密碼寫在 .env;新版機密一律以 *_FILE 指向 Docker secret(AGENT.md §7.5)
      假如 GW_ENV 為 "prod"
      當 設定了明文 FTP_PASSWORD(即使同時設定 FTP_PASSWORD_FILE)或 FTP_TLS_INSECURE=1
      那麼 啟動失敗

    # 來源: backend/src/config.ts:138
    @auto
    場景: 匯入目錄必須在 FTP 根目錄之下
      假如 FTP_ROOT 為 "/my-data"
      當 FTP_LOG_DIR 為 "/other" 或 FTP_AD_DIR 為 "/my-data/../etc"
      那麼 啟動失敗
