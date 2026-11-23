#!/bin/sh
# 主機 2(測試區 WSL)產生 / 作廢 DC Agent 的 Token(AD-1;docs/AD-AGENT-PLAN.md §4.1、§7 第 1 點,審查 H3):本人執行(AGENT.md §7.5)。
#   sudo sh deploy/host2-set-ad-secrets.sh init                          建立空的對應表(Compose 載入時就要有這個檔)
#   sudo sh deploy/host2-set-ad-secrets.sh add <COMPUTER> <DOMAIN>       新增一台 DC,產生它專屬的 Token(例:add GSMC-DC1 gsmc.com.tw)
#   sudo sh deploy/host2-set-ad-secrets.sh rotate <COMPUTER>             換一把新 Token(舊的立即作廢;DC 端要換成新 Token)
#   sudo sh deploy/host2-set-ad-secrets.sh revoke <COMPUTER>             作廢這台 DC(刪掉對應表那一行與 Token 檔)
#   sudo sh deploy/host2-set-ad-secrets.sh list                          列出已登記的 DC(不顯示 Token)
#   sudo sh deploy/host2-set-ad-secrets.sh show <COMPUTER>               在終端機顯示該 DC 的 Token(安裝 Agent 時用;不要貼到聊天、Email 或工單)
#   sudo sh deploy/host2-set-ad-secrets.sh forget <COMPUTER>             Agent 裝好後刪掉主機上的 Token 明文檔(對應表不變;之後要再裝用 rotate)
# 產生:
#   /srv/giganexus/netops-secrets/ad_agent_tokens          對應表,一行一台:<COMPUTER> <DOMAIN> <sha256(Token)>;只存雜湊,
#                                                          netops-ad-receiver 以 Docker secret 唯讀讀取(uid 1000、400)
#   /srv/giganexus/netops-ad-dc-tokens/<COMPUTER>.token    該 DC 的 Token 明文(root、400;交給 DC 安裝 Agent 後可刪除)
# Token:32 bytes 亂數的十六進位(64 字)。不顯示在畫面(除非 show)、不寫進日誌。
# 改完對應表要重建 netops-ad-receiver 才生效(只重建它,不動 netops-pa、netops-redis):
#   docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml up -d --no-deps --wait --force-recreate netops-ad-receiver
set -eu
umask 077
D=/srv/giganexus/netops-secrets
F="$D/ad_agent_tokens"
T=/srv/giganexus/netops-ad-dc-tokens
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
[ -d "$D" ] || { echo "找不到 $D(先執行 deploy/host2-set-secrets.sh)" >&2; exit 1; }

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
CMD="${1:-}"
[ -n "$CMD" ] || usage

# 名稱格式和 netops-ad-receiver(backend/src/ad-receiver/tokens.ts)相同
check_computer() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$' || { echo "COMPUTER 格式錯誤(英數與 -,最長 63 字):$1" >&2; exit 2; }; }
check_domain() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$' && [ "${#1}" -le 253 ] \
    || { echo "DOMAIN 格式錯誤(DNS 名稱,例 gsmc.com.tw):$1" >&2; exit 2; }
}
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
# 對應表裡這台 DC 的那一行(不分大小寫);沒有回空字串
line_of() { awk -v c="$(upper "$1")" '!/^#/ && NF == 3 { if (toupper($1) == c) print }' "$F"; }

init_file() {
  if [ ! -f "$F" ]; then
    printf '# NetOps AD Agent Token 對應表(AD-1):<COMPUTER> <DOMAIN> <sha256(Token)>;由 deploy/host2-set-ad-secrets.sh 維護,不要手動貼 Token 明文\n' > "$F"
    echo "已建立 $F(還沒有任何 DC;netops-ad-receiver 至少要有一台才會啟動)"
  fi
  chown 1000:1000 "$F"; chmod 400 "$F"
  [ -d "$T" ] || mkdir -p "$T"
  chown root:root "$T"; chmod 700 "$T"
}

# 產生新 Token 並寫入:先寫暫存檔再改名(不會留下寫一半的對應表)
write_entry() { # COMPUTER DOMAIN
  tok="$(head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n')"
  [ "${#tok}" -eq 64 ] || { echo "產生 Token 失敗" >&2; exit 1; }
  hash="$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)"
  tmp="$(mktemp "$D/.ad_agent_tokens.XXXXXX")"
  awk -v c="$(upper "$1")" '/^#/ || NF != 3 || toupper($1) != c' "$F" > "$tmp"
  printf '%s %s %s\n' "$1" "$2" "$hash" >> "$tmp"
  chown 1000:1000 "$tmp"; chmod 400 "$tmp"
  mv -f "$tmp" "$F"
  rm -f "$T/$1.token"
  printf '%s' "$tok" > "$T/$1.token"
  chown root:root "$T/$1.token"; chmod 400 "$T/$1.token"
  unset tok
}

remind() {
  echo "要讓 netops-ad-receiver 讀到新的對應表(只重建它,不影響 netops-pa):"
  echo "  docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml up -d --no-deps --wait --force-recreate netops-ad-receiver"
}

case "$CMD" in
  init)
    init_file
    ;;
  add)
    [ $# -eq 3 ] || usage
    check_computer "$2"; check_domain "$3"
    init_file
    [ -z "$(line_of "$2")" ] || { echo "$2 已登記;要換 Token 用 rotate,要改網域先 revoke 再 add" >&2; exit 1; }
    write_entry "$2" "$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]')"
    echo "已新增 $2;Token 存在 $T/$2.token(root 才能讀),安裝 Agent 時再用 show 顯示或安全地複製到 DC"
    remind
    ;;
  rotate)
    [ $# -eq 2 ] || usage
    check_computer "$2"; init_file
    l="$(line_of "$2")"; [ -n "$l" ] || { echo "$2 沒有登記" >&2; exit 1; }
    set -- $l
    write_entry "$1" "$2"
    echo "已換新 $1 的 Token(舊 Token 在重建 netops-ad-receiver 後失效;DC 端要換成新 Token)"
    remind
    ;;
  revoke)
    [ $# -eq 2 ] || usage
    check_computer "$2"; init_file
    [ -n "$(line_of "$2")" ] || { echo "$2 沒有登記" >&2; exit 1; }
    tmp="$(mktemp "$D/.ad_agent_tokens.XXXXXX")"
    awk -v c="$(upper "$2")" '/^#/ || NF != 3 || toupper($1) != c' "$F" > "$tmp"
    chown 1000:1000 "$tmp"; chmod 400 "$tmp"; mv -f "$tmp" "$F"
    for x in "$T"/*.token; do [ -e "$x" ] || continue; b="$(basename "$x" .token)"; [ "$(upper "$b")" = "$(upper "$2")" ] && rm -f "$x"; done
    echo "已作廢 $2(Redis 裡這台的心跳與 computers 名單由維運以 redis-cli 清除,docs/AD-AGENT-PLAN.md §4.2)"
    remind
    ;;
  list)
    init_file
    awk '!/^#/ && NF == 3 { print $1, $2 }' "$F"
    ;;
  show)
    [ $# -eq 2 ] || usage
    check_computer "$2"; init_file
    [ -t 1 ] || { echo "只在終端機顯示(不要導到檔案或日誌)" >&2; exit 1; }
    l="$(line_of "$2")"; [ -n "$l" ] || { echo "$2 沒有登記" >&2; exit 1; }
    set -- $l   # 用登記時的大小寫找檔案
    [ -s "$T/$1.token" ] || { echo "找不到 $T/$1.token(已 forget;要重新安裝用 rotate)" >&2; exit 1; }
    echo "---- $1 的 Token(寫進 DC 的 ad_agent.token;不要貼到聊天、Email 或工單;用完執行 clear) ----"
    cat "$T/$1.token"; echo
    ;;
  forget)
    [ $# -eq 2 ] || usage
    check_computer "$2"; init_file
    l="$(line_of "$2")"; [ -n "$l" ] || { echo "$2 沒有登記" >&2; exit 1; }
    set -- $l
    rm -f "$T/$1.token"
    echo "已刪除 $T/$1.token(對應表不變,DC 照常連線)"
    ;;
  *) usage ;;
esac
