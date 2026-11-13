-- C4(2026-11-12;手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §8.3):冷歸檔紀錄。netops-ingest(netops_writer)寫入,netops-api 冷明細(netops_cold)讀取。
--   一個 (table_name, day) 一列最新狀態(ReplacingMergeTree,查詢用 FINAL);status:ok / failed(重試中)/ expired(超過保留期限已刪檔)
--   path 是相對 pa-archive 的路徑(YYYY/檔名),不含主機路徑;資料量很小(每天 2 列),不設 TTL(Parquet 至少保留 1 年,CQ12)
-- 可重複執行:CREATE TABLE IF NOT EXISTS
CREATE TABLE IF NOT EXISTS netops.pa_archive_manifest
(
    day         Date,
    table_name  LowCardinality(String),   -- 'traffic' | 'threat'
    status      LowCardinality(String),
    rows        UInt64,
    bytes       UInt64,
    sha256      String,
    path        String,
    error       String,
    updated_at  DateTime64(3, 'Asia/Taipei')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (table_name, day);
