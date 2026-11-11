# NetOps C2 寫入管線驗收(草稿,2026-11-10 起)

> 範圍:IMPL-PLAN **C2**。完成條件:測試區**連續 3 天**每小時筆數和 Redis 接收計數差 < 0.5%;重啟不漏、重複有修正;Redis 記憶體在上限內。
> 狀態:**草稿**。§1–§3 是合併前的測試;§4 第一次核對已完成(2026-11-11);§5 三天觀察之後再補。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 分支 | `feature/clickhouse-c2-collector`(收集器欄位)→ `feature/clickhouse-c2-ingest`(netops-ingest、DDL、Compose、CI),都從 `origin/develop` `cf5981f` |
| 部署區 | 主機 2 測試區(`GW_ENV=test`,ClickHouse TTL 3 天) |
| 服務 | `netops-ingest`(netops-api 同映像,`node dist/src/ingest/main.js`,256m);`netops-clickhouse` 26.3.62.3(1536m) |
| 驗收工具 | `deploy/clickhouse/verify-ingest.sh [小時數]`(只讀);重複修正 `deploy/clickhouse/dedupe-day.sh <容器> <日期>`(寫入,需求方同意後執行) |

## 2. 合併前測試

| 項目 | 指令 | 結果 |
| --- | --- | --- |
| 收集器 | `ruff check`、`pytest`(pa-collector) | 84 通過 |
| 後端型別 | `npm run typecheck` | 通過 |
| 後端單元測試 | `npm test`(含 `test/unit/ingest.test.ts` 38 項:熔斷、未知 400、大小上限、缺口誤報) | 234 通過(2026-11-11) |
| 整合測試 | CI `check:ingest-int`:一次性 Redis 7.4 + ClickHouse 26.3(同設定、schema、migrations、`netops_writer`),`npm run test:int`;`dedupe-day.sh` 測試 | pipeline 826(job 2519)通過:整合 9 項;兩筆相同列修正後原始表與彙總都是 1 |

CI 整合測試抓到並已修正的問題:① ClickHouse 26.x 的 HTTP 寫入預設走 async insert,`insert_deduplication_token` 不生效(同 token 重送寫兩次)→ 寫入帶 `async_insert=0`;② 來源表略過重送區塊時仍推給物化檢視(彙總重複)→ `deduplicate_blocks_in_dependent_materialized_views=1` + 彙總表去重視窗(migration 002);③ `XTRIM` 不更新 `max-deleted-entry-id` → 缺口改用計數 + 已回報基準。

整合測試涵蓋:JSONEachRow 欄位與型別(`seqno` 64 位元字串、IPv4 → `::ffff:`、台灣時間)、威脅類 migration 欄位、**同一 token 重送原始表與每小時彙總都不重複**、**寫入後 ACK 前當機 → 重啟補待處理清單不重複**、XTRIM 後的缺口偵測與「閒置類型」不誤報、Stream 過期後 group 自動重建、ClickHouse 錯誤代碼分類。

## 3. 驗收方法

### 3.1 每小時筆數(完成條件 1)

只讀。主機 2 上沒有固定的 NetOps checkout,從開發機把腳本經 SSH 送進主機 2 WSL 執行(在 NetOps repo 根目錄):

```sh
ssh host2 "wsl -u root -e sh -s 24" < deploy/clickhouse/verify-ingest.sh
```

- **TRAFFIC**:Redis `netops:pa:agg:traffic:{分鐘}` 的 `count` 加總(netops-pa 寫進 Stream 的筆數,保留 1 天)vs ClickHouse `pa_traffic_logs` 依 `received_at`(Stream ID 時間)每小時計數。
- **威脅類**:Redis Stream `netops:pa:log:{type}` 該小時的條目數(保留 2 天;agg 的 count 乘了 Repeat Count,不能直接比)vs `pa_threat_logs` 依 `log_type`、`received_at`。
- 差異 > 0.5% 的列會標 `<--`。`netops-ingest` 啟動之前的小時(TRAFFIC 只會補到 Stream 裡的最後 1 小時)不算。
- 每天跑一次(Redis 的 TRAFFIC 分鐘統計只保留 1 天),結果貼到 §5。

### 3.2 重啟不漏(完成條件 2a)

每次 develop 部署都會 `--force-recreate netops-ingest`(合併後的部署就是第一次)。重啟那個小時在 §3.1 的差異仍要 < 0.5%,心跳 `trimmed`、缺口清單 `netops:ingest:gaps` 沒有新增。要另外測時(寫入動作,需求方同意後):

```sh
docker restart giganexus-netops-test-netops-ingest-1
```

### 3.3 重複有修正(完成條件 2b)

`verify-ingest.sh` 的「重複」欄(同一 `seqno` 出現多次的筆數,每天)應為 0。正常情況下重送的批次被去重 token 擋掉;若不是 0,記下日期,請需求方同意後對**今天以前**的日期執行:

```sh
sh deploy/clickhouse/dedupe-day.sh giganexus-netops-test-netops-clickhouse-1 2026-11-11
```

(`OPTIMIZE … FINAL DEDUPLICATE` 只刪所有欄位都相同的列,再重建那一天的每小時彙總;CI 已驗證兩筆相同的列修正後原始表與彙總都是 1。)

### 3.4 Redis 記憶體(完成條件 3)

`verify-ingest.sh` 的「Redis 記憶體」:`used_memory` 低於 `maxmemory`(2 GB);consumer group `pending` 應接近 0(只有寫入中的那一批),`lag` 接近 0。收集器的 Stream JSON 多了 `seqno`、`sessionId`(每筆約 +50 bytes,TRAFFIC 1 小時約 +20–35 MB)。

## 4. 合併後第一次核對(2026-11-11 09:39–09:41 台灣時間,Claude,ssh 唯讀)

部署:!67、!68 合併,develop pipeline 830(`78114457`)通過。`netops-pa` 01:31:41 UTC 重建、`netops-ingest` 01:36:24 UTC 啟動(兩者 healthy);需求方已請網通對 `netops-syslog` 再 Commit,TRAFFIC 持續進 Redis。指令:`ssh host2 "wsl -u root -e sh -s 12" < deploy/clickhouse/verify-ingest.sh`,另以唯讀查詢做每 5 分鐘比對與容器記憶體。

### 4.1 筆數

**TRAFFIC**:ingest 第一次啟動時 consumer group 從 0 建立,只補得到 Stream 裡還在的最後 1 小時(Stream 第一筆 00:39:57 UTC,CQ13);更早的小時 ClickHouse 是 0 **是預期的**(ingest 還沒上線,不是缺口,`netops:ingest:gaps` 沒有紀錄),之後由 C3 的 FTP 補漏處理。Stream 涵蓋範圍內每 5 分鐘(收到時間,UTC)比對:

| 時段(UTC) | Redis 接收計數 | ClickHouse | 差異 |
| --- | --- | --- | --- |
| 00:35(Stream 從 00:39:57 起,不完整) | 39,672 | 29,543 | — |
| 00:40 | 35,451 | 35,456 | −0.01% |
| 00:45 | 40,579 | 40,502 | +0.19% |
| 00:50 | 38,582 | 38,625 | −0.11% |
| 00:55 | 38,692 | 38,618 | +0.19% |
| 01:00 | 36,281 | 36,356 | −0.21% |
| 01:05 | 36,931 | 36,935 | −0.01% |
| 01:10 | 35,705 | 35,694 | +0.03% |
| 01:15 | 41,366 | 41,407 | −0.10% |
| 01:20 | 37,163 | 37,184 | −0.06% |
| 01:25 | 37,392 | 37,368 | +0.06% |
| 01:30 | 35,604 | 35,585 | +0.05% |
| **00:40–01:34 合計** | **413,746** | **413,730** | **0.004%** |

單一 5 分鐘的 ±0.2% 是分桶時間差(Redis 分鐘桶用 `netops-pa` 收到的時間,ClickHouse 用 Stream ID 時間,相差約 1 秒),合計後抵銷。完成條件看的是**每小時**:第一個完整小時(10:00 台灣時間)起每天核對(§5)。

**威脅類**(Stream 保留 2 天,全部補進來):`verify-ingest.sh 12` 列出的 12 個小時(2026-11-10 21:00 – 2026-11-11 08:00 台灣時間)threat、url、data **每小時差異都是 0.000%**;wildfire 這段期間沒有 log。

### 4.2 心跳、缺口、重複

| 項目 | 結果 |
| --- | --- |
| 心跳 | `state ok`、`release 78114457`、`failing 0`、`insertFailures 0`;`malformed` / `trimmed` / `rejected` / `badTime` 各類型都是 0;`inserted` traffic 476,109、threat 9,387、url 21,816、data 165,440(啟動 3 分鐘內) |
| 落後 | `lagMs:traffic` 約 5–20 秒(批次 5 秒);threat 等量少的類型 `lagMs` 是「距最後一筆」的時間,沒有新 log 時會變大,不代表落後 |
| 缺口 | `netops:ingest:gaps` 空、`netops:ingest:gapbase` 空;consumer group 各類型 `pending 0`、`lag 0` |
| 重複 | 同一 seqno 重複 **0**(traffic、threat、url、data 每天都是 0) |
| seqno | `netops-pa` 01:31 重建後的 log 都有 `seqno`(01:35 那 5 分鐘 34,439 / 34,439);重建前寫進 Stream 的(舊收集器)沒有,ClickHouse 存 0:TRAFFIC 474,456 筆中 419,900 筆、威脅類 2026-11-10 全部 |

### 4.3 記憶體與大小

| 項目 | 結果 |
| --- | --- |
| `netops-redis` | `used_memory` 537 MiB(峰值 542 MiB)/ `maxmemory` 2 GB,noeviction |
| `netops-clickhouse` | 容器 348 MiB / 1.5 GiB;伺服器 `MemoryTracking` 84 MiB;寫入 256 次,單次最高 22.8 MiB、平均 64 ms |
| `netops-ingest` | 30 MiB / 256 MiB |
| ClickHouse 資料 | `pa_traffic_logs` 474,456 筆 8.0 MiB;`pa_threat_logs` 196,547 筆 2.2 MiB;每小時彙總 app 632 列、src 1,787 列 |

**結論**:寫入管線正常,Stream 涵蓋範圍內筆數一致、無缺口、無重複、記憶體都在上限內,沒有異常需要回報。重啟不漏(之後每次 develop 部署都會重建 `netops-ingest`)與連續 3 天的每小時核對在 §5 補。

## 5. 連續 3 天觀察

| 日期 | TRAFFIC 每小時最大差異 | 威脅類最大差異 | 重複 | 缺口 | Redis 記憶體 | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| (待補) | | | | | | |

## 6. 已知事項

- **需求方決定(2026-11-11)**:資安審查 C2 的 M3(`netops-redis` 加 ACL)**不做**,維持 D26 ①「不設密碼 / ACL,只靠 Compose 內部網路隔離」;L3(`netops_writer` 縮成只有 INSERT)**不做**,`netops-ingest` 繼續用 `netops_writer`(`SELECT`、`INSERT`、`ALTER DELETE`,C4 補漏共用)。

- `backend/test/unit/pa-live.test.ts` 的「超過全系統連線上限回 429」在本機全套測試時偶發失敗過一次(單獨跑通過;與本次變更無關,SSE 計時)。
- CI `check:ingest-int` 的輸出另存在主機 2 `/tmp/netops-int-<job id>.log`(保留 3 天)。
- netops-ingest 第一次啟動時 group 從 `0` 建立:Stream 裡現有的 TRAFFIC(最多 1 小時)與威脅類(最多 2 天)會一起寫進 ClickHouse。
