#!/bin/sh
# C1 POC:代表查詢、容量與 Parquet 實測(docs/test-reports/2026-11-10-clickhouse-c1.md §3–§5)。
#   在主機 2 的 WSL(root):sh bench.sh <ClickHouse 容器> <日期 YYYY-MM-DD> [冷查詢帳號密碼檔]
# 每個查詢先跑一次暖機、再跑一次計時;結果取自 system.query_log(query_duration_ms、memory_usage、read_rows)。
# Parquet 匯出到容器的 user_files/poc/(本機磁碟);冷查詢用 file() 讀回。
set -eu
CH="${1:?用法:bench.sh <ClickHouse 容器> <日期 YYYY-MM-DD> [冷查詢密碼檔]}"
DAY="${2:?缺少日期}"
COLD_PW_FILE="${3:-}"
case "$DAY" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "日期格式錯誤:$DAY" >&2; exit 2 ;; esac
q() { docker exec -i "$CH" clickhouse-client "$@"; }
FROM="toDateTime('$DAY 00:00:00', 'Asia/Taipei')"
TO="$FROM + INTERVAL 1 DAY"

echo "## 容量(system.parts,active)"
q --log_comment "c1:optimize_final" --query "OPTIMIZE TABLE netops.pa_traffic_logs FINAL" || true
q --query "SELECT table, sum(rows) AS n_rows, count() AS parts,
  formatReadableSize(sum(data_compressed_bytes)) AS compressed, formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
  round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 1) AS ratio,
  round(sum(bytes_on_disk) / sum(rows), 1) AS disk_bytes_per_row, formatReadableSize(sum(bytes_on_disk)) AS on_disk,
  formatReadableSize(sum(primary_key_bytes_in_memory)) AS pk_mem, formatReadableSize(sum(secondary_indices_compressed_bytes)) AS skip_idx
  FROM system.parts WHERE database = 'netops' AND active GROUP BY table ORDER BY table FORMAT PrettyCompactMonoBlock"
echo "## 每欄壓縮後大小(前 15)"
q --query "SELECT name, formatReadableSize(data_compressed_bytes) AS compressed, round(data_compressed_bytes / (SELECT sum(rows) FROM system.parts WHERE database = 'netops' AND table = 'pa_traffic_logs' AND active), 2) AS bytes_per_row
  FROM system.columns WHERE database = 'netops' AND table = 'pa_traffic_logs' ORDER BY data_compressed_bytes DESC LIMIT 15 FORMAT PrettyCompactMonoBlock"
echo "## 每小時筆數"
q --query "SELECT toHour(event_time) AS h, count() AS n FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO GROUP BY h ORDER BY h FORMAT TSV" | tr '\n' ' '; echo
q --query "SELECT min(event_time), max(event_time), count(), countIf(event_time < $FROM OR event_time >= $TO) AS outside_day, countIf(src = toIPv6('::')) AS src_empty FROM netops.pa_traffic_logs FORMAT TSV"

# 測試用 IP:當天流量最大的來源、連線最多的目的
SRC="$(q --query "SELECT replaceRegexpOne(toString(src), '^::ffff:', '') FROM netops.pa_traffic_hourly_src WHERE hour >= $FROM AND hour < $TO GROUP BY src ORDER BY sum(bytes) DESC LIMIT 1")"
DST="$(q --query "SELECT replaceRegexpOne(toString(dst), '^::ffff:', '') FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND startsWith(toString(dst), '::ffff:10.') GROUP BY dst ORDER BY count() DESC LIMIT 1 OFFSET 5")"
echo "測試 IP:src=$SRC dst=$DST"

run() { # 標籤 查詢 [額外參數…]
  tag="$1"; sql="$2"; shift 2
  q --log_comment "c1-warm" "$@" --query "$sql" > /dev/null
  q --log_comment "c1:$tag" "$@" --query "$sql" > /dev/null
}
run overview_hourly_mv "SELECT hour, action, sum(sessions), sum(bytes) FROM netops.pa_traffic_hourly_app WHERE hour >= $FROM AND hour < $TO GROUP BY hour, action ORDER BY hour"
run overview_hourly_raw "SELECT toStartOfHour(event_time) h, action, count(), sum(bytes) FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO GROUP BY h, action ORDER BY h"
run top10_src_mv "SELECT src, sum(sessions), sum(bytes) b FROM netops.pa_traffic_hourly_src WHERE hour >= $FROM AND hour < $TO GROUP BY src ORDER BY b DESC LIMIT 10"
run top10_src_raw "SELECT src, count(), sum(bytes) b FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO GROUP BY src ORDER BY b DESC LIMIT 10"
run top10_app_mv "SELECT app, sum(sessions) s, sum(bytes) FROM netops.pa_traffic_hourly_app WHERE hour >= $FROM AND hour < $TO GROUP BY app ORDER BY s DESC LIMIT 10"
run top10_dport_raw "SELECT dport, count() c FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND action != 'allow' GROUP BY dport ORDER BY c DESC LIMIT 10"
run top10_dst_raw "SELECT dst, count() c, sum(bytes) FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO GROUP BY dst ORDER BY c DESC LIMIT 10"
run detail_src_1day "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND src = toIPv6('$SRC') ORDER BY event_time DESC LIMIT 500"
run detail_dst_1day_idx "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND dst = toIPv6('$DST') ORDER BY event_time DESC LIMIT 500"
run detail_dst_1day_noidx "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND dst = toIPv6('$DST') ORDER BY event_time DESC LIMIT 500 SETTINGS use_skip_indexes = 0"
run detail_srcdst_1day "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND (src = toIPv6('$DST') OR dst = toIPv6('$DST')) ORDER BY event_time DESC LIMIT 500"
run detail_dport_1day "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND dport = 3389 ORDER BY event_time DESC LIMIT 500"
run detail_cidr_range "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND src BETWEEN toIPv6('10.10.112.0') AND toIPv6('10.10.112.255') ORDER BY event_time DESC LIMIT 500"
run detail_cidr_func "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND isIPAddressInRange(toString(src), '::ffff:10.10.112.0/120') ORDER BY event_time DESC LIMIT 500"
run detail_1hour_all "SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM + INTERVAL 10 HOUR AND event_time < $FROM + INTERVAL 11 HOUR ORDER BY event_time DESC LIMIT 500"

echo "## Parquet 匯出(user_files/poc/,IP 轉文字;另存一份 IP 二進位比較大小)"
P="poc/pa_traffic_$DAY.parquet"; PB="poc/pa_traffic_${DAY}_ipbin.parquet"
IPS="replaceRegexpOne(toString(src), '^::ffff:', '') AS src, replaceRegexpOne(toString(dst), '^::ffff:', '') AS dst, replaceRegexpOne(toString(nat_src), '^::ffff:', '') AS nat_src, replaceRegexpOne(toString(nat_dst), '^::ffff:', '') AS nat_dst"
q --log_comment "c1:parquet_export_iptext" --engine_file_truncate_on_insert 1 --query "INSERT INTO FUNCTION file('$P', 'Parquet') SELECT * EXCEPT (src, dst, nat_src, nat_dst), $IPS FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO SETTINGS output_format_parquet_compression_method = 'zstd', max_threads = 1"
q --log_comment "c1:parquet_export_ipbin" --engine_file_truncate_on_insert 1 --query "INSERT INTO FUNCTION file('$PB', 'Parquet') SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO SETTINGS output_format_parquet_compression_method = 'zstd', max_threads = 1"
docker exec "$CH" sh -c 'ls -l /var/lib/clickhouse/user_files/poc/'

cold() { # 標籤 查詢
  if [ -n "$COLD_PW_FILE" ]; then
    # 密碼經環境變數傳入(-e 只寫名稱),不出現在命令列參數與 docker events
    CLICKHOUSE_PASSWORD="$(cat "$COLD_PW_FILE")" docker exec -i -e CLICKHOUSE_PASSWORD "$CH" clickhouse-client --user netops_cold --log_comment "c1:$1" --query "$2" > /dev/null
  else
    q --log_comment "c1:$1" --max_threads 1 --query "$2" > /dev/null
  fi
}
cold cold_count "SELECT count() FROM file('$P', 'Parquet')"
cold cold_src_text "SELECT event_time, src, dst, dport, app, action, bytes FROM file('$P', 'Parquet') WHERE src = '$SRC' OR dst = '$SRC' ORDER BY event_time DESC LIMIT 500"
cold cold_dst_text "SELECT event_time, src, dst, dport, app, action, bytes FROM file('$P', 'Parquet') WHERE dst = '$DST' ORDER BY event_time DESC LIMIT 500"
cold cold_hour_text "SELECT * FROM file('$P', 'Parquet') WHERE event_time >= $FROM + INTERVAL 10 HOUR AND event_time < $FROM + INTERVAL 11 HOUR ORDER BY event_time DESC LIMIT 500"
cold cold_top_dport "SELECT dport, count() c FROM file('$P', 'Parquet') WHERE action != 'allow' GROUP BY dport ORDER BY c DESC LIMIT 10"
cold cold_src_ipbin "SELECT count() FROM file('$PB', 'Parquet') WHERE src = toIPv6('$SRC')"

echo "## 查詢結果(query_log)"
q --query "SYSTEM FLUSH LOGS"
q --query "SELECT replaceOne(log_comment, 'c1:', '') AS query, user, query_duration_ms AS ms, formatReadableSize(memory_usage) AS mem,
  read_rows, formatReadableSize(read_bytes) AS read, result_rows, if(exception = '', '', substring(exception, 1, 80)) AS error
  FROM system.query_log WHERE startsWith(log_comment, 'c1:') AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND event_time > now() - INTERVAL 30 MINUTE ORDER BY event_time FORMAT PrettyCompactMonoBlock"
echo "## 匯入(INSERT)"
q --query "SELECT count() AS inserts, round(avg(query_duration_ms)) AS avg_ms, max(query_duration_ms) AS max_ms,
  formatReadableSize(avg(memory_usage)) AS avg_mem, formatReadableSize(max(memory_usage)) AS max_mem, sum(written_rows) AS rows
  FROM system.query_log WHERE query_kind = 'Insert' AND type = 'QueryFinish' AND has(tables, 'netops.pa_traffic_logs') AND log_comment = '' FORMAT PrettyCompactMonoBlock"
echo "## skip index 是否用上(dst)"
q --query "EXPLAIN indexes = 1 SELECT * FROM netops.pa_traffic_logs WHERE event_time >= $FROM AND event_time < $TO AND dst = toIPv6('$DST')" | grep -E 'Name|Granules|Parts|Type|Condition'
