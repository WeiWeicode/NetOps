-- AD-1(2026-11-23;docs/AD-AGENT-PLAN.md §4.3、ARCHITECTURE D49):AD 事件原始表、熱力圖彙總 5m / 1h / 1d 與 3 個物化檢視。
--   netops-ingest(netops_writer)從 Redis Stream netops:ad:log:events 批次寫入 ad_events;netops-api 在 AD-3 起以 netops_reader 查詢。
--   apply-schema.sh 代入 TTL(migrations/ 也會代入佔位符):
--     {{TTL_AD_RAW}}   ad_events   測試區 3 DAY、正式區 90 DAY(AD7)
--     {{TTL_HEAT_5M}}  ad_heat_5m  測試區 3 DAY、正式區 1 YEAR(同 pa_heat_5m)
--     {{TTL_HEAT_1H}}  ad_heat_1h  測試區 3 DAY、正式區 5 YEAR
--     {{TTL_HEAT_1D}}  ad_heat_1d  測試區 3 DAY、正式區 5 YEAR
--   TTL 之後要改由 apply-schema.sh 的 modify 處理(只改中繼資料)。
-- 去重(審查 M2、H4):鍵是 (computer, channel, log_epoch, record_id)。
--   Agent 重送:netops-ad-receiver 依 Redis 水位擋掉 RecordID 不大於已接受最大值的事件,重複的不會進 Stream;
--   ingest 重啟重讀(INSERT 後、XACK 前):同一批同一個 insert_deduplication_token,表與 MV 目標表都開去重視窗(同 migrations/002)。
--   所以 ad_events 維持一般 MergeTree(不用 ReplacingMergeTree,ad_heat_* 的計數才不會重複)。
--   ad_heat_* 手動重建時要帶 insert_deduplicate = 0(同 rebuild-day.sh 的說明)。
-- 可重複執行:CREATE … IF NOT EXISTS。
-- 注意:ad_domain 存 DC 所屬網域(接收端依 Token 對應表核對過的值),不是事件訊息裡的帳戶網域。

CREATE TABLE IF NOT EXISTS netops.ad_events
(
    event_time    DateTime('Asia/Taipei')        CODEC(DoubleDelta, ZSTD(1)),
    received_at   DateTime64(3, 'Asia/Taipei')   CODEC(DoubleDelta, ZSTD(1)),  -- 寫進 Stream 的時間(Stream ID)
    computer      LowCardinality(String),        -- DC 主機名,例 GSMC-DC1(Token 對應表的寫法)
    ad_domain     LowCardinality(String),        -- DC 所屬 AD 網域,例 gsmc.com.tw
    channel       LowCardinality(String),        -- 'Security' | 'System' | 'Directory_Service' | 'DNS_Server'
    event_id      UInt32,
    log_epoch     UInt32 DEFAULT 0,              -- Event Log 世代:偵測到 RecordID 重置(清除重編)時 +1(H4)
    record_id     UInt64,                        -- Windows EventRecordID(同台 DC + Channel + log_epoch 內唯一)
    level         LowCardinality(String),        -- 'critical' | 'error' | 'warning' | 'audit_failure' | 'audit_success' | 'info'
    level_text    LowCardinality(String),
    provider      LowCardinality(String),
    account       String CODEC(ZSTD(1)),         -- 目標或登入失敗帳號
    actor         String CODEC(ZSTD(1)),         -- 執行異動的主體帳號
    target        String CODEC(ZSTD(1)),         -- 被異動對象(CN 已拆出)
    group_name    LowCardinality(String),        -- 異動的安全群組名稱
    privileged    UInt8 DEFAULT 0,               -- 1 = 特權群組異動
    is_issue      UInt8 DEFAULT 0,               -- 1 = isIssue(e) 需要注意的事件
    src_ip        IPv6,                          -- 來源 IP(無 IP 時為 '::')
    src_ip_raw    String CODEC(ZSTD(1)),         -- 原始來源位址字串(保留非標準格式)
    workstation   LowCardinality(String),        -- 來源工作站名稱
    reason        LowCardinality(String),        -- 登入失敗原因(已轉換 NTSTATUS / Kerberos 中文)
    message       String CODEC(ZSTD(3)),         -- 完整訊息(上限 3,000 字)
    source        LowCardinality(String),        -- 'agent' | 'ftp'(AD-3 補漏)

    INDEX idx_account account TYPE tokenbf_v1(4096, 2, 0) GRANULARITY 2,
    INDEX idx_src_ip  src_ip  TYPE bloom_filter(0.01)     GRANULARITY 1,
    INDEX idx_msg     message TYPE ngrambf_v1(3, 16384, 2, 0) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (toStartOfHour(event_time), channel, event_id, computer, log_epoch, record_id)
TTL event_time + INTERVAL {{TTL_AD_RAW}} DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1,
         non_replicated_deduplication_window = 1000;

-- 熱力圖彙總(V-d;結構對齊 pa_heat_*,docs/VIZ-RULES-DESIGN.md §3.1):不分維度,每個時間格一列。
-- AggregatingMergeTree 只在背景合併:查詢一定要 sum() / -Merge + GROUP BY bucket。
CREATE TABLE IF NOT EXISTS netops.ad_heat_5m
(
    bucket            DateTime('Asia/Taipei'),
    total_events      SimpleAggregateFunction(sum, UInt64),
    issue_events      SimpleAggregateFunction(sum, UInt64),   -- is_issue = 1
    fail_logons       SimpleAggregateFunction(sum, UInt64),   -- event_id IN (4625, 4771, 4776)
    lockouts          SimpleAggregateFunction(sum, UInt64),   -- event_id = 4740
    priv_changes      SimpleAggregateFunction(sum, UInt64),   -- privileged = 1 OR event_id IN (1102, 4794)
    account_changes   SimpleAggregateFunction(sum, UInt64),   -- 帳號 / 群組異動(adlog.js ACCOUNT_CHANGES 的事件)
    top_fail_src      AggregateFunction(topKIf(3), IPv6, UInt8),
    top_fail_account  AggregateFunction(topKIf(3), String, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY bucket
TTL bucket + INTERVAL {{TTL_HEAT_5M}} DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS netops.ad_heat_1h AS netops.ad_heat_5m
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY bucket
TTL bucket + INTERVAL {{TTL_HEAT_1H}} DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS netops.ad_heat_1d AS netops.ad_heat_5m
ENGINE = AggregatingMergeTree
PARTITION BY toYear(bucket)
ORDER BY bucket
TTL bucket + INTERVAL {{TTL_HEAT_1D}} DELETE
SETTINGS non_replicated_deduplication_window = 1000;

-- 三個粒度各自從原始表算(不串接);MV 一律用表別名 l 引用來源欄位(同 schema.sql 的 pa_heat_*_mv 說明)。
-- 帳號 / 群組異動的事件清單和 backend/src/modules/ad/core/adlog.js 的 ACCOUNT_CHANGES 相同(改一邊要同步)。
CREATE MATERIALIZED VIEW IF NOT EXISTS netops.ad_heat_5m_mv TO netops.ad_heat_5m AS
SELECT toStartOfFiveMinutes(l.event_time) AS bucket, count() AS total_events, countIf(l.is_issue = 1) AS issue_events,
       countIf(l.event_id IN (4625, 4771, 4776)) AS fail_logons, countIf(l.event_id = 4740) AS lockouts,
       countIf(l.privileged = 1 OR l.event_id IN (1102, 4794)) AS priv_changes,
       countIf(l.event_id IN (4720, 4722, 4725, 4726, 4724, 4738, 4781, 4767, 4741, 4743, 4727, 4731, 4754, 4728, 4729, 4732, 4733, 4756, 4757, 4704, 4794)) AS account_changes,
       topKIfState(3)(l.src_ip, l.event_id IN (4625, 4771, 4776) AND l.src_ip != toIPv6('::')) AS top_fail_src,
       topKIfState(3)(l.account, l.event_id IN (4625, 4771, 4776) AND l.account != '') AS top_fail_account
FROM netops.ad_events AS l GROUP BY bucket;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.ad_heat_1h_mv TO netops.ad_heat_1h AS
SELECT toStartOfHour(l.event_time) AS bucket, count() AS total_events, countIf(l.is_issue = 1) AS issue_events,
       countIf(l.event_id IN (4625, 4771, 4776)) AS fail_logons, countIf(l.event_id = 4740) AS lockouts,
       countIf(l.privileged = 1 OR l.event_id IN (1102, 4794)) AS priv_changes,
       countIf(l.event_id IN (4720, 4722, 4725, 4726, 4724, 4738, 4781, 4767, 4741, 4743, 4727, 4731, 4754, 4728, 4729, 4732, 4733, 4756, 4757, 4704, 4794)) AS account_changes,
       topKIfState(3)(l.src_ip, l.event_id IN (4625, 4771, 4776) AND l.src_ip != toIPv6('::')) AS top_fail_src,
       topKIfState(3)(l.account, l.event_id IN (4625, 4771, 4776) AND l.account != '') AS top_fail_account
FROM netops.ad_events AS l GROUP BY bucket;

CREATE MATERIALIZED VIEW IF NOT EXISTS netops.ad_heat_1d_mv TO netops.ad_heat_1d AS
SELECT toStartOfDay(l.event_time) AS bucket, count() AS total_events, countIf(l.is_issue = 1) AS issue_events,
       countIf(l.event_id IN (4625, 4771, 4776)) AS fail_logons, countIf(l.event_id = 4740) AS lockouts,
       countIf(l.privileged = 1 OR l.event_id IN (1102, 4794)) AS priv_changes,
       countIf(l.event_id IN (4720, 4722, 4725, 4726, 4724, 4738, 4781, 4767, 4741, 4743, 4727, 4731, 4754, 4728, 4729, 4732, 4733, 4756, 4757, 4704, 4794)) AS account_changes,
       topKIfState(3)(l.src_ip, l.event_id IN (4625, 4771, 4776) AND l.src_ip != toIPv6('::')) AS top_fail_src,
       topKIfState(3)(l.account, l.event_id IN (4625, 4771, 4776) AND l.account != '') AS top_fail_account
FROM netops.ad_events AS l GROUP BY bucket;
