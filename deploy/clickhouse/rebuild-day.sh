#!/bin/sh
# 重建某一天的全部彙總(V-a;docs/VIZ-RULES-DESIGN.md §3.6):每小時彙總 pa_traffic_hourly_app / _src 與熱力圖 pa_heat_5m / _1h / _1d。
#   sh deploy/clickhouse/rebuild-day.sh <容器名稱> <YYYY-MM-DD>
#   例:sh deploy/clickhouse/rebuild-day.sh giganexus-netops-test-netops-clickhouse-1 2026-11-10
# 什麼時候用(寫入動作,**由需求方同意後執行**):
#   - V-a 上線後回填:物化檢視只處理建立之後的寫入,原始表還有的日子(正式區 TRAFFIC 30 天、威脅 90 天)逐日重建,
#     熱力圖才有上線前的資料;_src 的上傳 / 下載(migrations/003)也一起補上
#   - dedupe-day.sh 去掉重複列之後(由 dedupe-day.sh 呼叫)、手動 FTP 補漏之後(手冊 §11.3)
# 做法:先刪掉那一天的彙總(mutations_sync=2,等完成),再從原始表重新彙總寫回(insert_deduplicate = 0:彙總表有去重視窗)。
# 超過原始表保留的日子不能重建(原始 log 已刪,熱力圖以當時的值為準):原始表那天沒有資料時不刪除、直接結束。
# 熱力圖每天格:超過 TRAFFIC 保留(30 天)但還在威脅保留(90 天)內的日子,只重建威脅欄位會把 TRAFFIC 總數清掉,所以 TRAFFIC 沒資料就整天不動。
# 不能重建今天(台灣時間):今天還在寫入,重建期間進來的列會被算兩次。以容器內 default 帳號(只允許容器本機)執行。
set -eu
C="${1:?用法:rebuild-day.sh <容器名稱> <YYYY-MM-DD>}"
D="${2:?缺少日期 YYYY-MM-DD}"
case "$D" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "日期格式要 YYYY-MM-DD" >&2; exit 2 ;; esac
case "$C" in "" | *[!A-Za-z0-9_.-]*) echo "容器名稱只能是英數、底線、點與 -" >&2; exit 2 ;; esac
TODAY=$(TZ=Asia/Taipei date +%Y-%m-%d)
[ "$D" \< "$TODAY" ] || { echo "只能重建今天($TODAY)以前的日期" >&2; exit 2; }
ck() { docker exec -i "$C" clickhouse-client --query "$1"; }

T=$(ck "SELECT count() FROM netops.pa_traffic_logs WHERE toDate(event_time) = toDate('$D')")
if [ "$T" = 0 ]; then echo "pa_traffic_logs $D 沒有資料(已超過保留或沒有收到),不重建"; exit 0; fi
W="toDate(event_time) = toDate('$D')"
NODEDUP="SETTINGS insert_deduplicate = 0"

echo "重建 $D 的每小時彙總(原始 TRAFFIC $T 筆)"
ck "ALTER TABLE netops.pa_traffic_hourly_app DELETE WHERE toDate(hour) = toDate('$D') SETTINGS mutations_sync = 2"
ck "ALTER TABLE netops.pa_traffic_hourly_src DELETE WHERE toDate(hour) = toDate('$D') SETTINGS mutations_sync = 2"
ck "INSERT INTO netops.pa_traffic_hourly_app $NODEDUP
    SELECT toStartOfHour(event_time) AS hour, action, app, from_zone, to_zone, count(), sum(bytes), sum(packets)
    FROM netops.pa_traffic_logs WHERE $W GROUP BY hour, action, app, from_zone, to_zone"
ck "INSERT INTO netops.pa_traffic_hourly_src (hour, src, action, sessions, bytes, bytes_sent, bytes_recv) $NODEDUP
    SELECT toStartOfHour(event_time) AS hour, src, action, count(), sum(bytes), sum(bytes_sent), sum(bytes_recv)
    FROM netops.pa_traffic_logs WHERE $W GROUP BY hour, src, action"

for g in 5m:toStartOfFiveMinutes 1h:toStartOfHour 1d:toStartOfDay; do
  tbl="pa_heat_${g%%:*}"; fn="${g#*:}"
  echo "重建 $D 的 $tbl"
  ck "ALTER TABLE netops.$tbl DELETE WHERE toDate(bucket) = toDate('$D') SETTINGS mutations_sync = 2"
  ck "INSERT INTO netops.$tbl (bucket, sessions, bytes, bytes_sent, bytes_recv, deny, top_bytes_src, top_deny_src) $NODEDUP
      SELECT $fn(event_time) AS b, count(), sum(bytes), sum(bytes_sent), sum(bytes_recv), countIf(action != 'allow'),
             topKWeightedState(3)(src, bytes), topKIfState(3)(src, action != 'allow')
      FROM netops.pa_traffic_logs WHERE $W GROUP BY b"
  ck "INSERT INTO netops.$tbl (bucket, thr_critical, thr_high, thr_medium, thr_low, thr_info, top_thr_src) $NODEDUP
      SELECT $fn(event_time) AS b, countIf(severity = 'critical'), countIf(severity = 'high'), countIf(severity = 'medium'),
             countIf(severity = 'low'), countIf(severity = 'informational'), topKIfState(3)(src, severity IN ('critical', 'high', 'medium'))
      FROM netops.pa_threat_logs WHERE log_type = 'threat' AND $W GROUP BY b"
done
ck "SELECT 'raw', count() FROM netops.pa_traffic_logs WHERE $W
    UNION ALL SELECT 'hourly_app', sum(sessions) FROM netops.pa_traffic_hourly_app WHERE toDate(hour) = toDate('$D')
    UNION ALL SELECT 'hourly_src', sum(sessions) FROM netops.pa_traffic_hourly_src WHERE toDate(hour) = toDate('$D')
    UNION ALL SELECT 'heat_5m', sum(sessions) FROM netops.pa_heat_5m WHERE toDate(bucket) = toDate('$D')
    UNION ALL SELECT 'heat_1d', sum(sessions) FROM netops.pa_heat_1d WHERE toDate(bucket) = toDate('$D') FORMAT TSV"
echo "完成"
