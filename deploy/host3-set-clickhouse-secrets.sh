#!/bin/sh
# 主機 3(正式區 WSL)準備 netops-clickhouse 的帳號與密碼:本人執行(AGENT.md §7.5)。
#   在主機 3 的 WSL:sudo sh host3-set-clickhouse-secrets.sh     (與 host2-set-clickhouse-secrets.sh 放在同一個目錄)
# 產生方式與內容同 host2-set-clickhouse-secrets.sh(該腳本不分部署區):ch_writer / ch_reader / ch_cold 三個密碼在**主機 3 重新隨機產生**
#   (不輸入、不顯示,不沿用測試區),clickhouse/netops-users.xml 只含雜湊。
# 正式區第一段不啟動 netops-clickhouse,但 netops-api 的 compose secrets(ch_reader_password、ch_cold_password)要有檔案,所以第一段就要執行。
# 帳號名稱 netops_writer / netops_reader / netops_cold 與測試區相同,但各在自己主機的 ClickHouse 容器內(兩區不共用伺服器,
#   和 SQL Server 兩區同一台、所以要另建 *_prod_app 的情況不同)。
set -eu
ENV_FILE=/srv/giganexus/deploy/netops.env
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
grep -qx 'GW_ENV=prod' "$ENV_FILE" 2>/dev/null || { echo "$ENV_FILE 不是正式區設定(先執行 host3-set-secrets.sh)" >&2; exit 1; }
H="$(dirname "$0")/host2-set-clickhouse-secrets.sh"
[ -f "$H" ] || { echo "找不到 $H(與本腳本放在同一個目錄)" >&2; exit 1; }
NETOPS_SECRETS_DIR=/srv/giganexus/netops-secrets sh "$H"
echo "正式區:netops-clickhouse 與建表在第二段(netops.env NETOPS_PA_PIPELINE=1)由 CI deploy-prod 執行(apply-schema.sh prod)。"
