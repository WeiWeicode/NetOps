# NetOps C1 ClickHouse POC 與容量實測(2026-11-10)

> 範圍:IMPL-PLAN **C1**(需求方 2026-11-10 同意 E6:主機 2 測試區新增 `netops-clickhouse`,記憶體上限 1.5 GB、TTL 3 天)。
> 方式:Claude 在主機 2 以**臨時 POC 容器** `netops-clickhouse-poc` 跑實測(和本 MR 的 Compose 設定相同:同映像、同 `config.d` / `users.d`、1.5 GB 不給 swap、uid 101、無 capability、唯讀根目錄;不接網路,只用 `docker exec`)。實測完已刪除容器與 volume,正式的 `netops-clickhouse` 由本 MR 合併後的 CI 建立。
> 機密:Claude 沒有讀 `netops.env` 與任何機密檔。FTP 讀取在 `netops-api` 容器內沿用既有設定(`deploy/clickhouse/poc/ftp-cat.mjs`);ClickHouse 帳號測試用 `deploy/host2-set-clickhouse-secrets.sh` 產生到臨時目錄的**一次性密碼**,測完刪除。正式密碼要由需求方執行腳本產生(§7)。
> 寫入動作:只有 POC 容器與 volume(已刪除)、主機 2 `/root/netops-c1/`(工具與量測紀錄)、NAS 測試檔(§4.3,量完即刪)。FTP 唯讀;沒有動 `netops.env`、防火牆、portproxy、其他容器。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 分支 | `feature/clickhouse-c1-poc`(從 `origin/develop` `6d54cd5`) |
| 主機 | 主機 2(10.10.130.124)WSL:記憶體 5.8 GiB(開始前 available 3,232 MiB)、4 vCPU;`/` 剩 931 GB(實體 C 碟剩約 36 GB) |
| ClickHouse | `clickhouse/clickhouse-server:26.3.62.3`(26.3 LTS,2026-11-10 Docker Hub 最新的 26.3 修補版;26.8 LTS 較新,先用成熟度較高的 26.3) |
| 設定 | `deploy/clickhouse/config.d/low-memory.xml`、`users.d/default.xml`、`users.d/profiles.xml`;帳號檔 `host2-set-clickhouse-secrets.sh` 產生 |
| 資料表 | `deploy/clickhouse/schema.sql`(手冊 §7 DDL;`dst` 加 `bloom_filter`),`apply-schema.sh test` 套 TTL 3 天 |
| 資料 | FTP `10.10.130.66` `/my-data` 的 `PA-560_traffic_2026_11_10_last_calendar_day_{0..159}.csv`(PA-560 每天早上匯出**前一天** 2026-11-09〔週一〕的 TRAFFIC) |
| 工具 | `deploy/clickhouse/poc/`:`ftp-cat.mjs`(FTP 唯讀串流)、`import-day.sh` / `import-day.sql`(匯入)、`bench.sh`(容量與查詢) |

## 2. 匯入一整天 TRAFFIC

| 項目 | 實測 |
| --- | --- |
| FTP 檔案 | 160 個 CSV(每檔 65,535 筆,最後一檔 7,935 筆),合計 **6.55 GB**(6,551,393,169 bytes),130 欄 |
| 筆數 | **10,428,000 筆**;時間 2026-11-09 00:00:00–23:59:59,超出當天 0 筆、來源 IP 空值 0 筆 |
| 平均速率 | 120.7 筆 / 秒;每小時 29–70 萬筆,尖峰 08:00–09:00 **700,519 筆(195 筆 / 秒)**,夜間約 30 萬(83 筆 / 秒) |
| 匯入時間 | 管線合計 **228 秒**(FTP 讀取 + 解析 + 寫入,每檔平均 1.4 秒,約 28.7 MB/s、45,700 筆 / 秒);含每檔前後計數的總時間約 7 分鐘 |
| 單次 INSERT | 160 次,平均 880 ms、最長 1,795 ms;**記憶體平均 195 MiB、最高 198 MiB**(65,535 筆 CSV、`input_format_parallel_parsing=0`) |
| `OPTIMIZE FINAL` | 6.7 秒(合併成 1 個 part) |

FTP CSV 已有 **`Session ID`、`Sequence Number`** 兩欄,FTP 補漏可以直接帶 `seqno`、`session_id`(Syslog 要等 E3)。

## 3. 容量

### 3.1 ClickHouse(`system.parts`,`OPTIMIZE FINAL` 後)

| 表 | 筆數 | 壓縮後 | 未壓縮 | 壓縮比 | 每筆磁碟 |
| --- | --- | --- | --- | --- | --- |
| `pa_traffic_logs` | 10,428,000 | **204.5 MiB** | 1.16 GiB | 5.8 | **20.6 bytes** |
| `pa_traffic_hourly_app` | 5,017 | 69 KiB | 159 KiB | 2.3 | — |
| `pa_traffic_hourly_src` | 21,613(合併後) | 177 KiB | 848 KiB | 4.3 | — |

- 主鍵常駐記憶體 30 KiB;skip index 合計 402 KiB。
- 原始 CSV 6.55 GB → 205 MiB,約 **32 倍**。
- 欄位最大的前 5 名(bytes / 筆):`seqno` 4.26、`session_id` 2.51、`dst` 2.03、`sport` 1.89、`bytes` 1.01;其餘都 < 1。`seqno` 依排序鍵(小時、來源)排列後不再遞增,所以壓縮差;仍可接受,C2 可再試 `CODEC(T64, ZSTD)`。

### 3.2 Parquet(本機匯出,`max_threads=1`、ZSTD)

| 變體 | 大小 | 匯出時間 | 記憶體 |
| --- | --- | --- | --- |
| IP 轉文字(手冊 §8.4 的做法) | **199.9 MB**(19.2 bytes / 筆) | 33.9 秒 | 407 MiB |
| IP 保持 `IPv6` 二進位 | 199.9 MB | 25.5 秒 | 433 MiB |

兩者大小幾乎相同;文字版冷查詢可直接比字串並套用 row group 裁切(§4.3),**維持手冊的「IP 轉文字」**。

### 3.3 FTP 現況(`/my-data` 清單,唯讀)

| 項目 | 內容 |
| --- | --- |
| 最舊 / 最新 | `2026_10_16` … `2026_11_10`(25 天;**`2026_10_19` 沒有檔案**) |
| 合計 | 4,343 個檔、約 **181 GB** |
| 每天檔數 | 110–266 個 → **720 萬–1,743 萬筆 / 天**,25 天平均 174 個(**約 1,138 萬筆 / 天**);10-23–10-28 的檔(10-22–10-27 的 log)每天 222–266 個,明顯偏高 |

> FTP 上只看得到約 25 天,**像是有自動清除**,但這只是觀察,E1 仍要 FTP 管理者確認保留規則。

## 4. 代表查詢(`system.query_log`,第二次執行;單日 1,043 萬筆;`max_threads=2`)

### 4.1 總覽與 Top N

| 查詢 | 時間 | 記憶體 | 讀取筆數 |
| --- | --- | --- | --- |
| 每小時 × 動作(彙總表 `hourly_app`) | **9 ms** | 51 KiB | 5,017 |
| 同上(原始表) | 349 ms | 13 MiB | 1,043 萬 |
| Top 10 來源(彙總表 `hourly_src`) | 119 ms | 47 KiB | 23,469 |
| Top 10 來源(原始表) | 393 ms | 138 KiB | 1,043 萬 |
| Top 10 App(彙總表) | 7 ms | 59 KiB | 5,017 |
| Top 10 被拒絕的目的 Port(原始表) | 127 ms | 526 KiB | 1,043 萬 |
| Top 10 目的 IP(原始表) | 231 ms | 10 MiB | 1,043 萬 |

原始表掃一天 0.1–0.4 秒;**30 天約 4–12 秒**(線性推估),所以總覽與 Top N 照手冊走彙總表,原始表只給工作模式。

### 4.2 明細(一天範圍、`ORDER BY event_time DESC LIMIT 500`)

| 查詢 | 時間 | 記憶體 | 讀取筆數 |
| --- | --- | --- | --- |
| 來源 IP(排序鍵) | **30 ms** | 4 MiB | 40.7 萬 |
| 目的 IP,很少出現(約 50 筆 / 天),有 / 沒有 skip index | **73 ms** / 228 ms | 12 MiB | **29.5 萬** / 1,053 萬 |
| 目的 IP,約 5 萬筆 / 天(`8.8.4.4`),有 / 沒有 | 47 ms / 177 ms | 4 MiB | 41 萬 / 1,044 萬 |
| 目的 IP,約 2,000 筆 / 天,有 / 沒有 | 274 ms / 247 ms | 16 MiB | 271 萬 / 1,089 萬 |
| 目的 IP,全天都有(DNS `10.10.10.10`) | 185 ms / 208 ms | 16 MiB | 842 萬 / 1,002 萬 |
| 來源或目的 = 同一 IP | 284 ms | 17 MiB | 1,064 萬 |
| 目的 Port = 3389 | 104 ms | 16 MiB | 168 萬 |
| 來源網段 `10.10.112.0/24`:`src BETWEEN toIPv6(...) AND toIPv6(...)` | **63 ms** | 4 MiB | 245 萬 |
| 同上:`isIPAddressInRange(toString(src), '::ffff:10.10.112.0/120')` | 266 ms | 11 MiB | 301 萬 |
| 一小時全部 | 114 ms | 16 MiB | 112 萬 |

### 4.3 冷查詢(Parquet,`file()`,單執行緒)

| 查詢 | 本機磁碟(`netops_cold` 帳號) | NAS(SMB,`clickhouse local`) |
| --- | --- | --- |
| `count()` | 12 ms | 0.10 秒 |
| 來源或目的 = IP(文字比對) | 544 ms(只讀 17,169 筆:row group 裁切有效) | 1.28 秒 |
| 目的 = 少見 IP | 288 ms | 0.25 秒 |
| 一小時全部 | 299 ms(150 MiB) | — |
| Top 10 被拒絕 Port | 155 ms | 0.40 秒 |
| IP 二進位版 `src = toIPv6(...)` | 98 ms,但讀全部 1,043 萬筆(沒有裁切) | — |

- NAS:複製 200 MB 到 `/mnt/nas-docker/giga-netops/test/pa-archive-poc/` 1.4 秒,SHA-256 前後一致;**量完已刪除檔案與目錄**。NAS 剩 18 GB 不變。
- 最多 7 天的冷查詢估計 1–10 秒,維持工作模式(手冊 §8.5)。

## 5. 要在 C1 確認的項目

| 項目 | 結果 |
| --- | --- |
| `IPv6` skip index | **支援 `bloom_filter`**。少見的目的 IP 讀取量降 97%、時間約 1/3;常見 IP 沒效果也不會變慢太多。採用 `INDEX idx_dst dst TYPE bloom_filter(0.01) GRANULARITY 1`(索引 402 KiB / 天) |
| IP 網段查詢 | 用排序鍵範圍 `src BETWEEN toIPv6('a.b.c.0') AND toIPv6('a.b.c.255')`(應用程式先把 CIDR 換成起訖),比 `isIPAddressInRange` 快 4 倍;不用正規表示式 |
| Parquet 讀回條件 | IP 轉文字後 `WHERE src = '10.10.130.31'` 可用,row group 裁切有效;`file()` 路徑相對 `user_files`。冷查詢帳號要 `GRANT CREATE TEMPORARY TABLE ON *.*` 和 `GRANT READ ON FILE`(26.3 的語法;寫在同一行會被拒絕),`readonly=2` 下可執行 |
| 低記憶體設定名稱(26.3) | 伺服器:`max_server_memory_usage_to_ram_ratio`(依 cgroup 上限計算:1536 MiB × 0.75 = **1,152 MiB**)、`mark_cache_size`、`primary_index_cache_size`、`index_mark_cache_size`、`uncompressed_cache_size`、`vector_similarity_index_cache_size`、`compiled_expression_cache_size`、`query_condition_cache_size`(26.x 新增,預設 100 MB)、`max_concurrent_queries`、`background_pool_size`、`background_common_pool_size`、`background_move_pool_size`、`background_fetches_pool_size`(都在 `system.server_settings` 核對過)。**`background_pool_size` 調到 4 時,`<merge_tree>` 的 `number_of_free_entries_in_pool_to_execute_mutation`(預設 20)、`…_to_lower_max_size_of_merge`、`…_to_execute_optimize_entire_partition` 要 ≤ 8,否則啟動失敗**。查詢層:`max_threads`、`max_memory_usage`、`max_bytes_before_external_group_by` / `_sort`、`input_format_parallel_parsing`、`output_format_parallel_formatting`、`min_insert_block_size_bytes` |
| 帳號權限 | `netops_reader`:INSERT 被拒、`file()` 被拒、`SETTINGS max_execution_time=500` 被 constraints 拒絕;審查後補 `<min>1</min>`(ClickHouse 的 0 代表不限制):reader / writer 設 `max_memory_usage=0`、`max_execution_time=0`、`max_result_rows=0` 都回 452 `SETTING_CONSTRAINT_VIOLATION`,`max_threads` 改 `const`(設 0 時實際仍是 2);`netops_writer` 可 INSERT;三個帳號都讀不到 `system.users`;`default` 只限容器內 `127.0.0.1` / `::1` |
| 容器限制 | uid 101、`cap_drop: ALL`、唯讀根目錄 + `/tmp` tmpfs 可以正常執行;不對主機開 port(只有內部網路,`internal=true`)。審查後關掉 MySQL 9004、PostgreSQL 9005、interserver 9009,容器內只監聽 8123、9000(另有一個 ClickHouse 內部的臨時 port)。帳號檔不存在時 `up` 直接失敗(`create_host_path: false`),不會自動建空目錄 |
| Compose / CI 步驟 | 以臨時 project(`GW_ENV=c1dry`、審查修正後再用 `c1rv` 跑一次)照 CI 指令跑:`up -d --wait netops-clickhouse` healthy、`apply-schema.sh` 建表、記憶體上限檢查通過、reader 登入 OK;`down -v` 清除 |
| TTL 依部署區 | `apply-schema.sh test` → 4 張表 3 天;改跑 `prod` → 30 天 / 90 天 / 13 個月 / 90 天,再跑 `test` 改回 3 天(只改中繼資料) |

已知訊息(無害):映像 entrypoint 會印 `Not found: logger.log` / `logger.errorlog`(我們把 log 檔關掉、只輸出 stdout);POC 不接網路時印 DNS 解析警告(Compose 內不會)。

## 6. 記憶體與其他服務

| 項目 | 實測 |
| --- | --- |
| ClickHouse 閒置 | `MemoryTracking` 74 MiB;容器(含頁快取)266 MiB |
| ClickHouse 匯入期間 | `MemoryTracking` 最高(每 15 秒取樣,14:24 起)**479 MiB**;容器 cgroup 最高 1,018 MiB(含頁快取,沒有 OOM) |
| 最大單一操作 | Parquet 匯出 407–433 MiB;INSERT 198 MiB;查詢 ≤ 150 MiB |
| WSL available | 開始前 3,232 MiB → 匯入期間最低 **2,467 MiB** → 刪除 POC 後 3,297 MiB |
| `netops-redis` | 327.6 → 333.1 MiB(2 GB 上限內) |
| `netops-pa` | 34 → 42 MiB;心跳 `dropped 0`、`rejected 0`、`malformed 0`、`redisFailed 0`;HTTP 接收持續(`received` 增加、威脅 / URL 每分鐘彙總持續到 14:31) |
| `netops-api` | 46 → 99 MiB(POC 的 `ftp-cat` 在這個容器裡跑,算在它的 cgroup;跑完回落),`/readyz` ok |
| Gateway `bff-1` | 105 → 106 MiB;Gateway、giga-observe 容器都沒有重啟 |

> ⚠️ **TRAFFIC Syslog 從 13:45 起沒有進來**(和 C1 無關,發生在 C1 開工前):`netops-pa` 在 13:45:19 重啟(CI 部署),TRAFFIC Stream 最後一筆在 13:45:16、`netops:pa:agg:traffic` 最後一分鐘 13:45,`netops-pa` 沒有 Syslog 連線;HTTP 類型正常。就是 HANDOFF 記的「PA-560 Syslog TCP 斷線(error 110)後不會自動重連」,**要請網通對 `netops-syslog` 再 Commit 一次**。C2 的「每小時筆數和 Redis 接收計數比對」要等這個恢復。

## 7. 合併前後需求方要做的事

1. **合併前**,在主機 2 WSL 執行(產生 3 個 ClickHouse 帳號的隨機密碼與帳號檔,不需要輸入、不會顯示):
   ```sh
   sudo sh deploy/host2-set-clickhouse-secrets.sh
   ```
   沒有執行時,CI `deploy-api-test` 會在「缺少 ClickHouse 帳號檔」停下:`netops-api`、`netops-kb-backup`、`netops-redis`、`netops-pa` 已更新,但後面的 `/healthz` 冒煙測試與路由註冊檢查、`deploy-web-test`、`rbac-test` 不會執行;補跑腳本後重跑 pipeline 即可。
2. 合併後 CI 起 `netops-clickhouse`、建表(TTL 3 天)。之後要重灌 POC 資料可在主機 2 用 `deploy/clickhouse/poc/import-day.sh`(非必要;C2 起資料由 `netops-ingest` 寫入)。
3. 請網通對 `netops-syslog` 再 Commit(§6 警示)。

## 8. 換算給 C0 外部事項的建議數字

基準:**每天 1,140 萬筆(25 天平均)、尖峰日 1,743 萬筆**;ClickHouse 20.6 bytes / 筆、Parquet 19.2 bytes / 筆。

| 項目 | 原估 | 實測換算 | 建議 |
| --- | --- | --- | --- |
| ClickHouse TRAFFIC 30 天 | 9–27 GB | 平均 7.0 GB、尖峰持續 10.8 GB | — |
| ClickHouse 磁碟(含威脅 90 天、彙總、合併暫存 × 1.5、系統 log) | 40 GB | 約 12–17 GB | **E5:主機 3 vhdx 所在磁碟預留 20 GB** |
| Parquet 每天 | 0.4–1.0 GB | 平均 218 MB、尖峰 334 MB | — |
| Parquet 一年(原始 log) | 150–370 GB | 平均 80 GB、尖峰持續 122 GB | **E2:申請 150 GB / 年**(含威脅類與 1.2 倍緩衝);只歸檔每小時彙總時約 0.1 GB / 年 |
| 現有 NAS 18 GB | 放 18–45 天 | 約 80 天(平均)/ 54 天(尖峰) | 不夠 1 年 |
| ClickHouse 記憶體(正式區) | 2 GB 最低、4 GB 建議 | 最大單一操作約 430 MiB,閒置 74 MiB | **E5:容器上限 2 GB(伺服器上限 1.5 GB)即可**;主機 3 available 約 4.2 GB,扣 ClickHouse 2 GB 與 `netops-ingest` 256 MB 後約 1.9 GB。**不必先加大 WSL**;上線一週若 available 長期低於 1.5 GB 再排加大 |
| 測試區(主機 2) | — | 3 天約 0.6–1.0 GB 磁碟 | C 碟 36 GB 夠用 |

## 9. 給 C2 的建議

1. **欄位**:FTP 有 `Sequence Number`、`Session ID`,FTP 補漏立即可用 `seqno` 去重;Syslog 要 E3 加 `$seqno`、`$sessionid`。
2. **批次**:Syslog 約 80–200 筆 / 秒,3–5 秒一批只有幾百筆,一批一個 part、背景合併負擔小;建議 5 秒一批,帶 `insert_deduplication_token`(表已設 `non_replicated_deduplication_window = 1000`)。
3. **記憶體**:`netops_writer` 的 `max_memory_usage` 500 MB 對 Parquet 匯出(407 MiB)餘裕約 90 MB;C4 若改匯出全部欄位或資料量到尖峰日(1.7 倍),要調到 700 MB 或分小時匯出。
4. **查詢**:總覽 / Top N 只查彙總表;網段條件轉成 `BETWEEN`;`dst` 保留 bloom_filter。
5. **對帳**:FTP 每檔 65,535 筆、檔名序號連續,對帳可先比檔數 × 65,535 再逐小時計數;`2026_10_19` 這種整天缺檔要標成「FTP 缺檔」而不是 ClickHouse 缺口。
6. **網路隔離**(資安審查 L3):`netops-pa` 接收外部 Syslog,也在 `netops-internal`;C2 起建議 ClickHouse 改放另一個只接 `netops-api`、`netops-ingest` 的 internal 網路。
7. **CI 重建**:`deploy-api-test` 對 `netops-clickhouse` 一律 `--force-recreate`(掛載的設定檔改了 Compose 不會自動重建),每次部署中斷數秒;C2 起 `netops-ingest` 靠 Redis Stream 緩衝,不會掉資料。
8. **映像**:固定 `26.3.62.3`;升級前在測試區驗證(26.x 的設定名稱和 25.x 有差異,例如新增 `query_condition_cache_size`、`primary_index_cache_size`)。

## 10. 偏離與注意事項

- 審查:`security-auditor` 無 Critical / High;修正 M1(constraints 下限)、M2(`bench.sh` 密碼改經環境變數,不出現在命令列)、L1(關多餘協定 port)、L2(writer 加 constraints);L3 列入 §9。`code-reviewer`:CI 改 `--force-recreate`、帳號檔缺少時冒煙測試會被跳過(§7 已寫明)、手冊 DDL 縮排、匯入工具加筆數警告。runner checkout 的檔案是 664,容器 uid 101 讀得到。

- 確認 CSV 欄位時,在主機 2 `/tmp` 暫存過一個 FTP 檔(7,936 筆,最後一檔)看欄位名稱,看完立即刪除;正式匯入全程走管線,沒有落地。
- 本報告的「每 15 秒取樣」從 14:24 開始(匯入 14:21 起),匯入前段的尖峰以 `query_log` 每次 INSERT 的記憶體(198 MiB)補足。
- 威脅類(`pa_threat_logs`)C1 沒有匯入,90 天容量仍是估算(0.3–1 GB)。
- 30 天的查詢秒數是線性推估,不是實測(測試區只有 3 天 TTL)。
