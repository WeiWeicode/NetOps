# 知識庫每日備份到 NAS(ARCHITECTURE Q3;backup.sh 開頭說明)。只用 busybox 的 sh、tar、gzip、sha256sum,不需網路
FROM alpine:3.20
# 備份檔名的日期與執行時刻用台灣時間(busybox 支援 POSIX TZ,不需 tzdata)
ENV TZ=UTC-8
COPY backup.sh /usr/local/bin/kb-backup
RUN chmod +x /usr/local/bin/kb-backup
USER 1000:1000
CMD ["kb-backup"]
