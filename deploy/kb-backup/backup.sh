#!/bin/sh
# 知識庫與資料目錄每日備份到 NAS(ARCHITECTURE Q3;比照附件服務備份到 NAS docker-folder,giga-file-service STORAGE.md §2)
#   來源(netops-api 的資料目錄 /data,唯讀掛載),每天兩個檔:
#   1) netops-kb-<區>-YYYYMMDD.tar.gz:knowledge(筆記 *.md 與匯整檔)+ warroom(網段設定 warroom.json 與 history/;SEGMENT-SETTINGS-PLAN §7 Q7)
#      兩者都不可重建;warroom/ai-hourly.json 每小時重算、不備份。warroom 目錄不存在(還沒存過網段設定)時只打包 knowledge。保留 KB_BACKUP_KEEP 份
#   2) netops-data-<區>-YYYYMMDD.tar.gz(2026-11-18 需求方決定 #5):palogs(FTP 分析結果、ClickHouse 每小時摘要與對帳結果 ch/recon、AI 每日摘要)、
#      adlogs(AD 事件)、ipnames(IP 對照表,含姓名、部門)、papolicy(PA 安全規則版本歷史 50 份,PR-2)、pa-signature(PA 威脅特徵碼版本歷史 90 份與精簡索引,TS-2)。FTP 只留約 1 個月,超過就無法重算。保留 KB_BACKUP_DATA_KEEP 份
#      (資料目錄不自動清除、每天成長約 26 MB(ARCHITECTURE D16),一份會越來越大:份數另外設定,不和知識庫共用)
#   兩者都排除寫入中的暫存檔 *.tmp(infra/store 原子寫入)
#   目的 /backup(主機 /mnt/nas-docker/giga-netops/<區>,cifs 由 giga-file-service 的 host2-mount-nas.sh 掛載)
#   - 目的根目錄沒有標記檔 .giga-netops-backup 時視為 NAS 未掛載,整輪跳過(Docker 會在掛載點不存在時建立本機空目錄,不可寫進去)
#   - NAS 剩餘空間低於 KB_BACKUP_MIN_FREE_MB(預設 2048)時不寫
#   - 先列出檔案清單(容器內 tmpfs /tmp),依清單打包(netops-api 持續寫入資料目錄:打包期間新增的檔不影響核對,清單內的檔被刪除則這次失敗、稍後重試)
#   - 先寫 .part,解壓列表核對檔數後才改名;同時寫 .sha256
#   - 容器啟動時若今天還沒有備份就先備份一次(部署後即可確認),之後每天 KB_BACKUP_HOUR 點(那一小時內失敗每 5 分鐘重試;已完成的檔不重做)
#   - 結果只寫容器日誌與 /backup/LAST_RESULT(第一版不回報 giga-observe;兩個檔都成功才是 OK)
set -u
DATA=/data
DEST=/backup
MARK="$DEST/.giga-netops-backup"
ENV_NAME="${GW_ENV:?GW_ENV 必須設定}"
HOUR="${KB_BACKUP_HOUR:-2}"
KEEP="${KB_BACKUP_KEEP:-30}"
DATA_KEEP="${KB_BACKUP_DATA_KEEP:-7}"
# NAS 剩餘空間下限(MB):不足時不寫(和附件服務等共用分享,不能把它塞滿;資安審查 M2)
MIN_FREE_MB="${KB_BACKUP_MIN_FREE_MB:-2048}"
# 檔案清單放容器內的 tmpfs(不留在 NAS 上;資安審查 L1)
TMP="${TMPDIR:-/tmp}"
case "$HOUR" in [0-9] | 1[0-9] | 2[0-3]) ;; *) echo "[kb-backup] KB_BACKUP_HOUR 須為 0–23:$HOUR" >&2; exit 1 ;; esac
case "$KEEP" in '' | *[!0-9]* | 0) echo "[kb-backup] KB_BACKUP_KEEP 須為正整數:$KEEP" >&2; exit 1 ;; esac
case "$DATA_KEEP" in '' | *[!0-9]* | 0) echo "[kb-backup] KB_BACKUP_DATA_KEEP 須為正整數:$DATA_KEEP" >&2; exit 1 ;; esac
case "$MIN_FREE_MB" in '' | *[!0-9]*) echo "[kb-backup] KB_BACKUP_MIN_FREE_MB 須為非負整數:$MIN_FREE_MB" >&2; exit 1 ;; esac
KB_PREFIX="netops-kb-$ENV_NAME"
DATA_PREFIX="netops-data-$ENV_NAME"
# 資料目錄要備份的子目錄(固定清單;不存在的略過)
DATA_DIRS="palogs adlogs ipnames papolicy pa-signature"

log() { echo "[kb-backup] $(date '+%Y-%m-%dT%H:%M:%S%z') $*" >&2; }
result() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" > "$DEST/LAST_RESULT" 2>/dev/null || true; }
today() { date +%Y%m%d; }

# 存在的子目錄(印出名稱,空白分隔)
existing() {
  out=""
  for d in "$@"; do [ -d "$DATA/$d" ] && [ ! -L "$DATA/$d" ] && out="$out $d"; done
  echo "$out"
}
kb_dirs() { existing knowledge warroom; }

# pack <前綴> <保留份數> <子目錄...>:打包成 <前綴>-<日期>.tar.gz;今天的檔已存在就略過。成功時印出「檔名 files=N size=S」
pack() {
  prefix="$1"; keep="$2"; shift 2
  # 沒有目錄時 find 會掃整個 /data(code review):直接失敗
  [ $# -gt 0 ] || { log "失敗:$prefix 沒有可備份的目錄"; return 1; }
  target="$DEST/$prefix-$(today).tar.gz"
  part="$target.part"
  list="$TMP/$prefix.list"
  if [ -f "$target" ]; then echo "$(basename "$target") 已存在"; return 0; fi
  free="$(df -Pk "$DEST" | awk 'NR == 2 { print int($4 / 1024) }')"
  if [ -z "$free" ] || [ "$free" -lt "$MIN_FREE_MB" ]; then
    log "失敗:$DEST 剩餘空間 ${free:-?} MB,低於 $MIN_FREE_MB MB,不備份 $prefix"; return 1
  fi
  rm -f "$part" "$list"
  # 只列一般檔案(不跟隨 symlink);排除每小時重算的 ai-hourly.json、原子寫入的暫存檔 *.tmp,
  # 以及檔名含換行的檔(清單一行一個檔名;資安審查 L2)
  nl="$(printf '*\n*')"
  if ! (cd "$DATA" && find "$@" -type f ! -path 'warroom/ai-hourly.json' ! -name '*.tmp' ! -name "$nl") > "$list"; then
    rm -f "$list"; log "失敗:$prefix 列出檔案錯誤"; return 1
  fi
  want="$(wc -l < "$list" | tr -d ' ')"
  if [ "$want" = 0 ]; then
    # 空目錄:busybox tar 不接受空清單,只打包目錄本身
    ok=0; tar -czf "$part" -C "$DATA" --no-recursion "$@" || ok=1
  else
    ok=0; tar -czf "$part" -C "$DATA" -T "$list" || ok=1
  fi
  rm -f "$list"
  if [ "$ok" != 0 ]; then rm -f "$part"; log "失敗:$prefix tar 打包錯誤(打包期間檔案被刪除時,下一次重試)"; return 1; fi
  got="$(tar -tzvf "$part" | grep -c '^-')" || got=0
  if [ "$got" != "$want" ]; then
    rm -f "$part"; log "失敗:$prefix 檔數不符(清單 $want、備份 $got)"; return 1
  fi
  mv -f "$part" "$target"
  (cd "$DEST" && sha256sum "$(basename "$target")" > "$(basename "$target").sha256")
  # 保留最近 $keep 份(檔名含日期,依名稱排序)
  ls -1 "$DEST" | grep -E "^$prefix-[0-9]{8}\.tar\.gz$" | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
    rm -f "$DEST/$old" "$DEST/$old.sha256"
  done
  size="$(du -h "$target" | cut -f1)"
  log "完成:$(basename "$target")($*),$want 個檔案,$size"
  echo "$(basename "$target") files=$want size=$size"
}

run_backup() {
  [ -f "$MARK" ] || { log "略過:$DEST 沒有標記檔 .giga-netops-backup(NAS 未掛載或尚未執行 deploy/host2-setup-kb-backup.sh)"; return 1; }
  [ -d "$DATA/knowledge" ] || { log "失敗:找不到來源 $DATA/knowledge"; result "FAIL 找不到來源"; return 1; }
  # shellcheck disable=SC2046
  kb="$(pack "$KB_PREFIX" "$KEEP" $(kb_dirs))" || { result "FAIL $KB_PREFIX"; return 1; }
  dd="$(existing $DATA_DIRS)"
  data="資料目錄沒有 $DATA_DIRS"
  if [ -n "$dd" ]; then
    # shellcheck disable=SC2086
    data="$(pack "$DATA_PREFIX" "$DATA_KEEP" $dd)" || { result "FAIL $DATA_PREFIX($kb)"; return 1; }
  fi
  result "OK $kb; $data"
}

# 今天兩個檔都有了(資料目錄沒有任何子目錄時只看知識庫)
done_today() {
  [ -f "$DEST/$KB_PREFIX-$(today).tar.gz" ] || return 1
  [ -z "$(existing $DATA_DIRS)" ] || [ -f "$DEST/$DATA_PREFIX-$(today).tar.gz" ]
}

log "啟動:每天 $HOUR 點備份 $DATA 的 knowledge、warroom(保留 $KEEP 份)與 $DATA_DIRS(保留 $DATA_KEEP 份)→ $DEST"
# 前次被中止(容器重建)留下的暫存檔與清單
[ -f "$MARK" ] && rm -f "$DEST"/"$KB_PREFIX"-*.tar.gz.part "$DEST"/"$DATA_PREFIX"-*.tar.gz.part
done_today || run_backup || true
while :; do
  sleep 300
  # 數值比較(00–23 對 0–23;busybox 的 -eq 以十進位解讀 08、09)
  if [ "$(date +%H)" -eq "$HOUR" ] && ! done_today; then run_backup || true; fi
done
