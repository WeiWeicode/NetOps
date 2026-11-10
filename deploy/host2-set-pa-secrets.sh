#!/bin/sh
# 主機 2(測試區 WSL)準備 netops-pa(PA 即時監控收集器,R1)的機密與 Compose 變數:本人執行(AGENT.md §7.5)。
#   在主機 2 的 WSL:sudo sh deploy/host2-set-pa-secrets.sh
# 產生(已存在的不覆寫;要重建先刪除該檔):
#   /srv/giganexus/netops-secrets/pa_http_token   HTTP Log Forwarding 的 Token(自動產生 48 字隨機字串;交給網通設定 X-NetOps-Token)
#   /srv/giganexus/netops-secrets/pa_api_key      PA-560 唯讀帳號的 API Key(隱藏輸入;還沒拿到時直接 Enter,建立空檔,輪詢維持關閉)
#   /srv/giganexus/deploy/netops.env              PA_POLL_ENABLED=0、PA_RECEIVE_ENABLED=0 等(只補缺少的;測試區預設關閉,2026-11-05 需求方決定)
# 之後拿到 API Key:sudo rm /srv/giganexus/netops-secrets/pa_api_key 再執行一次本腳本。
# 不會顯示 API Key;Token 只在你要求時顯示在終端機(不要貼到聊天、Email 或工單)。
set -eu
umask 077
D=/srv/giganexus/netops-secrets
ENV_FILE=/srv/giganexus/deploy/netops.env
[ -d "$D" ] || { echo "找不到 $D(先執行 deploy/host2-set-secrets.sh)" >&2; exit 1; }

# ---------- HTTP 接收 Token(PA-560 HTTP Server Profile 的自訂標頭;docs/PA-FORWARDING-SPEC.md B.2) ----------
if [ ! -s "$D/pa_http_token" ]; then
  # 36 bytes 亂數 → base64url 48 字(netops-pa 要求至少 32 字)
  head -c 36 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$D/pa_http_token"
  [ "$(wc -c < "$D/pa_http_token")" -ge 32 ] || { echo "產生 Token 失敗" >&2; rm -f "$D/pa_http_token"; exit 1; }
  echo "已產生 pa_http_token"
fi

# ---------- PA-560 API Key(唯讀管理角色;docs/PA-FORWARDING-SPEC.md A) ----------
if [ ! -s "$D/pa_api_key" ]; then
  [ -t 0 ] || { echo "請在終端機執行(要隱藏輸入 API Key)" >&2; exit 1; }
  printf 'PA-560 API Key(輸入時不顯示;還沒有就直接按 Enter):'
  # 先設 trap 再關回顯:中斷時恢復終端機並結束
  trap 'stty echo' EXIT; trap 'stty echo; exit 130' INT TERM
  stty -echo; IFS= read -r PA_KEY; stty echo; trap - EXIT INT TERM; echo
  if [ -n "$PA_KEY" ]; then
    printf '%s' "$PA_KEY" > "$D/pa_api_key"; echo "已寫入 pa_api_key"
  else
    : > "$D/pa_api_key"; echo "pa_api_key 為空檔:SDK 輪詢維持關閉(PA_POLL_ENABLED=0)"
  fi
  unset PA_KEY
fi

chown 1000:1000 "$D/pa_http_token" "$D/pa_api_key"; chmod 400 "$D/pa_http_token" "$D/pa_api_key"

# ---------- 憑證目錄(選用;附錄 F.6。先建立空目錄,讓 Compose 掛載不會由 Docker 以 root 建立) ----------
T=/srv/giganexus/netops-pa-tls
[ -d "$T" ] || { mkdir -p "$T"; echo "已建立憑證目錄 $T(沒有憑證時保持空的)"; }
chown 1000:1000 "$T"; chmod 750 "$T"

# ---------- Compose 變數(只補缺少的) ----------
touch "$ENV_FILE"
add() { grep -q "^$1=" "$ENV_FILE" || { echo "$1=$2" >> "$ENV_FILE"; echo "netops.env 新增 $1"; }; }
add PA_POLL_ENABLED 0
add PA_RECEIVE_ENABLED 0
add PA_HOST ""
add PA_ALLOWED_SOURCES ""
chmod 644 "$ENV_FILE"

ls -l "$D/pa_http_token" "$D/pa_api_key"
echo "完成。開啟輪詢 / 接收的步驟見 docs/PA-FORWARDING-SPEC.md 附錄 F(PA_HOST、PA_ALLOWED_SOURCES 由你填,改完重跑 CI 部署或 docker compose up -d netops-pa)。"
echo "這次有新增或更換機密檔時:CI 不會因為檔案內容變了就重建 netops-pa,手動執行 pipeline 時帶變數 NETOPS_PA_RECREATE=1(重建後請網通對 netops-syslog 再 Commit)。"
if [ "${1:-}" = "--show-token" ]; then
  echo "---- pa_http_token(交給網通設定 X-NetOps-Token;不要貼到聊天、Email 或工單) ----"
  cat "$D/pa_http_token"; echo
fi
