#!/bin/sh
# 主機 2(測試區 WSL)準備 netops-api 的機密與 Compose 變數:本人執行(AGENT.md §7.5;比照 giga-Portal、giga-file-service)。
#   在主機 2 的 WSL:sudo sh host2-set-secrets.sh
# 產生(已存在的不覆寫;要重建先刪除該檔):
#   /srv/giganexus/netops-secrets/   gw_api_key(Gateway CLI client:create --code netops-api;自動註冊 OpenAPI 草稿用)、
#                                    monitor_api_key(giga-observe ingest Key,服務 netops-api;B0 留下的空檔會改寫為 Key;D1)、
#                                    ftp_password(FTP 唯讀帳號密碼,執行時隱藏輸入;B1)、
#                                    qdrant_api_key(AI 主機 Qdrant 的 API Key,與舊版 IIS server/.env 的 QDRANT_API_KEY 相同,執行時隱藏輸入;A1)
#   /srv/giga-netops/test            資料目錄(uid 1000 可寫;B1)
#   /srv/giganexus/deploy/netops.env Compose 變數(範本 test.env.example;FTP_USER 執行時輸入)
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

# ---------- giga-observe 監控 Key(ingest,服務 netops-api;D1。比照 giga-Portal host2-set-api-secrets.sh) ----------
# 檔案不存在或為空(B0 留下的空檔)才建立;Key 明文只寫進機密檔,不顯示。每執行一次 createApiKey 就多一把 Key,已有 Key 時不重建
if [ ! -s "$D/monitor_api_key" ]; then
  (cd /srv/giganexus/giga-observe && docker compose --env-file deploy/test.env exec -T gno-backend \
    node src/scripts/createApiKey.js --service netops-api --scope ingest --label "資訊網通管理系統 netops-api") > "$TMP/obs.txt" \
    || { echo "建立監控 Key 失敗(giga-observe gno-backend 是否運作中?);監控會停用,服務仍可啟動,稍後可重跑本腳本" >&2; : > "$TMP/obs.txt"; }
  sed -n 's/^  key *: *//p' "$TMP/obs.txt" | tr -d '\r\n' > "$TMP/monitor_api_key"
  if [ -s "$TMP/monitor_api_key" ]; then
    rm -f "$D/monitor_api_key"; mv "$TMP/monitor_api_key" "$D/monitor_api_key"
    # 立即限縮(腳本之後中斷時,容器仍讀得到)
    chown 1000:1000 "$D/monitor_api_key"; chmod 400 "$D/monitor_api_key"; echo "已建立監控 Key(netops-api)"
  else
    # 不印 createApiKey 的輸出(格式改變時可能含 Key 明文),只提示去 giga-observe 查看
    echo "取不到監控 Key:監控維持停用,服務仍可啟動;排除後重跑本腳本。若上方顯示已建立,請在 giga-observe 撤銷 netops-api 多出的 Key" >&2
    [ -f "$D/monitor_api_key" ] || : > "$D/monitor_api_key"
  fi
fi

# ---------- FTP 密碼(B1;舊版 IIS server/.env 的 FTP_PWD 同一個帳號,隱藏輸入,不顯示、不寫進歷史) ----------
if [ ! -s "$D/ftp_password" ]; then
  [ -t 0 ] || { echo "請在終端機執行(要隱藏輸入 FTP 密碼)" >&2; exit 1; }
  printf 'FTP 密碼(與舊版 FTP_USER 同一個帳號;輸入時不顯示):'
  # 中斷時恢復終端機回顯,並保留刪除暫存目錄
  stty -echo; trap 'stty echo; rm -rf "$TMP"' EXIT; IFS= read -r FTP_PWD; stty echo; echo
  [ -n "$FTP_PWD" ] || { echo "未輸入 FTP 密碼" >&2; exit 1; }
  printf '%s' "$FTP_PWD" > "$D/ftp_password"; unset FTP_PWD
fi

# ---------- Qdrant API Key(A1;舊版 IIS server/.env 的 QDRANT_API_KEY,隱藏輸入) ----------
if [ ! -s "$D/qdrant_api_key" ]; then
  [ -t 0 ] || { echo "請在終端機執行(要隱藏輸入 Qdrant API Key)" >&2; exit 1; }
  printf 'Qdrant API Key(10.10.130.46:6333,與舊版 QDRANT_API_KEY 相同;輸入時不顯示):'
  # trap 先設再關回顯(中斷時一定恢復)
  trap 'stty echo; rm -rf "$TMP"' EXIT; stty -echo; IFS= read -r QDRANT_KEY; stty echo; echo
  [ -n "$QDRANT_KEY" ] || { echo "未輸入 Qdrant API Key" >&2; exit 1; }
  printf '%s' "$QDRANT_KEY" > "$D/qdrant_api_key"; unset QDRANT_KEY
fi

# 只限縮檔案(目錄需讓 CI 的 docker compose 讀得到 secret 路徑)
chown 1000:1000 "$D"/*; chmod 400 "$D"/*

# ---------- Compose 變數(只補缺少的) ----------
touch "$ENV_FILE"
add() { grep -q "^$1=" "$ENV_FILE" || { echo "$1=$2" >> "$ENV_FILE"; echo "netops.env 新增 $1"; }; }
add GW_ENV test
add GW_BASE_URL https://giganexus-test.gigasolar.com.tw
add GW_NETWORK giganexus-gw_default
add NETOPS_SECRETS_DIR "$D"
add NETOPS_DATA_HOST_DIR /srv/giga-netops/test
add FTP_HOST 10.10.130.66
if ! grep -q '^FTP_USER=.' "$ENV_FILE"; then
  printf 'FTP 帳號(FTP_USER):'; read -r FTP_USER
  [ -n "$FTP_USER" ] || { echo "未輸入 FTP 帳號" >&2; exit 1; }
  sed -i '/^FTP_USER=/d' "$ENV_FILE"; echo "FTP_USER=$FTP_USER" >> "$ENV_FILE"; echo "netops.env 新增 FTP_USER"
fi
add FTP_MAX_CONNECTIONS 1
add FTP_SYNC_MINUTES 0
# 不含機密;umask 077 建出的檔案 CI(gitlab-runner)讀不到,改為所有人可讀
chmod 644 "$ENV_FILE"

# ---------- 資料目錄(B1;WSL 檔案系統,容器以 uid 1000 寫入;第一版不自動清除,D16) ----------
mkdir -p /srv/giga-netops/test
chown 1000:1000 /srv/giga-netops/test
chmod 750 /srv/giga-netops/test

ls -l "$D"
echo "FTP 目錄若與預設不同(舊版 server/.env 的 FTP_ROOT、FTP_LOG_DIR、FTP_AD_DIR…),請在 $ENV_FILE 補上同名變數。"
echo "完成。之後 develop 合併由 CI 部署 netops-api;部署後在 GigaItApp「服務與路由」審查 netops-api 的路由草稿並發佈。"
