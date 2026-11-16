#!/bin/sh
# 將 deploy/gateway-rbac.yaml(畫面權限、角色 netops-admin / netops-viewer)套用到測試區 / 正式區 Gateway
# (以 Gateway compose 的 migrate 服務映像執行 CLI apply;與 GigaItApp、giga-Portal 的 deploy/apply-gateway-rbac.sh 相同作法)。
# 需要:Gateway 已部署;Gateway 的 deploy/ 目錄(主機上為共用目錄 /srv/giganexus/shared/giga-api-gateway-bff,以 GATEWAY_DIR 指定;
#       未指定時用兄弟目錄 ../giga-api-gateway-bff);IMAGE_TAG、REGISTRY 指向該區 Gateway 的映像(CI 由 gateway-image-tag 讀入)。
# 用法:
#   sh deploy/apply-gateway-rbac.sh test <Gateway 區域 env 檔>      # CI rbac-test 自動執行
# 路由不用本腳本:netops-api 啟動時自動註冊為草稿(BACKEND-GUIDE §7.5)。
set -eu
ZONE="${1:?用法:sh deploy/apply-gateway-rbac.sh <test|prod> <Gateway 區域 env 檔>}"
ENV_FILE="${2:?用法:sh deploy/apply-gateway-rbac.sh <test|prod> <Gateway 區域 env 檔>}"
case "$ZONE" in test | prod) ;; *) echo "區域只能是 test 或 prod" >&2; exit 1 ;; esac
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
# Git Bash:以 Windows 路徑(D:/...)交給 Docker Desktop,並關閉 MSYS 的路徑轉換
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
ENV_ABS="$(cd "$(dirname "$ENV_FILE")" && (pwd -W 2>/dev/null || pwd))/$(basename "$ENV_FILE")"
GW="${GATEWAY_DIR:-$HERE/../../giga-api-gateway-bff}/deploy"

# 範圍檢查:CLI apply 不限系統,本檔只能動 NetOps 自己的節點(security-auditor 2026-11-04)
#   頂層只允許 permissions / roles;代碼、上層、includes、角色權限都必須是 netops.* / netops-*;不得設定 adGroups / companies
F="$HERE/gateway-rbac.yaml"
Y="$(sed 's/#.*//' "$F")"
fail() { echo "gateway-rbac.yaml 超出 NetOps 範圍:$1" >&2; exit 1; }
B="$(printf '%s\n' "$Y" | grep -E '^[^[:space:]]' | grep -vE '^(permissions|roles):[[:space:]]*$' || true)"
[ -z "$B" ] || fail "頂層只能有 permissions、roles:$B"
B="$(printf '%s\n' "$Y" | grep -E 'adGroups|companies' || true)"
[ -z "$B" ] || fail "不得設定 adGroups / companies"
B="$(printf '%s\n' "$Y" | grep -oE '(code|parent):[[:space:]]*[^[:space:],}]+' | grep -vE ':[[:space:]]*netops[.-]' || true)"
[ -z "$B" ] || fail "代碼須為 netops.* / netops-*:$B"
B="$(printf '%s\n' "$Y" | grep -oE 'includes:[[:space:]]*\[[^]]*\]' | sed 's/.*\[//; s/\]//' | tr ',' '\n' | tr -d ' ' | grep -v '^$' | grep -v '^netops\.' || true)"
[ -z "$B" ] || fail "includes 只能是 netops.* API 權限:$B"
B="$(printf '%s\n' "$Y" | grep -E '^[[:space:]]+-[[:space:]]+[^{[:space:]]' | grep -vE '^[[:space:]]+-[[:space:]]+code:' | grep -vE '^[[:space:]]+-[[:space:]]+netops\.' || true)"
[ -z "$B" ] || fail "角色權限只能是 netops.*:$B"

cd "$GW"
docker compose --env-file "$ENV_ABS" -f docker-compose.yml -f "docker-compose.$ZONE.yml" --profile tools run --rm --no-deps -T \
  -v "$HERE/gateway-rbac.yaml:/netops/gateway-rbac.yaml:ro" \
  migrate node dist/bff/src/cli/index.js apply --file /netops/gateway-rbac.yaml --actor NetOps
