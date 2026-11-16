#!/bin/sh
# 主機 2(測試區 WSL)準備 PA log 冷歸檔的 NAS 目錄(C4,手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §8.1):本人執行。
#   在主機 2 的 WSL:sudo sh deploy/host2-setup-pa-archive.sh
# 沿用附件服務的 NAS 掛載(//10.10.130.31/docker-folder → /mnt/nas-docker,cifs uid / gid 1000、檔案 0640、目錄 0750;
# giga-file-service file-api/deploy/host2-mount-nas.sh 建立),本腳本不經手 NAS 帳密、不改掛載。產生:
#   /mnt/nas-docker/giga-netops/<env>/pa-archive                        歸檔目錄(netops-ingest 以 uid 1000 寫入)
#   /mnt/nas-docker/giga-netops/<env>/pa-archive/.giga-netops-archive   標記檔:netops-ingest 看到它才寫(NAS 沒掛上時不會寫到本機空目錄)
# netops-clickhouse(uid 101)以群組 1000 唯讀讀取(docker-compose.yml 的 group_add),不需要改 NAS 權限。
# 測試區保留 14 天(NETOPS_ARCHIVE_KEEP_DAYS,netops-ingest 自動刪除);一天約 0.2–0.4 GB(C1 報告 §6),NAS 剩約 18 GB。
# 完成後重建兩個容器才看得到(CI 部署每次都會重建;手動見最後的提示)。
set -eu
MNT=/mnt/nas-docker
ENV_NAME=${GW_ENV:-test}
case "$ENV_NAME" in test|prod) ;; *) echo "GW_ENV 只能是 test / prod:$ENV_NAME" >&2; exit 2 ;; esac
DIR="$MNT/giga-netops/$ENV_NAME/pa-archive"

U1000="$(getent passwd 1000 | cut -d: -f1)"
[ -n "$U1000" ] || { echo "找不到 uid 1000 的使用者(netops-ingest 以 uid 1000 寫入)" >&2; exit 1; }
mountpoint -q "$MNT" || { echo "$MNT 沒有掛載 NAS:先執行 giga-file-service 的 file-api/deploy/host2-mount-nas.sh(或 sudo mount $MNT)" >&2; exit 1; }
df -h "$MNT" | tail -n 1
# 不跟隨 symlink:目錄或標記檔是 symlink 時停止(資安審查 L6)
for p in "$MNT/giga-netops" "$MNT/giga-netops/$ENV_NAME" "$DIR" "$DIR/.giga-netops-archive"; do
  [ ! -L "$p" ] || { echo "$p 是 symlink,停止" >&2; exit 1; }
done
mkdir -p "$DIR"
touch "$DIR/.giga-netops-archive"
# 寫入測試(建立後刪除),確認 netops-ingest 使用的 uid 1000 可寫
su -s /bin/sh -c "touch '$DIR/.write-test' && rm '$DIR/.write-test'" "$U1000" \
  && echo "uid 1000 可寫入 $DIR" || { echo "uid 1000 無法寫入 $DIR(檢查 NAS 帳號權限)" >&2; exit 1; }
# 群組讀取:ClickHouse(uid 101、群組 1000)要能進目錄、讀檔
G="$(stat -c '%g %A' "$DIR")"
# 萬用字元 ? 不能放在引號內(引號內是字面字元,永遠比對不到);群組欄 = 第 5–7 個權限字元
case "$G" in "1000 d"???r?x*) echo "群組 1000 可讀取目錄($G)" ;; *) echo "WARN 目錄群組或權限不是 1000 / r-x($G):netops-clickhouse 可能讀不到歸檔檔案" >&2 ;; esac
ls -la "$DIR"
echo "完成。之後的 develop 部署(CI)會重建 netops-ingest 與 netops-clickhouse;已部署時手動重建:"
echo "  docker compose --env-file /srv/giganexus/deploy/netops.env -f deploy/docker-compose.yml up -d --wait --force-recreate netops-clickhouse netops-ingest"
echo "隔天 02:30 起 $DIR/<年>/ 會出現 pa_traffic_<日期>.parquet、pa_threat_<日期>.parquet 與 .sha256;狀態看 netops:ingest:heartbeat 的 archive* 欄位。"
