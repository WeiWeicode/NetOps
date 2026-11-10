#!/bin/sh
# 建立 / 更新 netops-clickhouse 資料表(C1;CI deploy-api-test 在 netops-clickhouse 啟動後執行,可重複執行)
#   sh deploy/clickhouse/apply-schema.sh <test|prod> <容器名稱>
#   例:sh deploy/clickhouse/apply-schema.sh test giganexus-netops-test-netops-clickhouse-1
# 以容器內 default 帳號(只允許容器本機連線,deploy/clickhouse/users.d/default.xml)執行,不需要密碼。
# TTL 依部署區(手冊 §10.3、決策 CQ2 / CQ12):測試區全部 3 天;正式區 TRAFFIC 30 天、威脅類 90 天、App 彙總 13 個月、來源彙總 90 天。
set -eu
ENV="${1:?用法:apply-schema.sh <test|prod> <容器名稱>}"
CONTAINER="${2:?缺少容器名稱}"
case "$ENV" in
  test) T_TRAFFIC='3 DAY'; T_THREAT='3 DAY'; T_APP='3 DAY'; T_SRC='3 DAY' ;;
  prod) T_TRAFFIC='30 DAY'; T_THREAT='90 DAY'; T_APP='13 MONTH'; T_SRC='90 DAY' ;;
  *) echo "部署區只能是 test 或 prod:$ENV" >&2; exit 2 ;;
esac
DIR="$(dirname "$0")"
ch() { docker exec -i "$CONTAINER" clickhouse-client "$@"; }

sed -e "s/{{TTL_TRAFFIC}}/$T_TRAFFIC/" -e "s/{{TTL_THREAT}}/$T_THREAT/" \
    -e "s/{{TTL_HOURLY_APP}}/$T_APP/" -e "s/{{TTL_HOURLY_SRC}}/$T_SRC/" "$DIR/schema.sql" | ch --multiquery

# 已存在的表:TTL 和部署區設定不同時才改(只改中繼資料,既有資料不重算:materialize_ttl_after_modify=0)
#   engine_full 裡的 TTL 寫成 toIntervalDay(3) / toIntervalMonth(13)
modify() { # 表名 時間欄 "N DAY|N MONTH"
  n="${3% *}"; unit="${3#* }"
  case "$unit" in DAY) fn=toIntervalDay ;; MONTH) fn=toIntervalMonth ;; *) echo "不支援的 TTL 單位:$3" >&2; exit 2 ;; esac
  cur="$(ch --query "SELECT engine_full FROM system.tables WHERE database = 'netops' AND name = '$1'")"
  case "$cur" in *"$fn($n)"*) return 0 ;; esac
  echo "netops.$1 TTL → $3"
  ch --materialize_ttl_after_modify=0 --query "ALTER TABLE netops.$1 MODIFY TTL $2 + INTERVAL $3 DELETE"
}
modify pa_traffic_logs event_time "$T_TRAFFIC"
modify pa_threat_logs event_time "$T_THREAT"
modify pa_traffic_hourly_app hour "$T_APP"
modify pa_traffic_hourly_src hour "$T_SRC"

ch --query "SELECT name, total_rows, formatReadableSize(total_bytes) AS size, extract(engine_full, 'TTL [^S]*') AS ttl FROM system.tables WHERE database = 'netops' AND engine LIKE '%MergeTree' ORDER BY name FORMAT PrettyCompactMonoBlock"
