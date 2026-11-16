#!/bin/sh
# C2 驗收核對(只讀;IMPL-PLAN C2 完成條件):每小時 Redis 接收計數 vs ClickHouse 筆數、重複、Redis 記憶體、netops-ingest 心跳與缺口。
#   在主機 2 WSL(root 或 docker 群組):sh deploy/clickhouse/verify-ingest.sh [小時數,預設 24,最多 24]
#   容器名稱預設測試區:NETOPS_PROJECT=giganexus-netops-test
# 只執行讀取:redis-cli EVAL_RO / HGETALL / INFO / XINFO / XPENDING / LRANGE、clickhouse-client SELECT(容器內 default 帳號)。
# 需要 GNU date(-d @秒數;主機 2 WSL Ubuntu),busybox / macOS 不適用。
#
# 比對方式(時間一律以「netops-pa 收到的時間」分小時,UTC 整點、顯示為台灣時間):
#   TRAFFIC  Redis:netops:pa:agg:traffic:{分鐘} 的 count 加總(netops-pa 寫進 Stream 的筆數,保留 1 天)
#            ClickHouse:pa_traffic_logs 依 received_at(= Stream ID 時間)計數
#   威脅類    Redis:netops:pa:log:{type} 該小時的 Stream 條目數(保留 2 天;agg 的 count 乘了 Repeat Count 不能直接比)
#            ClickHouse:pa_threat_logs 依 log_type、received_at 計數
#   差異 = (Redis − ClickHouse)/ Redis;完成條件 < 0.5%。分鐘桶是 netops-pa 收到的時間、Stream ID 是寫進 Redis 的時間(相差 ≤ 約 1 秒),
#   整點前後各有幾筆會落在相鄰小時,整體約 ±0.05%。
#   重複:同一個 seqno(> 0)出現超過一次的筆數(TRAFFIC 依 seqno;威脅類依 log_type + seqno),每天一列
set -eu
HOURS="${1:-24}"
case "$HOURS" in *[!0-9]* | "") echo "小時數要是 1–24" >&2; exit 2 ;; esac
[ "$HOURS" -ge 1 ] && [ "$HOURS" -le 24 ] || { echo "小時數要是 1–24(TRAFFIC 分鐘統計只保留 1 天)" >&2; exit 2; }
P="${NETOPS_PROJECT:-giganexus-netops-test}"
R="$P-netops-redis-1"
CH="$P-netops-clickhouse-1"
rc() { docker exec -i "$R" redis-cli "$@"; }
# 心跳的 lastError、缺口清單可能含 log 內容:去掉 ASCII 控制字元(保留換行與 tab)再印(資安審查 L2)
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
ck() { docker exec -i "$CH" clickhouse-client --query "$1"; }

NOW=$(date -u +%s)
END=$((NOW / 3600 * 3600))          # 最後一個完整小時的結束(UTC 整點)
START=$((END - HOURS * 3600))

echo "== netops-ingest 心跳 =="
rc hgetall netops:ingest:heartbeat | paste - - | grep -E '^(updatedAt|startedAt|release|state|failing|insertFailures|lastInsertAt|lastError|lastErrorAt|(inserted|malformed|trimmed|rejected|badTime|lagMs|gapFrom|gapKind):)' | clean || echo "(沒有心跳)"
echo
echo "== 缺口清單 netops:ingest:gaps(最新 10 筆)=="
rc lrange netops:ingest:gaps 0 9 | clean
echo
echo "== consumer group ch-writer(待處理 = 已讀未 ACK;lag = 尚未讀取)=="
for t in traffic threat url data wildfire; do
  printf '%-9s pending=%s ' "$t" "$(rc xpending "netops:pa:log:$t" ch-writer 2>/dev/null | head -n 1)"
  rc xinfo groups "netops:pa:log:$t" 2>/dev/null | paste - - | awk -F'\t' '$1=="lag"{printf "lag=%s ", $2} $1=="entries-read"{printf "entries-read=%s", $2}'
  echo
done
echo
echo "== Redis 記憶體 =="
rc info memory | grep -E '^(used_memory_human|used_memory_peak_human|maxmemory_human|maxmemory_policy):' | tr -d '\r'
echo

# ClickHouse 每小時計數(一次查完;h 為 UTC 整點的 Unix 秒)
CHT=$(ck "SELECT toUnixTimestamp(toStartOfHour(received_at, 'UTC')) AS h, count() FROM netops.pa_traffic_logs
          WHERE received_at >= toDateTime64($START, 3, 'UTC') AND received_at < toDateTime64($END, 3, 'UTC') GROUP BY h FORMAT TSV")
CHX=$(ck "SELECT log_type, toUnixTimestamp(toStartOfHour(received_at, 'UTC')) AS h, count() FROM netops.pa_threat_logs
          WHERE received_at >= toDateTime64($START, 3, 'UTC') AND received_at < toDateTime64($END, 3, 'UTC') GROUP BY log_type, h FORMAT TSV")

SUM_AGG='local s = 0 for _, k in ipairs(KEYS) do local v = redis.call("HGET", k, "count") if v then s = s + tonumber(v) end end return s'
COUNT_X='return #redis.call("XRANGE", KEYS[1], ARGV[1], ARGV[2])'

row() { # 類型 小時 redis ch
  awk -v t="$1" -v h="$2" -v r="$3" -v c="$4" 'BEGIN {
    d = (r > 0) ? (r - c) * 100 / r : (c > 0 ? -100 : 0); flag = (d > 0.5 || d < -0.5) ? "  <-- 超過 0.5%" : "";
    printf "%-9s %s  %10d %10d %8.3f%%%s\n", t, h, r, c, d, flag }'
}

echo "== 每小時筆數(收到時間,台灣時間;Redis vs ClickHouse)=="
printf '%-9s %-16s  %10s %10s %9s\n' 類型 小時 Redis ClickHouse 差異
h=$START
while [ "$h" -lt "$END" ]; do
  label=$(TZ=Asia/Taipei date -d "@$h" '+%Y-%m-%d %H:00')
  keys=""
  m=0
  while [ $m -lt 60 ]; do keys="$keys netops:pa:agg:traffic:$(date -u -d "@$((h + m * 60))" +%Y%m%d%H%M)"; m=$((m + 1)); done
  # shellcheck disable=SC2086
  r=$(rc eval_ro "$SUM_AGG" 60 $keys)
  c=$(printf '%s\n' "$CHT" | awk -v h="$h" '$1 == h {print $2}')
  row traffic "$label" "${r:-0}" "${c:-0}"
  for t in threat url data wildfire; do
    r=$(rc eval_ro "$COUNT_X" 1 "netops:pa:log:$t" "$((h * 1000))" "$(((h + 3600) * 1000 - 1))")
    c=$(printf '%s\n' "$CHX" | awk -v t="$t" -v h="$h" '$1 == t && $2 == h {print $3}')
    [ "${r:-0}" = 0 ] && [ "${c:-0}" = 0 ] && continue
    row "$t" "$label" "${r:-0}" "${c:-0}"
  done
  h=$((h + 3600))
done
echo
echo "== 重複(同一個 seqno 出現多次;每天)=="
ck "SELECT 'traffic' AS t, toDate(event_time) AS d, count() AS rows, countIf(seqno = 0) AS no_seqno, count() - countIf(seqno = 0) - uniqExactIf(seqno, seqno > 0) AS dup
    FROM netops.pa_traffic_logs GROUP BY d ORDER BY d FORMAT PrettyCompactMonoBlock"
ck "SELECT log_type AS t, toDate(event_time) AS d, count() AS rows, countIf(seqno = 0) AS no_seqno, count() - countIf(seqno = 0) - uniqExactIf((log_type, seqno), seqno > 0) AS dup
    FROM netops.pa_threat_logs GROUP BY t, d ORDER BY t, d FORMAT PrettyCompactMonoBlock"
echo
echo "== ClickHouse 大小 =="
ck "SELECT table, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS disk FROM system.parts WHERE database = 'netops' AND active GROUP BY table ORDER BY table FORMAT PrettyCompactMonoBlock"
