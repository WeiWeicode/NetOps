# NetOps C2 寫入管線驗收(草稿,2026-11-10 起)

> 範圍:IMPL-PLAN **C2**。完成條件:測試區**連續 3 天**每小時筆數和 Redis 接收計數差 < 0.5%;重啟不漏、重複有修正;Redis 記憶體在上限內。
> 狀態:**草稿**。§1–§3 是合併前的測試;§4 第一次核對待合併部署後由 Claude 補;§5 三天觀察之後再補。

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
| 整合測試 | CI `check:ingest-int`:一次性 Redis 7.4 + ClickHouse 26.3(同設定、schema、migrations、`netops_writer`),`npm run test:int`;`dedupe-day.sh` 測試 | 見 MR pipeline |

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

## 4. 合併後第一次核對

(待補:部署 pipeline、心跳、`verify-ingest.sh` 結果、TRAFFIC Syslog 是否已恢復——collector 合併會重建 `netops-pa`,要網通對 `netops-syslog` 再 Commit 後 TRAFFIC 才會進來。)

## 5. 連續 3 天觀察

| 日期 | TRAFFIC 每小時最大差異 | 威脅類最大差異 | 重複 | 缺口 | Redis 記憶體 | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| (待補) | | | | | | |

## 6. 已知事項

- `backend/test/unit/pa-live.test.ts` 的「超過全系統連線上限回 429」在本機全套測試時偶發失敗過一次(單獨跑通過;與本次變更無關,SSE 計時)。
- CI `check:ingest-int` 的輸出另存在主機 2 `/tmp/netops-int-<job id>.log`(保留 3 天)。
- netops-ingest 第一次啟動時 group 從 `0` 建立:Stream 裡現有的 TRAFFIC(最多 1 小時)與威脅類(最多 2 天)會一起寫進 ClickHouse。
