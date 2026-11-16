#!/bin/sh
# 升級測試(CI check:ingest-int):已經在跑的舊版資料庫,套用現在的 apply-schema.sh 要成功。
#   sh deploy/clickhouse/test-upgrade.sh <容器名稱>
# 只給 CI 的一次性 ClickHouse 容器用:開頭與結尾都會 DROP DATABASE netops,**不可對測試區 / 正式區的容器執行**。
# 2026-11-12 起測試區部署失敗:schema.sql 的 MV 用到 migrations/003 才加的欄位,舊表少欄位 → MV 建立失敗 → migrations 沒執行。
# CI 原本只從空資料庫建表,抓不到這種「舊表 + 新 schema」的問題。
# 步驟:套用 upgrade-test/before-va.sql(V-a 合併前的 schema)→ 舊版寫一列 → apply-schema.sh 兩次(可重複執行)
#       → 檢查欄位、物化檢視、新寫入的列有進彙總與熱力圖 → 刪掉資料庫(後面的步驟從空資料庫建表)。
set -eu
C="${1:?用法:test-upgrade.sh <容器名稱>}"
case "$C" in netops-int-*) ;; *) echo "只能對 CI 的一次性容器(netops-int-*)執行:$C" >&2; exit 2 ;; esac
DIR="$(dirname "$0")"
ck() { docker exec -i "$C" clickhouse-client "$@"; }
fail() { echo "FAIL 升級測試:$*" >&2; exit 1; }

ck --query "DROP DATABASE IF EXISTS netops SYNC"
ck --multiquery < "$DIR/upgrade-test/before-va.sql"
ck --async_insert=0 --query "INSERT INTO netops.pa_traffic_logs (event_time, received_at, src, app, action, bytes, bytes_sent, bytes_recv, source)
  VALUES (now(), now64(3), '::ffff:10.9.9.1', 'upg-old', 'allow', 100, 60, 40, 'syslog')"
[ "$(ck --query "SELECT count() FROM system.columns WHERE database = 'netops' AND table = 'pa_traffic_hourly_src' AND name = 'bytes_sent'")" = 0 ] \
  || fail "舊版 schema 不應該有 pa_traffic_hourly_src.bytes_sent(upgrade-test/before-va.sql 被改過?)"

sh "$DIR/apply-schema.sh" test "$C" >/dev/null || fail "apply-schema.sh 第 1 次失敗"
sh "$DIR/apply-schema.sh" test "$C" >/dev/null || fail "apply-schema.sh 第 2 次失敗(要可重複執行)"

N=$(ck --query "SELECT count() FROM system.columns WHERE database = 'netops' AND table = 'pa_traffic_hourly_src' AND name IN ('bytes_sent', 'bytes_recv')")
[ "$N" = 2 ] || fail "pa_traffic_hourly_src 上傳 / 下載欄位 $N / 2"
MV=$(ck --query "SELECT count() FROM system.tables WHERE database = 'netops' AND engine = 'MaterializedView'")
[ "$MV" = 8 ] || fail "物化檢視 $MV 個(應為 8:hourly_app、hourly_src、熱力圖 6 個)"
ck --query "SELECT create_table_query FROM system.tables WHERE database = 'netops' AND name = 'pa_traffic_hourly_src_mv'" | grep -q bytes_recv \
  || fail "pa_traffic_hourly_src_mv 沒有改成新的查詢(migrations/003 沒執行?)"

# 升級後的寫入:每小時來源彙總有上傳 / 下載、熱力圖三個粒度都有
ck --async_insert=0 --query "INSERT INTO netops.pa_traffic_logs (event_time, received_at, src, app, action, bytes, bytes_sent, bytes_recv, source)
  VALUES (now(), now64(3), '::ffff:10.9.9.2', 'upg-new', 'deny', 10, 7, 3, 'syslog')"
R=$(ck --query "SELECT sum(sessions), sum(bytes_sent), sum(bytes_recv) FROM netops.pa_traffic_hourly_src WHERE src = toIPv6('::ffff:10.9.9.2') FORMAT TSV" | tr '\t' ' ')
[ "$R" = "1 7 3" ] || fail "升級後 pa_traffic_hourly_src = $R(應為 1 7 3)"
for t in pa_heat_5m pa_heat_1h pa_heat_1d; do
  H=$(ck --query "SELECT sum(deny) FROM netops.$t")
  [ "$H" = 1 ] || fail "升級後 $t deny = $H(應為 1)"
done

ck --query "DROP DATABASE netops SYNC"
echo "OK   升級測試:V-a 前的 schema → apply-schema.sh(兩次)"
