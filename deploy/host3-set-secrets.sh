#!/bin/sh
# 主機 3(正式區 WSL)準備 netops-api 的機密與 Compose 變數:本人執行(AGENT.md §7.5;同 host2-set-secrets.sh,改為正式區的值)。
#   在主機 3 的 WSL:sudo sh host3-set-secrets.sh        (步驟順序見 deploy/RUNBOOK-prod.md §2)
# 產生(已存在的不覆寫;要重建先刪除該檔):
#   /srv/giganexus/netops-secrets/   gw_api_key(**正式區** Gateway CLI client:create --code netops-api;自動註冊正式區路由草稿用)、
#                                    monitor_api_key(**正式區** giga-observe-prod 的 ingest Key,服務 netops-api)、
#                                    ftp_password(FTP 唯讀帳號密碼,隱藏輸入;與舊版 IIS server/.env 的 FTP_PWD 同一個帳號)、
#                                    qdrant_api_key(AI 主機 Qdrant 的 API Key,與舊版 IIS 的 QDRANT_API_KEY 相同,隱藏輸入)
#   /srv/giga-netops/prod            資料目錄(uid 1000 可寫;WSL 檔案系統)
#   /srv/giganexus/deploy/netops.env Compose 變數(範本 deploy/netops-prod.env.example;只補缺少的,FTP_USER 執行時輸入)
# 測試區的機密一律不沿用:Gateway 與監控 Key 在正式區重新發放;ClickHouse 帳號由 host3-set-clickhouse-secrets.sh 在主機 3 重新產生。
# 注意:client:create 再次執行即換發,舊金鑰立即失效;gw_api_key 已存在時本腳本不會重建。本腳本不顯示任何金鑰或密碼。
set -eu
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
D=/srv/giganexus/netops-secrets
ENV_FILE=/srv/giganexus/deploy/netops.env
GW_ENV_FILE=/srv/giganexus/deploy/prod.env
GW_SHARED=/srv/giganexus/shared
OBSERVE_DIR=/srv/giganexus/giga-observe
DATA_DIR=/srv/giga-netops/prod
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
[ -f "$GW_ENV_FILE" ] || { echo "找不到正式區 Gateway 設定 $GW_ENV_FILE(這台不是主機 3?)" >&2; exit 1; }
# 防呆:這台已有測試區設定時中止(兩區設定不可混用)
if [ -f "$ENV_FILE" ] && grep -q '^GW_ENV=' "$ENV_FILE" && ! grep -qx 'GW_ENV=prod' "$ENV_FILE"; then
  echo "$ENV_FILE 的 GW_ENV 不是 prod,中止(這台不是正式區?)" >&2; exit 1
fi
mkdir -p "$D"
# 目錄要讓 CI(gitlab-runner)確認檔案存在、docker compose 掛載;檔案本身於最後改為 uid 1000 / 400
chmod 755 "$D"

# ---------- Gateway API Key(正式區 Gateway;代碼必須等於上游 netops-api) ----------
if [ ! -f "$D/gw_api_key" ]; then
  G="$GW_SHARED/giga-api-gateway-bff/deploy"
  TAG="$(cat "$GW_SHARED/gateway-image-tag")"
  (cd "$G" && IMAGE_TAG="$TAG" REGISTRY=10.10.130.123:5050/giganexus/giga-api-gateway-bff \
    docker compose --env-file "$GW_ENV_FILE" -f docker-compose.yml -f docker-compose.prod.yml --profile tools run --rm --no-deps -T \
    migrate node dist/bff/src/cli/index.js client:create --code netops-api --name "資訊網通管理系統 netops-api" --actor NetOps) > "$TMP/key.json"
  sed -n 's/^  "key": "\(.*\)",\{0,1\}$/\1/p' "$TMP/key.json" | tr -d '\n' > "$D/gw_api_key"
  [ -s "$D/gw_api_key" ] || { rm -f "$D/gw_api_key"; echo "取不到 API Key(輸出不顯示,以免含金鑰);請檢查正式區 Gateway 是否運作中" >&2; exit 1; }
  chown 1000:1000 "$D/gw_api_key"; chmod 400 "$D/gw_api_key"; echo "已建立 gw_api_key(正式區 Gateway client netops-api)"
fi

# ---------- giga-observe 監控 Key(正式區 giga-observe-prod,ingest,服務 netops-api) ----------
# 檔案不存在或為空才建立;每執行一次 createApiKey 就多一把 Key,已有 Key 時不重建
if [ ! -s "$D/monitor_api_key" ]; then
  (cd "$OBSERVE_DIR" && docker compose --env-file deploy/prod.env exec -T gno-backend \
    node src/scripts/createApiKey.js --service netops-api --scope ingest --label "資訊網通管理系統 netops-api") > "$TMP/obs.txt" \
    || { echo "建立監控 Key 失敗(giga-observe-prod gno-backend 是否運作中?);監控會停用,服務仍可啟動,稍後可重跑本腳本" >&2; : > "$TMP/obs.txt"; }
  sed -n 's/^  key *: *//p' "$TMP/obs.txt" | tr -d '\r\n' > "$TMP/monitor_api_key"
  if [ -s "$TMP/monitor_api_key" ]; then
    rm -f "$D/monitor_api_key"; mv "$TMP/monitor_api_key" "$D/monitor_api_key"
    chown 1000:1000 "$D/monitor_api_key"; chmod 400 "$D/monitor_api_key"; echo "已建立監控 Key(netops-api,正式區)"
  else
    echo "取不到監控 Key:監控維持停用,服務仍可啟動;排除後重跑本腳本。若上方顯示已建立,請在 giga-observe 撤銷 netops-api 多出的 Key" >&2
    [ -f "$D/monitor_api_key" ] || : > "$D/monitor_api_key"
  fi
fi

# ---------- FTP 密碼(隱藏輸入,不顯示、不寫進歷史) ----------
if [ ! -s "$D/ftp_password" ]; then
  [ -t 0 ] || { echo "請在終端機執行(要隱藏輸入 FTP 密碼)" >&2; exit 1; }
  printf 'FTP 密碼(與舊版 IIS 的 FTP_USER 同一個帳號;輸入時不顯示):'
  trap 'stty echo; rm -rf "$TMP"' EXIT; stty -echo; IFS= read -r FTP_PWD; stty echo; echo
  [ -n "$FTP_PWD" ] || { echo "未輸入 FTP 密碼" >&2; exit 1; }
  printf '%s' "$FTP_PWD" > "$D/ftp_password"; unset FTP_PWD
fi

# ---------- Qdrant API Key(舊版 IIS 的 QDRANT_API_KEY,隱藏輸入) ----------
if [ ! -s "$D/qdrant_api_key" ]; then
  [ -t 0 ] || { echo "請在終端機執行(要隱藏輸入 Qdrant API Key)" >&2; exit 1; }
  printf 'Qdrant API Key(10.10.130.46:6333,與舊版 QDRANT_API_KEY 相同;輸入時不顯示):'
  trap 'stty echo; rm -rf "$TMP"' EXIT; stty -echo; IFS= read -r QDRANT_KEY; stty echo; echo
  [ -n "$QDRANT_KEY" ] || { echo "未輸入 Qdrant API Key" >&2; exit 1; }
  printf '%s' "$QDRANT_KEY" > "$D/qdrant_api_key"; unset QDRANT_KEY
fi

# 只限縮本腳本管理的檔案(目錄需讓 CI 的 docker compose 讀得到 secret 路徑;clickhouse/ 由另一支腳本管理)
for f in gw_api_key monitor_api_key ftp_password qdrant_api_key; do chown 1000:1000 "$D/$f"; chmod 400 "$D/$f"; done

# ---------- Compose 變數(只補缺少的;不含機密) ----------
touch "$ENV_FILE"
add() { grep -q "^$1=" "$ENV_FILE" || { echo "$1=$2" >> "$ENV_FILE"; echo "netops.env 新增 $1=$2"; }; }
add GW_ENV prod
add GW_BASE_URL https://giganexus.gigasolar.com.tw
add GW_NETWORK giganexus-gw_default
add NETOPS_SECRETS_DIR "$D"
add NETOPS_DATA_HOST_DIR "$DATA_DIR"
add FTP_HOST 10.10.130.66
if ! grep -q '^FTP_USER=.' "$ENV_FILE"; then
  printf 'FTP 帳號(FTP_USER,與舊版 IIS server/.env 相同):'; read -r FTP_USER
  [ -n "$FTP_USER" ] || { echo "未輸入 FTP 帳號" >&2; exit 1; }
  sed -i '/^FTP_USER=/d' "$ENV_FILE"; echo "FTP_USER=$FTP_USER" >> "$ENV_FILE"; echo "netops.env 新增 FTP_USER"
fi
# AGENT.md §6:正式區 FTP 同時連線 2(舊版 FTP_PARALLEL=2)
add FTP_MAX_CONNECTIONS 2
# 第一段:不自動同步 FTP(舊版 IIS 繼續同步,D18;需要時改分鐘數,見 RUNBOOK-prod.md §3)
add FTP_SYNC_MINUTES 0
# 第一段:AI 走 FTP 舊路徑、不產生每日摘要、不歸檔(CI deploy-prod 在 NETOPS_PA_PIPELINE=0 時也會固定這些值)
add NETOPS_AI_SOURCE ftp
add NETOPS_AI_DAILY_SUMMARY 0
add NETOPS_ARCHIVE_ENABLED 0
# 歸檔保留(CG §10.3):正式區 0 = 不刪
add NETOPS_ARCHIVE_KEEP_DAYS 0
# PA log 管線開關(netops-clickhouse / netops-ingest / netops-pa):第一段 0,第二段 C6 改 1
add NETOPS_PA_PIPELINE 0
# 正式區 ClickHouse 容器 2 GB(CG §4.5;第二段才啟動)
add NETOPS_CH_MEM_LIMIT 2048m
# 舊版 IIS 仍同步同一個 Qdrant collection:不寫入向量庫、不自動外部 IP 學習(D10、D18)
add VECTOR_SYNC 0
add IPLEARN_HOUR -1
# 不含機密;umask 077 建出的檔案 CI(gitlab-runner)讀不到,改為所有人可讀
chmod 644 "$ENV_FILE"

# ---------- 資料目錄(WSL 檔案系統,容器以 uid 1000 寫入) ----------
mkdir -p "$DATA_DIR"
chown 1000:1000 "$DATA_DIR"
chmod 750 "$DATA_DIR"

ls -l "$D"
echo "完成。接著執行 host3-set-clickhouse-secrets.sh、host3-set-pa-secrets.sh 與 NAS 備份目錄(RUNBOOK-prod.md §2)。"
