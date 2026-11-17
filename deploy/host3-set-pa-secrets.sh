#!/bin/sh
# 主機 3(正式區 WSL)準備 netops-pa(PA 收集器)的機密與 Compose 變數:本人執行(AGENT.md §7.5)。
#   在主機 3 的 WSL:sudo sh host3-set-pa-secrets.sh [--show-token]    (與 host2-set-pa-secrets.sh 放在同一個目錄)
# 產生方式同 host2-set-pa-secrets.sh(路徑兩區相同):pa_http_token 在主機 3 重新隨機產生(不沿用測試區)、pa_api_key 隱藏輸入
#   (正式區要用網通另建、只開 XML API Operational Requests / Log 的專用帳號產生的 Key,IMPL-PLAN D2;還沒拿到直接 Enter 建空檔)、
#   憑證目錄 /srv/giganexus/netops-pa-tls、netops.env 的 PA_POLL_ENABLED=0、PA_RECEIVE_ENABLED=0、PA_QUERY_ENABLED=0。
# 第一段不啟動 netops-pa,但 compose secrets 要有檔案,所以第一段就執行(API Key 可先留空);第二段拿到 Key 後刪除 pa_api_key 再執行一次。
# PA-560 管理介面是出廠自簽憑證時,正式區可在 netops.env 設 PA_TLS_INSECURE=1(需求方 2026-11-17);否則 PA-560 管理介面憑證與接收端憑證由 host3-pa-pki.sh(NetOps 專用 CA)產生後設 PA_CA_FILE 等(RUNBOOK-prod.md §4.1)。
set -eu
ENV_FILE=/srv/giganexus/deploy/netops.env
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
grep -qx 'GW_ENV=prod' "$ENV_FILE" 2>/dev/null || { echo "$ENV_FILE 不是正式區設定(先執行 host3-set-secrets.sh)" >&2; exit 1; }
H="$(dirname "$0")/host2-set-pa-secrets.sh"
[ -f "$H" ] || { echo "找不到 $H(與本腳本放在同一個目錄)" >&2; exit 1; }
sh "$H" "$@"
echo "正式區:開啟接收前先完成 deploy/RUNBOOK-prod.md §4(portproxy、防火牆、憑證);PA_RECEIVE_PLAINTEXT 要需求方決定才設。"
