-- netops-clickhouse 資料表(C1;docs/PA-LOG-CLICKHOUSE-GUIDE.md §7)。由 deploy/clickhouse/apply-schema.sh 依部署區代入 TTL 後執行。
--   {{TTL_TRAFFIC}}     原始 TRAFFIC        測試區 3 DAY、正式區 30 DAY(CQ2、CQ12)
--   {{TTL_THREAT}}      威脅類              測試區 3 DAY、正式區 90 DAY
--   {{TTL_HOURLY_APP}}  每小時彙總(App)   測試區 3 DAY、正式區 13 MONTH
--   {{TTL_HOURLY_SRC}}  每小時彙總(來源)  測試區 3 DAY、正式區 90 DAY
-- 全部 IF NOT EXISTS,可重複執行;TTL 變更由 apply-schema.sh 另外 MODIFY TTL。
-- 已建立的表要改欄位(C2 起)另寫 migration,不要直接改這裡。

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
    source         LowCardinality(String),  -- 'syslog' | 'ftp'

    INDEX idx_dst   dst   TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_dport dport TYPE set(256)  GRANULARITY 4,
    INDEX idx_app   app   TYPE set(512)  GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (toStartOfHour(event_time), src, event_time)
TTL event_time + INTERVAL {{TTL_TRAFFIC}} DELETE
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
    source        LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (log_type, toStartOfHour(event_time), src, event_time)
TTL event_time + INTERVAL {{TTL_THREAT}} DELETE
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
TTL hour + INTERVAL {{TTL_HOURLY_APP}} DELETE;

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
TTL hour + INTERVAL {{TTL_HOURLY_SRC}} DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_traffic_hourly_src_mv
TO netops.pa_traffic_hourly_src AS
SELECT toStartOfHour(event_time) AS hour, src, action, count() AS sessions, sum(bytes) AS bytes
FROM netops.pa_traffic_logs
GROUP BY hour, src, action;
