#!/bin/sh
# 主機 3(正式區 WSL)產生 / 作廢 DC Agent 的 Token(AD-1):本人執行(AGENT.md §7.5)。
#   在主機 3 的 WSL:sudo sh host3-set-ad-secrets.sh <init|add|rotate|revoke|list|show> …   (與 host2-set-ad-secrets.sh 放在同一個目錄)
# 做法與路徑同 host2-set-ad-secrets.sh;Token 在主機 3 重新隨機產生(不沿用測試區)。另在 netops.env 補 NETOPS_AD_RECEIVER=0
# (deploy-prod 只在 1 時啟動 netops-ad-receiver;第一台 DC 試裝前由需求方改 1,deploy/RUNBOOK-ad.md §3)。
set -eu
ENV_FILE=/srv/giganexus/deploy/netops.env
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
grep -qx 'GW_ENV=prod' "$ENV_FILE" 2>/dev/null || { echo "$ENV_FILE 不是正式區設定(先執行 host3-set-secrets.sh)" >&2; exit 1; }
H="$(dirname "$0")/host2-set-ad-secrets.sh"
[ -f "$H" ] || { echo "找不到 $H(與本腳本放在同一個目錄)" >&2; exit 1; }
# 以 root 執行同目錄的腳本:腳本要屬於 root、群組與其他人不可寫(否則一般帳號改腳本就能拿到 root;資安審查 L2)
case "$(stat -c '%u %A' "$H")" in "0 -"????"-"??"-"*) ;; *) echo "$H 要屬於 root 且群組 / 其他人不可寫(先 sudo chown root:root、chmod 644)" >&2; exit 1 ;; esac
if [ "${1:-}" = init ] || [ "${1:-}" = add ]; then
  if ! grep -q '^NETOPS_AD_RECEIVER=' "$ENV_FILE"; then
    # 最後一行沒有換行時先補,避免黏在前一行(code review M5)
    [ -z "$(tail -c1 "$ENV_FILE")" ] || echo >> "$ENV_FILE"
    echo 'NETOPS_AD_RECEIVER=0' >> "$ENV_FILE"; echo "netops.env 新增 NETOPS_AD_RECEIVER=0"
  fi
fi
sh "$H" "$@"
