#!/bin/sh
# 知識庫每日備份到 NAS(ARCHITECTURE Q3;比照附件服務備份到 NAS docker-folder,giga-file-service STORAGE.md §2)
#   來源(netops-api 的資料目錄 /data,唯讀掛載):knowledge(筆記 *.md 與匯整檔)+ warroom(網段設定 warroom.json 與 history/;SEGMENT-SETTINGS-PLAN §7 Q7)
#     兩者都不可重建;warroom/ai-hourly.json 每小時重算、寫入暫存檔 *.tmp 不備份。其他資料可從 FTP 重新分析,不備份
#     warroom 目錄不存在(還沒存過網段設定)時只打包 knowledge
#   目的 /backup(主機 /mnt/nas-docker/giga-netops/<區>,cifs 由 giga-file-service 的 host2-mount-nas.sh 掛載)
#   - 目的根目錄沒有標記檔 .giga-netops-backup 時視為 NAS 未掛載,整輪跳過(Docker 會在掛載點不存在時建立本機空目錄,不可寫進去)
#   - 先寫 .part,解壓列表核對檔數後才改名;同時寫 .sha256;保留最近 KB_BACKUP_KEEP 份
#   - 容器啟動時若今天還沒有備份就先備份一次(部署後即可確認),之後每天 KB_BACKUP_HOUR 點
#   - 結果只寫容器日誌與 /backup/LAST_RESULT(第一版不回報 giga-observe)
set -u
DATA=/data
SRC="$DATA/knowledge"
DEST=/backup
MARK="$DEST/.giga-netops-backup"
ENV_NAME="${GW_ENV:?GW_ENV 必須設定}"
HOUR="${KB_BACKUP_HOUR:-2}"
KEEP="${KB_BACKUP_KEEP:-30}"
case "$HOUR" in [0-9] | 1[0-9] | 2[0-3]) ;; *) echo "[kb-backup] KB_BACKUP_HOUR 須為 0–23:$HOUR" >&2; exit 1 ;; esac
case "$KEEP" in '' | *[!0-9]* | 0) echo "[kb-backup] KB_BACKUP_KEEP 須為正整數:$KEEP" >&2; exit 1 ;; esac
PREFIX="netops-kb-$ENV_NAME"

log() { echo "[kb-backup] $(date '+%Y-%m-%dT%H:%M:%S%z') $*"; }
result() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" > "$DEST/LAST_RESULT" 2>/dev/null || true; }

run_backup() {
  [ -f "$MARK" ] || { log "略過:$DEST 沒有標記檔 .giga-netops-backup(NAS 未掛載或尚未執行 deploy/host2-setup-kb-backup.sh)"; return 1; }
  [ -d "$SRC" ] || { log "失敗:找不到來源 $SRC"; result "FAIL 找不到來源"; return 1; }
  stamp="$(date +%Y%m%d)"
  target="$DEST/$PREFIX-$stamp.tar.gz"
  part="$target.part"
  dirs=knowledge
  [ -d "$DATA/warroom" ] && dirs="knowledge warroom"
  # 只算一般檔案;排除條件與 tar --exclude 相同,tar 列表同樣只比對一般檔案
  # shellcheck disable=SC2086
  want="$(cd "$DATA" && find $dirs -type f ! -path 'warroom/ai-hourly.json' ! -name '*.tmp' | wc -l | tr -d ' ')"
  rm -f "$part"
  # shellcheck disable=SC2086
  if ! tar -czf "$part" -C "$DATA" --exclude='warroom/ai-hourly.json' --exclude='*.tmp' $dirs; then
    rm -f "$part"; log "失敗:tar 打包錯誤"; result "FAIL tar"; return 1
  fi
  got="$(tar -tzvf "$part" | grep -c '^-')" || got=0
  if [ "$got" != "$want" ]; then
    rm -f "$part"; log "失敗:檔數不符(來源 $want、備份 $got)"; result "FAIL 檔數不符 $want/$got"; return 1
  fi
  mv -f "$part" "$target"
  (cd "$DEST" && sha256sum "$(basename "$target")" > "$(basename "$target").sha256")
  # 保留最近 $KEEP 份(檔名含日期,依名稱排序)
  ls -1 "$DEST" | grep -E "^$PREFIX-[0-9]{8}\.tar\.gz$" | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$DEST/$old" "$DEST/$old.sha256"
  done
  size="$(du -h "$target" | cut -f1)"
  log "完成:$(basename "$target")($dirs),$want 個檔案,$size"
  result "OK $(basename "$target") files=$want size=$size"
}

done_today() { [ -f "$DEST/$PREFIX-$(date +%Y%m%d).tar.gz" ]; }

log "啟動:每天 $HOUR 點備份 $DATA 的 knowledge、warroom → $DEST(保留 $KEEP 份)"
# 前次被中止(容器重建)留下的暫存檔
[ -f "$MARK" ] && rm -f "$DEST"/"$PREFIX"-*.tar.gz.part
done_today || run_backup || true
while :; do
  sleep 300
  # 數值比較(00–23 對 0–23;busybox 的 -eq 以十進位解讀 08、09)
  if [ "$(date +%H)" -eq "$HOUR" ] && ! done_today; then run_backup || true; fi
done
