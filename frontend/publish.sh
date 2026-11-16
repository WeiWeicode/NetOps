#!/bin/sh
# SPA 發佈 / 回滾(Gateway DEPLOYMENT.md §3.4;同 GigaItApp、giga-Portal 的 publish.sh),在一次性容器內執行,/srv/www 為 Nginx 共用的 named volume gw_www:
#   docker run --rm -v gw_www:/srv/www <映像>:<版本> publish netops
#   docker run --rm -v gw_www:/srv/www <映像>:<版本> rollback netops
# 以 symlink current 指向 releases/<版本>,以 rename 原子切換;保留最近 5 版;不需重啟或 reload Nginx。
set -eu
ACTION="${1:?publish|rollback}"
APP="${2:?app}"
# 只處理本系統的子路徑(gw_www 也放其他系統的 SPA,不可誤改)
[ "$APP" = netops ] || { echo "只能發佈 / 回滾 netops,收到:$APP" >&2; exit 1; }
SHA="${RELEASE_SHA:-$(cat /dist/RELEASE 2>/dev/null || date +%Y%m%d%H%M%S)}"
# 版本名稱會拼進路徑並 rm -rf:只允許英數與 . _ -,不可以 . 開頭
case "$SHA" in '' | .* | *[!A-Za-z0-9._-]*) echo "版本名稱不合法:$SHA" >&2; exit 1 ;; esac
ROOT="/srv/www/$APP"
KEEP="${KEEP_RELEASES:-5}"
mkdir -p "$ROOT/releases"

switch_to() {
  ln -sfn "releases/$1" "$ROOT/.current.tmp"
  mv -Tf "$ROOT/.current.tmp" "$ROOT/current"
  echo "$APP:current → $1"
}

case "$ACTION" in
  publish)
    [ -d "/dist/$APP" ] || { echo "映像檔內沒有 /dist/$APP" >&2; exit 1; }
    rm -rf "$ROOT/releases/$SHA.tmp"
    cp -a "/dist/$APP" "$ROOT/releases/$SHA.tmp"
    rm -rf "$ROOT/releases/$SHA"
    mv "$ROOT/releases/$SHA.tmp" "$ROOT/releases/$SHA"
    switch_to "$SHA"
    # 保留最近 $KEEP 版(不刪除 current 指向的版本)
    CUR="$(readlink "$ROOT/current" | sed 's#releases/##')"
    ls -1t "$ROOT/releases" | grep -v "^$CUR\$" | tail -n +"$KEEP" | while read -r old; do rm -rf "$ROOT/releases/$old"; done
    ;;
  rollback)
    [ -L "$ROOT/current" ] || { echo "尚未發佈過 $APP" >&2; exit 1; }
    CUR="$(readlink "$ROOT/current" | sed 's#releases/##')"
    # 排除發佈中斷留下的 .tmp
    PREV="$(ls -1t "$ROOT/releases" | grep -v "^$CUR\$" | grep -v '\.tmp$' | head -n 1)"
    [ -n "$PREV" ] || { echo "沒有可回滾的版本" >&2; exit 1; }
    switch_to "$PREV"
    ;;
  *) echo "未知動作:$ACTION" >&2; exit 1 ;;
esac
