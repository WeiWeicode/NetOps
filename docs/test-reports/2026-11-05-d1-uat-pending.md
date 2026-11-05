# NetOps D1 未驗項目驗收報告(2026-11-05)

> 範圍:HANDOFF「2026-11-04 收工 › D1 未驗項目」1–3,以及「驗收發現的待改項目」的現況觀察。
> 方式:Claude 內建瀏覽器操作測試區,登入由使用者本人完成(Claude 未輸入帳密);主機 2 只執行唯讀指令(備份檔解壓到 `/tmp` 核對後刪除)。
> 寫入操作:只有一次「分析選取」(1 個 TRAFFIC 檔,使用者同意),後端略過、沒有產生分析結果。沒有新增知識庫筆記、沒有改主機設定。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 網址 | `https://giganexus-test.gigasolar.com.tw/netops/` |
| 部署區 | 測試區(主機 2) |
| 部署版本 | `netops-api`、`netops-kb-backup` 映像 `feba5e2f`(= `origin/develop` `feba5e2`,`docker ps` 確認);前端 release `feba5e2f`(giga-observe 事件 meta) |
| 瀏覽器 | Claude 內建瀏覽器(約 705px 寬) |
| 帳號 | S112009(`netops-admin`)、V112001(本機帳號;角色 `employee`、`it-admin`、`netops-viewer`,見 4.3) |
| 主機 2 指令(唯讀) | `docker ps`;`docker exec netops-api env`(只看 `FTP_*` 目錄類設定,未印密碼);`ls` / `tar -tzvf` / `sha256sum -c` NAS 備份;備份解壓到 `mktemp -d /tmp/...` 與 `docker cp` 的線上 `knowledge/` 做 `diff -r`,完成後刪除暫存 |
| 截圖 | scratchpad(未進版控):`01-pa-files-root.jpg`、`02-pa-files-my-data-after-analyze.jpg`、`03-viewer-pa-files-no-buttons.jpg` |

## 2. 結果摘要

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | Log 明細查詢(送出、結果表、取消、匯出;admin / viewer) | **未驗**:測試區 `FTP_LOG_DIR` 沒設定,`/my-data` 的 TRAFFIC 檔無法分析(見 3.1) |
| 2 | 安全事件頁無資料時不呼叫 API(!26) | **通過** |
| 3 | 知識庫備份可還原 | **部分通過 / 筆記未驗**:備份機制與還原核對通過(1 個檔,匯整檔);測試區仍 0 則筆記,筆記內容的還原未驗(見 3.2) |
| 4a | FTP 清單列出系統資料夾 | 仍存在 |
| 4b | viewer 開 AD FTP 頁就自動掃描 | 仍存在 |
| 4c | `/netops/` 被導回入口網 | 本次未發生(admin、viewer 各登入一次) |

### 2.1 項目 2 的細節(通過)
- netops-admin 開 `/netops/firewall/events`:有資料的「威脅」送出 `GET /api/netops/pa-events/overview?type=threat&from=2026-11-03&to=2026-11-03&top=15` → 200(正常)。
- 切換到沒有資料的「解密」「GlobalProtect VPN」「User-ID」,以及重新載入 `?type=decryption`:畫面顯示「還沒有解密 log 的分析資料」與「前往 FTP Log 檔案」,`read_network_requests` 只有 `pa-events/types` → 200,**沒有送出 `pa-events/overview`**。
- 架構觀測(GigaItApp `/it/gateway/observe` 與 `GET /api/observe/errors?serviceId=netops-api&hours=48`,requestId `7aa72115cd044f696a0029cd438fb95c`):`GET /v1/pa-events/overview` 400 共 19 筆,最後一筆 2026-11-04 09:33(+08,修正部署前);之後**沒有新增**。架構圖上 `netops-api` 12 次、0 錯誤。

## 3. 失敗與未驗項目

### 3.1 Log 明細查詢:TRAFFIC 檔在 `/my-data`,後端只接受 `FTP_LOG_DIR` 直屬檔案
- 步驟:netops-admin → `/netops/firewall/files` → 「TRAFFIC 流量」(同步目錄 `/`)→ 進入 `my-data`(20 天、3,627 檔、141 GB,全部未分析)→ 勾選 `PA-560_traffic_2026_11_05_last_calendar_day_0.csv`(38.5 MB)→ 分析選取(1)。
- 實際:`POST /api/netops/ftp/pa/analyses` → 200,但沒有加入佇列;之後 `GET /api/netops/ftp/pa/status`(requestId `77a0d0e953c7ae4c54beb7f397bcbcb1`)為 `traffic.total 0`、`queued 0`、`busy false`,檔案狀態維持「未分析」。
- 原因:`backend/src/modules/pa/importer.ts:353` `isTrafficLog` 要求 `dirname(p) === ftpConfig.logDir`;測試區 `netops-api` 的 `FTP_LOG_DIR` 是空值(compose `${FTP_LOG_DIR:-}`,程式預設 `/`),所以 `/my-data/*.csv` 在 `backend/src/modules/ftp/routes.ts:149–158` 被算進 `skipped`。
- 影響:測試區無法產生 TRAFFIC 分析結果,Log 明細查詢的送出、結果表、取消、匯出(含 viewer 匯出,HANDOFF 待決定 j)都驗不到。流量總覽也一直是「尚未分析任何 PA log」。
- 需要(依約定未自行處理):把測試區 `FTP_LOG_DIR` 設為 `/my-data` 並重建 `netops-api`(HANDOFF「2026-11-04 重新規劃」已提)。之後重驗時注意:一個檔約 38 MB,一天約 164 檔,先只分析 1 個檔。
- 另:畫面上「分析選取」被略過時,只有 toast「沒有檔案加入佇列 略過 1 個(不在 FTP 上、不是 log 或不在 log 目錄)」(依程式推得,本次未截到 toast)。`my-data` 可以瀏覽、可以勾選,卻永遠無法分析,容易誤會。

### 3.2 知識庫備份:筆記內容的還原未驗
- 測試區知識庫仍是 0 則筆記,`/data/knowledge/` 只有匯整檔 `_knowledge-all.md`(277 bytes,2026-11-04 10:26 產生)。
- NAS `/mnt/nas-docker/giga-netops/test/`:
  - `netops-kb-test-20261104.tar.gz`(97 bytes,只有目錄)、`netops-kb-test-20261105.tar.gz`(379 bytes,含 `_knowledge-all.md`),兩份 `sha256sum -c` 都 OK。
  - `LAST_RESULT`:`2026-11-05T02:02:15+0800 OK netops-kb-test-20261105.tar.gz files=1 size=4.0K`。
- 還原核對:把 20261105 解壓到暫存目錄,與 `docker cp` 取出的線上 `knowledge/` 做 `diff -r` → 一致(1 個檔,sha256 前綴 `7151f25030f215e4` 相同)。
- 未新增測試筆記的原因:新增筆記是寫入;而且備份每天只在 `KB_BACKUP_HOUR`(2 點)跑一次,今天的備份已完成(`done_today` 為真,重建容器也不會再備份),今天新增的筆記最快明天 02:00 才會進備份,今天無法驗到。
- 結論:備份、校驗、還原的流程正確;**含筆記(`*.md`)的還原未驗**。建議 D2 前在測試區新增 1 則測試筆記(先取得同意),隔天核對備份檔數 = 2 並解開比對,再刪除測試筆記。

## 4. 發現的問題與可能原因

### 4.1 FTP 清單仍列出系統資料夾
- `/netops/firewall/files` 的 FTP 根目錄仍列出 `$RECYCLE.BIN`、`System Volume Information`(截圖 01)。與 2026-11-04 相同,尚未修正。

### 4.2 viewer 開 AD FTP 頁仍自動觸發 FTP 掃描
- V112001 開 `/netops/ad/files`:載入時自動送 `POST /api/netops/ftp/ad/listings` → 202,接著輪詢 `GET /api/netops/ftp/ad/listings/{id}` → 200,畫面顯示「正在列出 FTP 上的日期資料夾(最長 3 分鐘)… 取消」。與 2026-11-04 相同,尚未修正。
- 這支 API 的 `x-permission` 是 `netops.ftp.write`(`backend/src/modules/ftp/ad-routes.ts:126`)。viewer 送得出去是因為 V112001 同時有 `it-admin`(見 4.3);**純 `netops-viewer` 帳號開這頁可能會回 403**,本次沒有純 viewer 帳號可驗。

### 4.3 `it-admin` 角色帶有 `netops.ftp.write` 等 NetOps API 權限;驗收用 viewer 帳號不是純 viewer
- V112001 的 `/api/auth/me` 角色為 `employee`、`it-admin`、`netops-viewer`;權限含 `netops.ftp.write`,但沒有 `netops.pa-files.manage` / `netops.ad-files.manage` / `netops.kb-page.write` 等按鈕權限,所以 PA FTP 頁的同步 / 分析 / 刪除按鈕都隱藏(截圖 03)。
- 經唯讀 `GET /api/admin/roles/{id}/permissions` 核對:`netops-viewer` 只有選單權限(與 `deploy/gateway-rbac.yaml` 一致);`it-admin` 帶有 `netops.ad.read`、`netops.ad-log.read`、`netops.ftp.read`、**`netops.ftp.write`**、`netops.pa.read`、`netops.ping.read`(純 API 權限,不在本 repo 的 `gateway-rbac.yaml` 中,來源未查:可能是 GigaItApp「權限設定 › API 權限」或 Gateway 端的設定)。
- 影響:
  - 所有 `it-admin` 成員都能直接呼叫 FTP 同步 / 分析 / 刪除分析結果的 API(按鈕隱藏只是體驗,AGENT §7.1),與「viewer 唯讀」的預期不同;同 HANDOFF 待決定 l 的性質。
  - 2026-11-04 報告中「netops-viewer 所有 `/api/netops/*` 讀取回 200」可能也受 `it-admin` 影響,純 viewer 的行為(含 4.2 的 403)未驗。

### 4.4 未登入時開 `/netops/`,前端回報一筆空白錯誤
- giga-observe `netops-web` 錯誤群組 `VIEW /netops/` status 0:2026-11-05 08:13(+08)一筆,`anonymous: true`,release `feba5e2f`,`error.message` 為空,堆疊 `index-7PAUHEvP.js:3:11979`(`Mc`)← `:3:16503`。時間對應本次未登入開頁、被導向 `/login` 的時候;2026-11-04 也有 3 筆(其中 2 筆是已登入但當時無權限)。
- 推測:導向登入或無權限導回時,守衛丟出不帶訊息的 `Error` 被監控當成錯誤。不影響使用,但會讓 `netops-web` 錯誤數一直增加。

### 4.5 `/netops/` 被導回入口網:本次未發生
- S112009、V112001 登入後開 `/netops/` 都直接進入(V112001 落在 `/netops/firewall/dashboard`)。HANDOFF 的這一項維持「原因未明、未再重現」。

## 5. 觀察到的風險

1. 測試區設定與實際 FTP 結構不一致(3.1):`FTP_LOG_DIR` 不設定時,TRAFFIC 永遠無法分析;正式區切換前要確認正式區的 `FTP_LOG_DIR` 值。
2. `my-data` 單日 164 檔、約 6.3 GB;分析全選一天的負擔大(測試區 FTP 同時連線 1),重驗時只分析 1 個檔。
3. 知識庫備份一天一次且當天只做一次:D2 複製舊版知識庫後,當天不會有新備份,要等隔天 02:00(或手動另行備份)。
4. 備份容器仍沒有 healthcheck(HANDOFF 已列),只能看 `LAST_RESULT`。
5. viewer 驗收帳號帶 `it-admin`,權限相關的驗收結論可能偏寬(4.3)。

## 6. 建議交給 Claude 處理的項目

1. 測試區 `FTP_LOG_DIR=/my-data` 的設定方式(由使用者在主機 2 執行或改 CI 環境變數),設定後重驗項目 1:admin、viewer 各做送出、結果表、取消、匯出。
2. `my-data` 等非 log 目錄的檔案在畫面上可勾選卻一定被略過(3.1):評估在 TRAFFIC 目錄外隱藏勾選框,或略過時說明「不在 TRAFFIC 目錄 `FTP_LOG_DIR`」。
3. FTP 清單過濾系統資料夾(4.1)。
4. AD FTP 頁改為手動列出或加快取,並確認純 viewer 開頁時的行為(4.2)。
5. 釐清 `it-admin` 的 `netops.*` API 權限來源,決定是否移除 `netops.ftp.write`(4.3,屬 Gateway / GigaItApp 設定,需使用者決定)。
6. 準備一個只有 `netops-viewer` 的測試帳號,重驗 viewer 的讀取與寫入 API 被拒(4.2、4.3)。
7. 前端導向登入 / 導回時不回報空白錯誤(4.4)。
8. 新增 1 則測試筆記(先取得同意),隔天核對備份含筆記並可還原(3.2)。
