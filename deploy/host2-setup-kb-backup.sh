#!/bin/sh
# 主機 2(測試區 WSL)準備知識庫的 NAS 備份目錄(ARCHITECTURE Q3;備份由 compose 的 netops-kb-backup 每天執行,deploy/kb-backup/backup.sh):本人執行。
#   在主機 2 的 WSL:sudo sh host2-setup-kb-backup.sh
# 沿用附件服務的 NAS 掛載(//10.10.130.31/docker-folder → /mnt/nas-docker,cifs uid 1000;giga-file-service file-api/deploy/host2-mount-nas.sh 建立),
# 本腳本不經手 NAS 帳密。產生:
#   /mnt/nas-docker/giga-netops/test                       備份目錄(uid 1000 可寫)
#   /mnt/nas-docker/giga-netops/test/.giga-netops-backup   標記檔:備份程式看到它才寫入(NAS 沒掛上時不會寫到本機空目錄)
# 完成後備份容器啟動(CI 部署或 docker restart)時先備份一次,之後每天 2 點
set -eu
MNT=/mnt/nas-docker
ENV_NAME=${GW_ENV:-test}
ROOT="$MNT/giga-netops/$ENV_NAME"

mountpoint -q "$MNT" || { echo "$MNT 沒有掛載 NAS:先執行 giga-file-service 的 file-api/deploy/host2-mount-nas.sh(或 sudo mount $MNT)" >&2; exit 1; }
mkdir -p "$ROOT"
touch "$ROOT/.giga-netops-backup"
# 寫入測試(建立後刪除),確認容器使用的 uid 1000 可寫
su -s /bin/sh -c "touch '$ROOT/.write-test' && rm '$ROOT/.write-test'" "$(getent passwd 1000 | cut -d: -f1)" \
  && echo "uid 1000 可寫入 $ROOT" || { echo "uid 1000 無法寫入 $ROOT(檢查 NAS 帳號權限)" >&2; exit 1; }
ls -la "$ROOT"
echo "完成。備份容器已在運作時,重新啟動即先備份一次:docker restart giganexus-netops-$ENV_NAME-netops-kb-backup-1"
echo "(容器尚未部署時,等 develop 合併由 CI 部署)。之後在 $ROOT 看得到 netops-kb-$ENV_NAME-<日期>.tar.gz 與 LAST_RESULT。"
