-- netops-clickhouse 資料表(C1;docs/PA-LOG-CLICKHOUSE-GUIDE.md §7)。由 deploy/clickhouse/apply-schema.sh 依部署區代入 TTL 後執行。
--   {{TTL_TRAFFIC}}     原始 TRAFFIC        測試區 3 DAY、正式區 30 DAY(CQ2、CQ12)
--   {{TTL_THREAT}}      威脅類              測試區 3 DAY、正式區 90 DAY
--   {{TTL_HOURLY_APP}}  每小時彙總(App)   測試區 3 DAY、正式區 13 MONTH
--   {{TTL_HOURLY_SRC}}  每小時彙總(來源)  測試區 3 DAY、正式區 90 DAY
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
    source        LowCardinality(String)   -- 'http'(netops-ingest)| 'ftp'(補漏);session_id、sport、nat_dport 見 migrations/001
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
    bytes     UInt64,
    bytes_sent UInt64 DEFAULT 0,  -- V-a(migrations/003)
    bytes_recv UInt64 DEFAULT 0
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, action, src)
TTL hour + INTERVAL {{TTL_HOURLY_SRC}} DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_traffic_hourly_src_mv
TO netops.pa_traffic_hourly_src AS
SELECT toStartOfHour(event_time) AS hour, src, action, count() AS sessions, sum(bytes) AS bytes,
       sum(bytes_sent) AS bytes_sent, sum(bytes_recv) AS bytes_recv
FROM netops.pa_traffic_logs
GROUP BY hour, src, action;

-- 熱力圖彙總(V-a;docs/VIZ-RULES-DESIGN.md §3.1–§3.3、ARCHITECTURE D34):不分維度,每個時間格一列;只存總數與 Top IP(topK,近似)
--   {{TTL_HEAT_5M}}  每 5 分鐘  測試區 3 DAY、正式區 1 YEAR(V1)
--   {{TTL_HEAT_1H}}  每小時     測試區 3 DAY、正式區 5 YEAR
--   {{TTL_HEAT_1D}}  每天       測試區 3 DAY、正式區 5 YEAR
-- AggregatingMergeTree 只在背景合併:查詢一定要 sum() / -Merge + GROUP BY bucket。
-- 每個粒度兩個 MV(TRAFFIC、威脅)寫同一張表,沒寫到的欄位是 0 / 空的聚合狀態;三個粒度各自從原始表算(不串接)。
-- MV 一律用表別名 l 引用來源欄位:輸出別名和來源欄位同名(sum(bytes) AS bytes)時,同一個 SELECT 裡其他地方的 bytes
--   會被解析成別名(26.3:ILLEGAL_AGGREGATION);輸出別名不能改(TO 表依欄位名稱對應)。
-- 去重視窗同 migrations/002:netops-ingest 重送時 MV 用衍生 token 去重;手動重建(rebuild-day.sh)要帶 insert_deduplicate = 0。
CREATE TABLE IF NOT EXISTS netops.pa_heat_5m
(
    bucket        DateTime('Asia/Taipei'),
    sessions      SimpleAggregateFunction(sum, UInt64),
    bytes         SimpleAggregateFunction(sum, UInt64),
    bytes_sent    SimpleAggregateFunction(sum, UInt64),
    bytes_recv    SimpleAggregateFunction(sum, UInt64),
    deny          SimpleAggregateFunction(sum, UInt64),   -- action != 'allow'
    thr_critical  SimpleAggregateFunction(sum, UInt64),   -- log_type = 'threat' 的筆數(不乘 repeat_count,X9)
    thr_high      SimpleAggregateFunction(sum, UInt64),
    thr_medium    SimpleAggregateFunction(sum, UInt64),
    thr_low       SimpleAggregateFunction(sum, UInt64),
    thr_info      SimpleAggregateFunction(sum, UInt64),
    top_bytes_src AggregateFunction(topKWeighted(3), IPv6, UInt64),
    top_deny_src  AggregateFunction(topKIf(3), IPv6, UInt8),
    top_thr_src   AggregateFunction(topKIf(3), IPv6, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY bucket
TTL bucket + INTERVAL {{TTL_HEAT_5M}} DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS netops.pa_heat_1h AS netops.pa_heat_5m
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY bucket
TTL bucket + INTERVAL {{TTL_HEAT_1H}} DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS netops.pa_heat_1d AS netops.pa_heat_5m
ENGINE = AggregatingMergeTree
PARTITION BY toYear(bucket)
ORDER BY bucket
TTL bucket + INTERVAL {{TTL_HEAT_1D}} DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_heat_5m_traffic_mv TO netops.pa_heat_5m AS
SELECT toStartOfFiveMinutes(l.event_time) AS bucket, count() AS sessions, sum(l.bytes) AS bytes, sum(l.bytes_sent) AS bytes_sent,
       sum(l.bytes_recv) AS bytes_recv, countIf(l.action != 'allow') AS deny,
       topKWeightedState(3)(l.src, l.bytes) AS top_bytes_src, topKIfState(3)(l.src, l.action != 'allow') AS top_deny_src
FROM netops.pa_traffic_logs AS l GROUP BY bucket;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_heat_1h_traffic_mv TO netops.pa_heat_1h AS
SELECT toStartOfHour(l.event_time) AS bucket, count() AS sessions, sum(l.bytes) AS bytes, sum(l.bytes_sent) AS bytes_sent,
       sum(l.bytes_recv) AS bytes_recv, countIf(l.action != 'allow') AS deny,
       topKWeightedState(3)(l.src, l.bytes) AS top_bytes_src, topKIfState(3)(l.src, l.action != 'allow') AS top_deny_src
FROM netops.pa_traffic_logs AS l GROUP BY bucket;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_heat_1d_traffic_mv TO netops.pa_heat_1d AS
SELECT toStartOfDay(l.event_time) AS bucket, count() AS sessions, sum(l.bytes) AS bytes, sum(l.bytes_sent) AS bytes_sent,
       sum(l.bytes_recv) AS bytes_recv, countIf(l.action != 'allow') AS deny,
       topKWeightedState(3)(l.src, l.bytes) AS top_bytes_src, topKIfState(3)(l.src, l.action != 'allow') AS top_deny_src
FROM netops.pa_traffic_logs AS l GROUP BY bucket;

-- 威脅:只算 log_type = 'threat'(url、data、wildfire 不算進威脅指標);Top IP 依 critical / high / medium 筆數
CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_heat_5m_threat_mv TO netops.pa_heat_5m AS
SELECT toStartOfFiveMinutes(event_time) AS bucket, countIf(severity = 'critical') AS thr_critical, countIf(severity = 'high') AS thr_high,
       countIf(severity = 'medium') AS thr_medium, countIf(severity = 'low') AS thr_low, countIf(severity = 'informational') AS thr_info,
       topKIfState(3)(src, severity IN ('critical', 'high', 'medium')) AS top_thr_src
FROM netops.pa_threat_logs WHERE log_type = 'threat' GROUP BY bucket;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_heat_1h_threat_mv TO netops.pa_heat_1h AS
SELECT toStartOfHour(event_time) AS bucket, countIf(severity = 'critical') AS thr_critical, countIf(severity = 'high') AS thr_high,
       countIf(severity = 'medium') AS thr_medium, countIf(severity = 'low') AS thr_low, countIf(severity = 'informational') AS thr_info,
       topKIfState(3)(src, severity IN ('critical', 'high', 'medium')) AS top_thr_src
FROM netops.pa_threat_logs WHERE log_type = 'threat' GROUP BY bucket;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.pa_heat_1d_threat_mv TO netops.pa_heat_1d AS
SELECT toStartOfDay(event_time) AS bucket, countIf(severity = 'critical') AS thr_critical, countIf(severity = 'high') AS thr_high,
       countIf(severity = 'medium') AS thr_medium, countIf(severity = 'low') AS thr_low, countIf(severity = 'informational') AS thr_info,
       topKIfState(3)(src, severity IN ('critical', 'high', 'medium')) AS top_thr_src
FROM netops.pa_threat_logs WHERE log_type = 'threat' GROUP BY bucket;
