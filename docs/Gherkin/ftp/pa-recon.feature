# language: zh-TW
@C3
功能: FTP 與 ClickHouse 每日對帳、補漏
  為了確認 ClickHouse 收到的 PA TRAFFIC log 沒有遺漏(Syslog 不是無遺失管道)
  身為 網通管理人員
  我要每天比對 FTP 與 ClickHouse 每小時的筆數,並把缺口從 FTP 補回 ClickHouse

  # 依據:docs/API.md §5.3;ARCHITECTURE D33、D34;手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §11、§12 CQ10(並行對帳 2 週後切換明細來源)。
  # 權限:查詢 netops.ftp.read、執行對帳與補漏 netops.ftp.write(401 / 403 見 api/skeleton.feature)。

  背景:
    假如 使用者已登入且擁有 "netops.ftp.read" 與 "netops.ftp.write"
    而且 2026-11-12 的 FTP TRAFFIC 檔已同步分析完

  # 來源: backend/src/modules/pa/recon-routes.ts:49
  @auto
  場景: 查詢對帳結果
    假如 2026-11-12 已對帳
    當 呼叫 GET /api/netops/pa/reconciliations?from=2026-11-12
    那麼 回應 200
    而且 days 第一筆的 day 為 "2026-11-12",hours 每筆有 ftp、ch、diff、status

  # 來源: backend/src/modules/pa/recon-routes.ts:69
  @auto
  場景: 立即對帳
    當 呼叫 POST /api/netops/pa/reconciliations 帶 day "2026-11-12"
    那麼 回應 200
    而且 status 為 ok、gap、pending 或 not-covered

  # 來源: backend/src/modules/pa/reconcile.ts:46
  @auto
  場景: 差異超過 0.5% 的小時是缺口
    假如 2026-11-12 01 時 FTP 有 1000 筆、ClickHouse 有 990 筆
    當 對帳 2026-11-12
    那麼 01 時的 status 為 "gap",diff 為 0.01
    而且 ClickHouse 比 FTP 多 0.5% 以上的小時為 "excess",FTP 沒有的小時為 "ftp-missing"
    而且 ClickHouse 開始收資料之前的小時不比

  # 來源: backend/src/modules/pa/reconcile.ts:107
  @auto
  場景: FTP 還沒同步分析完時不判斷缺口
    假如 2026-11-13 的 FTP 檔還沒涵蓋到隔天
    當 呼叫 POST /api/netops/pa/reconciliations 帶 day "2026-11-13"
    那麼 status 為 "pending"
    而且 呼叫 POST /api/netops/pa/backfills 帶 day "2026-11-13" 回應 409 NETOPS_RECON_PENDING

  # 來源: backend/src/modules/pa/reconcile.ts:134
  @untested
  場景: 每天自動對帳前 3 天
    假如 NETOPS_RECON_HOUR 為 6
    當 台灣時間過了 06:00
    那麼 對帳前 3 天並存檔;有缺口時服務日誌記 warn

  # 來源: backend/src/modules/pa/recon-routes.ts:90
  @auto
  場景: 送出補漏
    假如 2026-11-12 對帳有缺口
    當 呼叫 POST /api/netops/pa/backfills 帶 day "2026-11-12"
    那麼 回應 202
    而且 之後 GET /api/netops/pa/backfills/{id} 的 state 會變成 "done",inserted 為補寫的筆數

  # 來源: backend/src/modules/pa/recon-routes.ts:96
  @auto
  場景: 沒有缺口
    當 呼叫 POST /api/netops/pa/backfills 的那天沒有缺口
    那麼 回應 409 NETOPS_BACKFILL_NOTHING

  # 來源: backend/src/ingest/backfill.ts:99
  @auto
  場景: 補漏只寫 ClickHouse 沒有的列
    假如 01 時 ClickHouse 已有 seqno 1–5,FTP 有 seqno 1–8 與 1 筆沒有 seqno
    當 netops-ingest 執行補漏工作
    那麼 只補寫 seqno 6–8(source 為 "ftp"),skipped 為 5、noSeqno 為 1
    而且 再執行一次 inserted 為 0(不重複)
    而且 不刪除 ClickHouse 既有的資料

  # 來源: backend/src/modules/pa/recon-routes.ts:152
  @auto
  場景: 查詢補漏工作
    當 呼叫 GET /api/netops/pa/backfills/{id}
    那麼 回應 200
    而且 回應含 state、read、skipped、inserted

  # 來源: backend/src/modules/pa/recon-routes.ts:31
  @auto
  場景: ClickHouse 無法使用
    假如 ClickHouse 連不上
    當 呼叫 POST /api/netops/pa/reconciliations 帶 day "2026-11-12"
    那麼 回應 503 NETOPS_CLICKHOUSE_UNAVAILABLE
