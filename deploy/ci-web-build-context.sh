#!/bin/sh
# CI check:frontend:用「Docker 建置看得到的檔案」再跑一次 vite build(2026-11-13 部署建置失敗的防呆)。
#   sh deploy/ci-web-build-context.sh        # 在 repo 根目錄執行;frontend/ 已 npm ci
# 為什麼:check:frontend 在完整 repo 裡 build,看得到 test/;spa-netops 映像的建置內容排除 frontend/.dockerignore 列的路徑(test 等),
#   vite.config.ts 載入的檔案(mock/ 等)若 import 被排除的檔案,只有部署時才會失敗(pipeline 920 deploy-web-test)。
# 做法:把 frontend/ 版控內的檔案(和 CI checkout、Docker COPY 一致)扣掉 .dockerignore 的路徑,複製到 frontend/.build-context/,
#   在那裡 npm run build。套件沿用 frontend/node_modules(Node 往上層找,不用連結);相對路徑的 import(../test/…)不會往上找,
#   所以被排除的檔案一樣會失敗。結束時刪除暫存目錄。
# .dockerignore 的寫法只支援本 repo 用到的:根目錄的名稱或萬用字元(test、dist、*.local、.env*),不支援 ! 與 **。
set -euf  # -f:.dockerignore 的萬用字元不能被 shell 展開
cd "$(dirname "$0")/../frontend"
ctx="$PWD/.build-context"
rm -rf "$ctx"
mkdir "$ctx"
trap 'rm -rf "$ctx"' EXIT

patterns="$(grep -v '^[[:space:]]*#' .dockerignore | sed 's/[[:space:]]*$//; s#^/##; s#/$##' | grep -v '^$' || true)"
excluded() {
  for p in $patterns; do
    # shellcheck disable=SC2254
    case "$1" in $p | $p/*) return 0 ;; esac
  done
  return 1
}

git ls-files | while IFS= read -r f; do
  excluded "$f" || printf '%s\n' "$f"
done > "$ctx/.files"
[ -s "$ctx/.files" ] || { echo "ci-web-build-context:沒有檔案可複製" >&2; exit 1; }
tar -cf - -T "$ctx/.files" | tar -xf - -C "$ctx"
rm "$ctx/.files"
echo "ci-web-build-context:排除 $(echo "$patterns" | tr '\n' ' ')後建置" >&2
cd "$ctx"
npm run build
