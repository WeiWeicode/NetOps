# language: zh-TW
@C5
功能: PA 精準查詢(XML API log 與 Session Browser)
  為了核對「Syslog 還沒到、或 ClickHouse 有缺口」的最近幾分鐘,以及看某個 IP 當下的連線
  身為 網通管理人員(netops-admin)
  我要對 PA-560 查單一 IP 的最近 log 或當下 Session,而且不能讓 PA-560 管理平面負擔過重

  # 依據:docs/API.md §3.3;ARCHITECTURE D31、CQ6、CQ7;PA-LOG-CLICKHOUSE-GUIDE §9;IMPL-PLAN C0 E4 結果(15 分鐘、500 筆、60 秒、一次一個、CPU > 50% 不送)。
  # 權限:netops.pa-query.read 只給 netops-admin(按鈕 netops.pa-live.query);netops-viewer 呼叫由 BFF 回 403(api/skeleton.feature)。
  # PA-560 端(netops-pa 執行者:參數再驗、CPU 取樣、逾時取消)的測試在 pa-collector/tests/test_pa_query.py。

  背景:
    假如 使用者已登入且擁有 "netops.pa-query.read"
    而且 netops-pa 已開查詢執行者(PA_QUERY_ENABLED=1;測試區預設關閉)

  # 來源: backend/src/modules/pa-query/routes.ts:39
  @auto
  場景: 查詢 PA 精準查詢狀態
    當 管理員呼叫 GET /api/netops/pa-query/status
    那麼 回應 200
    而且 回應含 enabled、activeSec、userCoolSec、mgmtCpu

  # 來源: backend/src/modules/pa-query/routes.ts:58
  @auto
  場景: 送出 PA 精準查詢
    假如 netops-pa 已開查詢執行者,沒有其他查詢在執行
    當 管理員呼叫 POST /api/netops/pa-query/jobs 帶 kind "session" 與 ip "10.10.130.124"
    那麼 回應 202 與工作 id

  # 來源: backend/src/modules/pa-query/routes.ts:63
  @auto
  場景: 同時第 2 個查詢
    假如 已有 PA 精準查詢在執行
    當 另一位管理員呼叫 POST /api/netops/pa-query/jobs
    那麼 回應 429 NETOPS_PA_QUERY_BUSY
    而且 回應標頭有 Retry-After

  # 來源: backend/src/modules/pa-query/routes.ts:69
  @auto
  場景: 時間視窗超過 15 分鐘
    當 呼叫 POST /api/netops/pa-query/jobs 帶 kind "log" 且 to − from 為 16 分鐘
    那麼 回應 400 VALIDATION_FAILED

  # 來源: backend/src/modules/pa-query/routes.ts:73
  @auto
  場景: 管理平面 CPU 過高
    假如 PA-560 最新的管理平面 CPU 為 60%
    當 呼叫 POST /api/netops/pa-query/jobs
    那麼 回應 429 NETOPS_PA_QUERY_BUSY,不送出查詢

  # 來源: backend/src/modules/pa-query/routes.ts:78
  @auto
  場景: 查詢執行者未啟用
    假如 netops-pa 沒有開查詢執行者
    當 呼叫 POST /api/netops/pa-query/jobs
    那麼 回應 409 NETOPS_PA_QUERY_DISABLED

  # 來源: backend/src/modules/pa-query/routes.ts:115
  @auto
  場景: 查詢 PA 精準查詢結果
    假如 管理員送出的查詢已完成
    當 呼叫 GET /api/netops/pa-query/jobs/{id}
    那麼 回應 200,status 為 "done",result.rows 為查到的紀錄

  # 來源: backend/src/modules/pa-query/routes.ts:120
  @auto
  場景: 別人的 PA 查詢
    當 另一位使用者查詢同一個 id
    那麼 回應 404 NETOPS_PA_QUERY_NOT_FOUND

  # 來源: pa-collector/tests/test_pa_query.py:1
  @auto
  場景: 執行者送出前取樣管理平面 CPU,逾時取消 PA 上的工作
    假如 工作已排入佇列
    當 netops-pa 取出工作
    那麼 先確認名額仍屬於這個工作、參數再驗一次
    而且 管理平面 CPU 超過 50% 時不送,工作標 rejected
    而且 log 工作超過 60 秒時送 action=finish 取消,工作標 failed NETOPS_PA_QUERY_TIMEOUT
    而且 API Key 只放在 X-PAN-KEY 標頭,不出現在網址、內容與錯誤訊息
