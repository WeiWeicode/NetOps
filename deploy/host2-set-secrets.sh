#!/bin/sh
# 主機 2(測試區 WSL)準備 netops-api 的機密與 Compose 變數:本人執行(AGENT.md §7.5;比照 giga-Portal、giga-file-service)。
#   在主機 2 的 WSL:sudo sh host2-set-secrets.sh
# 產生(已存在的不覆寫;要重建先刪除該檔):
#   /srv/giganexus/netops-secrets/   gw_api_key(Gateway CLI client:create --code netops-api;自動註冊 OpenAPI 草稿用)、
#                                    monitor_api_key(B0 為空檔:giga-observe 拓樸尚未登記 netops-api,監控停用;D1 刪除後改寫為 ingest Key)
#   /srv/giganexus/deploy/netops.env Compose 變數(範本 test.env.example)
# 注意:client:create 再次執行即換發,舊金鑰立即失效;gw_api_key 已存在時本腳本不會重建
set -eu
# 暫存檔(含 Key)只有本人可讀,結束或中斷時刪除
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
D=/srv/giganexus/netops-secrets
ENV_FILE=/srv/giganexus/deploy/netops.env
GW_ENV_FILE=/srv/giganexus/deploy/test.env
GW_SHARED=/srv/giganexus/shared
mkdir -p "$D"
# 目錄要讓 CI(gitlab-runner)確認檔案存在、docker compose 掛載;檔案本身於最後改為 uid 1000 / 400
chmod 755 "$D"

# ---------- Gateway API Key(自動註冊 OpenAPI 草稿用;代碼必須等於上游 netops-api) ----------
if [ ! -f "$D/gw_api_key" ]; then
  G="$GW_SHARED/giga-api-gateway-bff/deploy"
  TAG="$(cat "$GW_SHARED/gateway-image-tag")"
  (cd "$G" && IMAGE_TAG="$TAG" REGISTRY=10.10.130.123:5050/giganexus/giga-api-gateway-bff \
    docker compose --env-file "$GW_ENV_FILE" -f docker-compose.yml -f docker-compose.test.yml --profile tools run --rm --no-deps -T \
    migrate node dist/bff/src/cli/index.js client:create --code netops-api --name "資訊網通管理系統 netops-api" --actor NetOps) > "$TMP/key.json"
  sed -n 's/^  "key": "\(.*\)",\{0,1\}$/\1/p' "$TMP/key.json" | tr -d '\n' > "$D/gw_api_key"
  grep -v '"key"' "$TMP/key.json"
  [ -s "$D/gw_api_key" ] || { echo "取不到 API Key,請檢查上方輸出" >&2; rm -f "$D/gw_api_key"; exit 1; }
fi

# ---------- giga-observe 監控 Key(B0 留空檔,監控停用;D1 登記拓樸後刪除此檔,改用 createApiKey.js 建立) ----------
[ -f "$D/monitor_api_key" ] || : > "$D/monitor_api_key"

# 只限縮檔案(目錄需讓 CI 的 docker compose 讀得到 secret 路徑)
chown 1000:1000 "$D"/*; chmod 400 "$D"/*

# ---------- Compose 變數(只補缺少的) ----------
touch "$ENV_FILE"
add() { grep -q "^$1=" "$ENV_FILE" || { echo "$1=$2" >> "$ENV_FILE"; echo "netops.env 新增 $1"; }; }
add GW_ENV test
add GW_BASE_URL https://giganexus-test.gigasolar.com.tw
add GW_NETWORK giganexus-gw_default
add NETOPS_SECRETS_DIR "$D"
# 不含機密;umask 077 建出的檔案 CI(gitlab-runner)讀不到,改為所有人可讀
chmod 644 "$ENV_FILE"

ls -l "$D"
echo "完成。之後 develop 合併由 CI 部署 netops-api;部署後在 GigaItApp「服務與路由」審查 netops-api 的路由草稿並發佈。"
