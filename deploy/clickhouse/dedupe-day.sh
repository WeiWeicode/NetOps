#!/bin/sh
# 修正重複寫入(C2「重複有修正」;手冊 §6.6、§11.3):某一天的原始表去掉完全相同的列,再重建那一天的每小時彙總。
#   sh deploy/clickhouse/dedupe-day.sh <容器名稱> <YYYY-MM-DD>
#   例:sh deploy/clickhouse/dedupe-day.sh giganexus-netops-test-netops-clickhouse-1 2026-11-11
# 什麼時候用:deploy/clickhouse/verify-ingest.sh 的「重複」不是 0 時(正常情況下去重 token 會擋掉重送,這裡處理例外,
#   例如資料錯誤拆批後又重送、或 FTP 補漏和 Syslog 重疊)。寫入動作,**由需求方同意後執行**。
# 做法:
#   1. OPTIMIZE … PARTITION <日> FINAL DEDUPLICATE:只刪「所有欄位都相同」的列(重送的列連 received_at 都相同;
#      不同的 log 不會被當成重複)。pa_traffic_logs、pa_threat_logs 都做
#   2. 那一天的彙總(pa_traffic_hourly_app / _src、熱力圖 pa_heat_*)和原始表筆數不同時重建(rebuild-day.sh;
#      物化檢視當初也算了重複的列;上次執行在刪除彙總之後、寫回之前中斷,重跑也會補建)
# 不能修正今天(台灣時間):今天還在寫入,重建彙總期間進來的列會被算兩次。以容器內 default 帳號(只允許容器本機)執行。
set -eu
C="${1:?用法:dedupe-day.sh <容器名稱> <YYYY-MM-DD>}"
D="${2:?缺少日期 YYYY-MM-DD}"
# case 比對整個字串(grep 逐行比對,多行參數可以繞過;值會直接放進 SQL)
case "$D" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "日期格式要 YYYY-MM-DD" >&2; exit 2 ;; esac
case "$C" in "" | *[!A-Za-z0-9_.-]*) echo "容器名稱只能是英數、底線、點與 -" >&2; exit 2 ;; esac
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

APP=$(ck "SELECT sum(sessions) FROM netops.pa_traffic_hourly_app WHERE toDate(hour) = toDate('$D')")
SRC=$(ck "SELECT sum(sessions) FROM netops.pa_traffic_hourly_src WHERE toDate(hour) = toDate('$D')")
# 熱力圖(V-a):每天格的 TRAFFIC 筆數與威脅筆數(log_type = 'threat')
HEAT=$(ck "SELECT sum(sessions) FROM netops.pa_heat_1d WHERE toDate(bucket) = toDate('$D')")
THR=$(ck "SELECT sum(thr_critical) + sum(thr_high) + sum(thr_medium) + sum(thr_low) + sum(thr_info) FROM netops.pa_heat_1d WHERE toDate(bucket) = toDate('$D')")
XT=$(ck "SELECT countIf(severity IN ('critical', 'high', 'medium', 'low', 'informational')) FROM netops.pa_threat_logs WHERE log_type = 'threat' AND toDate(event_time) = toDate('$D')")
echo "每小時彙總 $D:hourly_app $APP、hourly_src $SRC、heat_1d $HEAT(原始表 $T1);熱力圖威脅 $THR(原始 $XT)"
if [ "$APP" != "$T1" ] || [ "$SRC" != "$T1" ] || [ "$HEAT" != "$T1" ] || [ "$THR" != "$XT" ]; then
  # 物化檢視當初也算了重複的列;上次執行在刪除彙總之後、寫回之前中斷,重跑也會補建
  sh "$(dirname "$0")/rebuild-day.sh" "$C" "$D"
fi
echo "完成"
