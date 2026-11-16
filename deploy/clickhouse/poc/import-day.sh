#!/bin/sh
# C1 POC:從 FTP 匯入一整天的 TRAFFIC 到 ClickHouse,記錄每個檔案的筆數與秒數(docs/test-reports/2026-11-10-clickhouse-c1.md)。
#   在主機 2 的 WSL(root):sh import-day.sh <檔名日期,例:2026_11_10> <ClickHouse 容器> [netops-api 容器]
#   FTP 檔名 PA-560_traffic_<日期>_last_calendar_day_<n>.csv 是「前一天」的 log(PA-560 每天早上匯出前一天)
# FTP 唯讀、原始 log 不落地:ftp-cat.mjs 在 netops-api 容器內用既有 FTP 設定與機密串流讀檔,經管線直接送進 ClickHouse(本腳本不碰帳密)。
# 一次一個檔、一條 FTP 連線(與舊版 IIS 同時同步,控制 FTP 負載;AGENT.md §6)。
# 這是 POC 工具;正式的補漏匯入在 C2 / C3 由 netops-ingest 實作(手冊 §11.3)。
set -eu
DAY="${1:?用法:import-day.sh <檔名日期 2026_11_10> <ClickHouse 容器> [netops-api 容器]}"
CH="${2:?缺少 ClickHouse 容器名稱}"
API="${3:-giganexus-netops-test-netops-api-1}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${LOG_DIR:-/root/netops-c1/log}"
FTP_DIR="${FTP_DIR:-/my-data}"
case "$DAY" in *[!0-9_]*) echo "日期格式錯誤:$DAY" >&2; exit 2 ;; esac
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/import-$DAY.tsv"

ftp() { docker exec -i "$API" node --input-type=module - "$@" < "$DIR/ftp-cat.mjs"; }

ftp list "$FTP_DIR" | grep "\"PA-560_traffic_${DAY}_last_calendar_day_" \
  | sed -E 's/.*"name":"([^"]+)".*"size":([0-9]+).*/\1 \2/' | sort -t_ -k9 -n > "$LOG_DIR/files-$DAY.txt"
N="$(wc -l < "$LOG_DIR/files-$DAY.txt")"
[ "$N" -gt 0 ] || { echo "FTP 上沒有 $DAY 的 TRAFFIC 檔" >&2; exit 1; }
echo "共 $N 個檔,$(awk '{s+=$2} END {printf "%.2f GB", s/1e9}' "$LOG_DIR/files-$DAY.txt")"
printf 'file\tbytes\trows_before\trows_after\tseconds\n' > "$OUT"

T0="$(date +%s)"
i=0
while read -r name size; do
  i=$((i + 1))
  before="$(docker exec "$CH" clickhouse-client -q 'SELECT count() FROM netops.pa_traffic_logs')"
  s="$(date +%s.%N)"
  ftp cat "$FTP_DIR/$name" | docker exec -i "$CH" clickhouse-client --query "$(cat "$DIR/import-day.sql")"
  e="$(date +%s.%N)"
  after="$(docker exec "$CH" clickhouse-client -q 'SELECT count() FROM netops.pa_traffic_logs')"
  printf '%s\t%s\t%s\t%s\t%.1f\n' "$name" "$size" "$before" "$after" "$(awk -v a="$s" -v b="$e" 'BEGIN {print b - a}')" >> "$OUT"
  echo "[$i/$N] $name $((after - before)) 筆"
  # 管線在 dash 沒有 pipefail:FTP 中途斷線時 ClickHouse 可能只收到一部分。PA-560 匯出每檔 65,535 筆(最後一檔除外)
  [ "$i" = "$N" ] || [ "$((after - before))" = 65535 ] || echo "  警告:$name 筆數不是 65535,可能沒有讀完" >&2
done < "$LOG_DIR/files-$DAY.txt"
echo "完成:$(( $(date +%s) - T0 )) 秒;明細 $OUT"
