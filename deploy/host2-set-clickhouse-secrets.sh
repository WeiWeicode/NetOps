#!/bin/sh
# 主機 2(測試區 WSL)準備 netops-clickhouse(PA log ClickHouse,C1)的帳號與密碼:本人執行(AGENT.md §7.5)。
#   在主機 2 的 WSL:sudo sh deploy/host2-set-clickhouse-secrets.sh
# 產生(已存在的不覆寫;要換密碼:刪除該帳號的密碼檔與 netops-users.xml 後重跑,再重建 netops-clickhouse 與用到該帳號的容器):
#   /srv/giganexus/netops-secrets/ch_writer_password   netops-ingest 寫入、歸檔、補漏(C2、C4)
#   /srv/giganexus/netops-secrets/ch_reader_password   netops-api 一般查詢(C3,唯讀)
#   /srv/giganexus/netops-secrets/ch_cold_password     冷查詢讀 NAS Parquet(C4)
#     密碼都是自動產生的 32 字隨機字串(uid 1000 可讀,和其他 NetOps 機密相同),不需要輸入、不會顯示
#   /srv/giganexus/netops-secrets/clickhouse/netops-users.xml
#     三個帳號的定義:只含密碼的 SHA-256 雜湊(ClickHouse 沒有「從檔案讀密碼」的設定),uid 101(容器內 clickhouse)可讀;
#     Compose 掛成 /etc/clickhouse-server/users.d/zz-netops-users.xml。查詢上限在 deploy/clickhouse/users.d/profiles.xml
# 帳號權限(手冊 §10.2):
#   netops_writer  SELECT、INSERT、ALTER DELETE on netops.*(補漏的 REPLACE PARTITION 等到 C2 / C4 再加)
#   netops_reader  SELECT on netops.*;readonly=2,上限以 constraints 固定;不能用 file()
#   netops_cold    SELECT on netops.* + 讀 user_files(file() 冷查詢);readonly=2、單執行緒
# 測試用:NETOPS_SECRETS_DIR=/tmp/x sh deploy/host2-set-clickhouse-secrets.sh 產生到其他目錄(不需要 root,也不改權限擁有者)
set -eu
umask 077
D="${NETOPS_SECRETS_DIR:-/srv/giganexus/netops-secrets}"
[ -d "$D" ] || { echo "找不到 $D(先執行 deploy/host2-set-secrets.sh)" >&2; exit 1; }
X="$D/clickhouse/netops-users.xml"
AS_ROOT=0; [ "$(id -u)" = 0 ] && AS_ROOT=1

gen() { # 24 bytes 亂數 → base64url 32 字
  f="$D/ch_$1_password"
  if [ ! -s "$f" ]; then
    head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$f"
    [ "$(wc -c < "$f")" -ge 32 ] || { echo "產生 $f 失敗" >&2; rm -f "$f"; exit 1; }
    echo "已產生 ch_$1_password"
    rm -f "$X"   # 密碼換了,帳號定義一定要重產
  fi
  if [ "$AS_ROOT" = 1 ]; then chown 1000:1000 "$f"; fi
  chmod 400 "$f"
}
gen writer
gen reader
gen cold

hash() { sha256sum < "$D/ch_$1_password" | cut -d' ' -f1; }

if [ ! -s "$X" ]; then
  mkdir -p "$D/clickhouse"
  # 帳號只在 Compose 內部網路用得到(netops-internal,internal: true);networks 不另外限制來源 IP(容器 IP 會變)
  cat > "$X.tmp" <<EOF
<clickhouse>
    <users>
        <netops_writer>
            <password_sha256_hex>$(hash writer)</password_sha256_hex>
            <profile>netops_writer</profile>
            <networks><ip>::/0</ip></networks>
            <grants>
                <query>GRANT SELECT, INSERT, ALTER DELETE ON netops.*</query>
            </grants>
        </netops_writer>
        <netops_reader>
            <password_sha256_hex>$(hash reader)</password_sha256_hex>
            <profile>netops_reader</profile>
            <networks><ip>::/0</ip></networks>
            <grants>
                <query>GRANT SELECT ON netops.*</query>
            </grants>
        </netops_reader>
        <netops_cold>
            <password_sha256_hex>$(hash cold)</password_sha256_hex>
            <profile>netops_cold</profile>
            <networks><ip>::/0</ip></networks>
            <grants>
                <query>GRANT SELECT ON netops.*</query>
                <query>GRANT CREATE TEMPORARY TABLE ON *.*</query>
                <query>GRANT READ ON FILE</query>
            </grants>
        </netops_cold>
    </users>
</clickhouse>
EOF
  mv "$X.tmp" "$X"
  echo "已產生 clickhouse/netops-users.xml"
fi
# 容器內 ClickHouse 以 uid 101 執行;檔案只含雜湊。目錄 755:CI(gitlab-runner)要能確認檔案存在
if [ "$AS_ROOT" = 1 ]; then chown 101:101 "$X"; fi
chmod 755 "$D/clickhouse"; chmod 400 "$X"

ls -l "$D"/ch_*_password "$X"
echo "完成。之後的 CI 部署(develop)會啟動 netops-clickhouse 並建立資料表;手動:docker compose ... up -d --wait netops-clickhouse"
