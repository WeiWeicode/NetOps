-- V-a(2026-11-11;docs/VIZ-RULES-DESIGN.md §3.4):來源 IP 每小時彙總加上傳 / 下載(儀表板 Top 10 頻寬 IP 堆疊長條)。
-- 可重複執行:ADD COLUMN IF NOT EXISTS;MODIFY QUERY 每次都改成同一個定義(TO 目標表的 MV,不重建、不漏寫入)。
-- 改之前的列上傳 / 下載為 0:用 deploy/clickhouse/rebuild-day.sh 依日重建原始表還有的範圍。
ALTER TABLE netops.pa_traffic_hourly_src
    ADD COLUMN IF NOT EXISTS bytes_sent UInt64 DEFAULT 0 AFTER bytes,
    ADD COLUMN IF NOT EXISTS bytes_recv UInt64 DEFAULT 0 AFTER bytes_sent;
ALTER TABLE netops.pa_traffic_hourly_src_mv MODIFY QUERY
SELECT toStartOfHour(event_time) AS hour, src, action, count() AS sessions, sum(bytes) AS bytes,
       sum(bytes_sent) AS bytes_sent, sum(bytes_recv) AS bytes_recv
FROM netops.pa_traffic_logs GROUP BY hour, src, action;
