#!/bin/sh
# 修正重複寫入(C2「重複有修正」;手冊 §6.6、§11.3):某一天的原始表去掉完全相同的列,再重建那一天的每小時彙總。
#   sh deploy/clickhouse/dedupe-day.sh <容器名稱> <YYYY-MM-DD>
#   例:sh deploy/clickhouse/dedupe-day.sh giganexus-netops-test-netops-clickhouse-1 2026-11-11
# 什麼時候用:deploy/clickhouse/verify-ingest.sh 的「重複」不是 0 時(正常情況下去重 token 會擋掉重送,這裡處理例外,
#   例如資料錯誤拆批後又重送、或 FTP 補漏和 Syslog 重疊)。寫入動作,**由需求方同意後執行**。
# 做法:
#   1. OPTIMIZE … PARTITION <日> FINAL DEDUPLICATE:只刪「所有欄位都相同」的列(重送的列連 received_at 都相同;
#      不同的 log 不會被當成重複)。pa_traffic_logs、pa_threat_logs 都做
#   2. 原始表筆數有變少時,重建那一天的 pa_traffic_hourly_app / _src(物化檢視當初也算了重複的列):
#      先刪掉那一天的彙總(mutations_sync=2,等完成),再從原始表重新彙總寫回
# 不能修正今天(台灣時間):今天還在寫入,重建彙總期間進來的列會被算兩次。以容器內 default 帳號(只允許容器本機)執行。
set -eu
C="${1:?用法:dedupe-day.sh <容器名稱> <YYYY-MM-DD>}"
D="${2:?缺少日期 YYYY-MM-DD}"
echo "$D" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || { echo "日期格式要 YYYY-MM-DD:$D" >&2; exit 2; }
TODAY=$(TZ=Asia/Taipei date +%Y-%m-%d)
[ "$D" \< "$TODAY" ] || { echo "只能修正今天($TODAY)以前的日期" >&2; exit 2; }
P=$(echo "$D" | tr -d '-')
ck() { docker exec -i "$C" clickhouse-client --query "$1"; }
cnt() { ck "SELECT count() FROM netops.$1 WHERE toDate(event_time) = toDate('$D')"; }

T0=$(cnt pa_traffic_logs); X0=$(cnt pa_threat_logs)
ck "OPTIMIZE TABLE netops.pa_traffic_logs PARTITION $P FINAL DEDUPLICATE"
ck "OPTIMIZE TABLE netops.pa_threat_logs PARTITION $P FINAL DEDUPLICATE"
T1=$(cnt pa_traffic_logs); X1=$(cnt pa_threat_logs)
echo "pa_traffic_logs $D:$T0 → $T1(刪除 $((T0 - T1)))"
echo "pa_threat_logs  $D:$X0 → $X1(刪除 $((X0 - X1)))"

if [ "$T1" -lt "$T0" ]; then
  echo "重建 $D 的每小時彙總"
  ck "ALTER TABLE netops.pa_traffic_hourly_app DELETE WHERE toDate(hour) = toDate('$D') SETTINGS mutations_sync = 2"
  ck "ALTER TABLE netops.pa_traffic_hourly_src DELETE WHERE toDate(hour) = toDate('$D') SETTINGS mutations_sync = 2"
  ck "INSERT INTO netops.pa_traffic_hourly_app
      SELECT toStartOfHour(event_time) AS hour, action, app, from_zone, to_zone, count(), sum(bytes), sum(packets)
      FROM netops.pa_traffic_logs WHERE toDate(event_time) = toDate('$D') GROUP BY hour, action, app, from_zone, to_zone"
  ck "INSERT INTO netops.pa_traffic_hourly_src
      SELECT toStartOfHour(event_time) AS hour, src, action, count(), sum(bytes)
      FROM netops.pa_traffic_logs WHERE toDate(event_time) = toDate('$D') GROUP BY hour, src, action"
  ck "SELECT 'hourly_app', sum(sessions) FROM netops.pa_traffic_hourly_app WHERE toDate(hour) = toDate('$D')
      UNION ALL SELECT 'raw', count() FROM netops.pa_traffic_logs WHERE toDate(event_time) = toDate('$D') FORMAT TSV"
fi
echo "完成"
