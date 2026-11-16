-- 升級測試用(CI check:ingest-int,deploy/clickhouse/test-upgrade.sh):V-a 合併前(e0a8e79,2026-11-11)測試區的 schema。
-- 內容 = 當時的 schema.sql(TTL 代入測試區 3 DAY)+ migrations/001、002。不要修改:它代表已經在測試區 / 正式區跑過的舊版。

-- netops-clickhouse 資料表(C1;docs/PA-LOG-CLICKHOUSE-GUIDE.md §7)。由 deploy/clickhouse/apply-schema.sh 依部署區代入 TTL 後執行。
--   3 DAY     原始 TRAFFIC        測試區 3 DAY、正式區 30 DAY(CQ2、CQ12)
--   3 DAY      威脅類              測試區 3 DAY、正式區 90 DAY
--   3 DAY  每小時彙總(App)   測試區 3 DAY、正式區 13 MONTH
--   3 DAY  每小時彙總(來源)  測試區 3 DAY、正式區 90 DAY
-- 全部 IF NOT EXISTS,可重複執行;TTL 變更由 apply-schema.sh 另外 MODIFY TTL。
-- 已建立的表要改欄位(C2 起)另寫 migration(deploy/clickhouse/migrations/),不要直接改這裡。

CREATE DATABASE IF NOT EXISTS netops;

CREATE TABLE IF NOT EXISTS netops.pa_traffic_logs
(
    event_time     DateTime('Asia/Taipei')        CODEC(DoubleDelta, ZSTD(1)), -- $receive_time / CSV Receive Time
    received_at    DateTime64(3, 'Asia/Taipei')   CODEC(DoubleDelta, ZSTD(1)), -- netops-pa 收到時間(Stream ID);FTP 匯入時同 event_time
    seqno          UInt64 DEFAULT 0,                                              -- $seqno / CSV Sequence Number(CQ9)
    session_id     UInt32 DEFAULT 0,                                              -- $sessionid / CSV Session ID(CQ9)
    subtype        LowCardinality(String),
    src            IPv6,                     -- IPv4 存成 ::ffff:a.b.c.d
    dst            IPv6,
    nat_src        IPv6,
    nat_dst        IPv6,
    sport          UInt16,
    dport          UInt16,
    nat_dport      UInt16,
    proto          LowCardinality(String),
    rule           LowCardinality(String),
    src_user       LowCardinality(String),
    app            LowCardinality(String),
    from_zone      LowCardinality(String),
    to_zone        LowCardinality(String),
    in_if          LowCardinality(String),
    out_if         LowCardinality(String),
    action         LowCardinality(String),
    bytes          UInt64 CODEC(T64, ZSTD(1)),
    bytes_sent     UInt64 CODEC(T64, ZSTD(1)),
    bytes_recv     UInt64 CODEC(T64, ZSTD(1)),
    packets        UInt64 CODEC(T64, ZSTD(1)),
    session_start  DateTime('Asia/Taipei') CODEC(DoubleDelta, ZSTD(1)),
    elapsed        UInt32 CODEC(T64, ZSTD(1)),
    category       LowCardinality(String),
    src_country    LowCardinality(String),
    dst_country    LowCardinality(String),
    end_reason     LowCardinality(String),
    app_risk       UInt8,
    app_category   LowCardinality(String),
    app_subcat     LowCardinality(String),
    app_tech       LowCardinality(String),
    src_host       String CODEC(ZSTD(3)),
    dst_host       String CODEC(ZSTD(3)),
    source         LowCardinality(String),  -- 'syslog'(netops-ingest)| 'ftp'(補漏)

    INDEX idx_dst   dst   TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_dport dport TYPE set(256)  GRANULARITY 4,
    INDEX idx_app   app   TYPE set(512)  GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (toStartOfHour(event_time), src, event_time)
TTL event_time + INTERVAL 3 DAY DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1,
         non_replicated_deduplication_window = 1000;  -- 讓 insert_deduplication_token 生效(手冊 §6.6)

CREATE TABLE IF NOT EXISTS netops.pa_threat_logs
(
    event_time    DateTime('Asia/Taipei')      CODEC(DoubleDelta, ZSTD(1)),
    received_at   DateTime64(3, 'Asia/Taipei') CODEC(DoubleDelta, ZSTD(1)),
    seqno         UInt64 DEFAULT 0,
    log_type      LowCardinality(String),  -- 'threat' | 'url' | 'data' | 'wildfire'
    subtype       LowCardinality(String),
    src           IPv6,
    dst           IPv6,
    nat_src       IPv6,
    nat_dst       IPv6,
    rule          LowCardinality(String),
    src_user      LowCardinality(String),
    app           LowCardinality(String),
    from_zone     LowCardinality(String),
    to_zone       LowCardinality(String),
    dport         UInt16,
    proto         LowCardinality(String),
    action        LowCardinality(String),
    url           String CODEC(ZSTD(3)),
    name          String CODEC(ZSTD(3)),   -- $threatid,例如 generic:xxx(52316871)
    category      LowCardinality(String),
    severity      LowCardinality(String),
    direction     LowCardinality(String),
    src_country   LowCardinality(String),
    dst_country   LowCardinality(String),
    repeat_count  UInt32,
    thr_category  LowCardinality(String),
    file_digest   String CODEC(ZSTD(3)),
    file_type     LowCardinality(String),
    source        LowCardinality(String)   -- 'http'(netops-ingest)| 'ftp'(補漏);session_id、sport、nat_dport 見 migrations/001
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (log_type, toStartOfHour(event_time), src, event_time)
TTL event_time + INTERVAL 3 DAY DELETE
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 1000;

-- 每小時彙總:依 App / 動作 / 區域(流量總覽、趨勢)。SummingMergeTree 查詢一定要 sum() + GROUP BY
CREATE TABLE IF NOT EXISTS netops.pa_traffic_hourly_app
(
    hour       DateTime('Asia/Taipei'),
    action     LowCardinality(String),
    app        LowCardinality(String),
    from_zone  LowCardinality(String),
    to_zone    LowCardinality(String),
    sessions   UInt64,
    bytes      UInt64,
    packets    UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, action, app, from_zone, to_zone)
TTL hour + INTERVAL 3 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_traffic_hourly_app_mv
TO netops.pa_traffic_hourly_app AS
SELECT
    toStartOfHour(event_time) AS hour,
    action, app, from_zone, to_zone,
    count()       AS sessions,
    sum(bytes)    AS bytes,
    sum(packets)  AS packets
FROM netops.pa_traffic_logs
GROUP BY hour, action, app, from_zone, to_zone;

-- 每小時彙總:依來源 IP(Top N 來源)
CREATE TABLE IF NOT EXISTS netops.pa_traffic_hourly_src
(
    hour      DateTime('Asia/Taipei'),
    src       IPv6,
    action    LowCardinality(String),
    sessions  UInt64,
    bytes     UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, action, src)
TTL hour + INTERVAL 3 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_traffic_hourly_src_mv
TO netops.pa_traffic_hourly_src AS
SELECT toStartOfHour(event_time) AS hour, src, action, count() AS sessions, sum(bytes) AS bytes
FROM netops.pa_traffic_logs
GROUP BY hour, src, action;

-- C2(2026-11-10):pa_threat_logs 補欄位。
--   session_id   $sessionid(CQ9 例外,和 pa_traffic_logs 相同;FTP 補漏逐筆去重)
--   sport        來源 Port(2026-11-10 威脅類 payload 補的 $sport)
--   nat_dport    目的 NAT Port($natdport)
-- migrations/ 由 apply-schema.sh 在 schema.sql 之後依檔名順序每次執行:每個檔都必須可重複執行(IF NOT EXISTS / IF EXISTS)。
ALTER TABLE netops.pa_threat_logs
    ADD COLUMN IF NOT EXISTS session_id UInt32 DEFAULT 0 AFTER seqno,
    ADD COLUMN IF NOT EXISTS sport UInt16 DEFAULT 0 AFTER to_zone,
    ADD COLUMN IF NOT EXISTS nat_dport UInt16 DEFAULT 0 AFTER dport;

-- C2(2026-11-11):每小時彙總表開去重視窗。
-- netops-ingest 重送同一批時,來源表依 insert_deduplication_token 略過;26.x 仍會把區塊推給物化檢視,
-- 寫入端帶 deduplicate_blocks_in_dependent_materialized_views=1 讓目標表用衍生 token 去重,目標表要有視窗才生效
-- (CI 整合測試:不設時同一 token 重送,原始表 2 筆、彙總 4)。
-- 注意:有視窗後,不帶 token 的寫入會依區塊內容雜湊去重;手動重建彙總(dedupe-day.sh)要帶 insert_deduplicate = 0。
-- migrations/ 由 apply-schema.sh 每次依序執行:必須可重複執行(MODIFY SETTING 重複執行沒有影響)。
ALTER TABLE netops.pa_traffic_hourly_app MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE netops.pa_traffic_hourly_src MODIFY SETTING non_replicated_deduplication_window = 1000;
