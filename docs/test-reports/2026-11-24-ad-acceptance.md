# 驗收報告:AD 事件即時收集(測試區 AD-1 / AD-3 / AD-6)

> 狀態:**完成**(第 4 項需求方決定不做;AD-2 Agent 實測不在本次範圍)。無功能失敗;發現 1 個文件缺陷(Medium)與數項待辦。需求方帳號操作並提供畫面,Claude 以瀏覽器唯讀查證、需求方動手改主機。

## 1. 環境

- 測試區 `https://giganexus-test.gigasolar.com.tw/netops/`,develop 部署 pipeline 1325–1331(已由主串確認),develop commit `90ddb22`。
- 主機 2(測試區)。AD 資料:DC `GSMC-DC1`,FTP 匯入 2026-10-19 ~ 2026-11-23;ClickHouse 測試區 TTL 3 天,只有 11/22、11/23。AD Agent 尚未裝到任何 DC。
- 登入帳號:需求方帳號(資訊服務部,一般人員)。
- 操作與查證:瀏覽器(畫面與 `fetch` 讀取 API),主機只做唯讀查詢(`ls`、`grep -c`、`docker compose ls`);主機寫入(`.env`、重新部署)由需求方執行。

## 2. 驗收清單與結果

| # | 項目 | 結果 | 備註 |
| --- | --- | --- | --- |
| 0 | GigaItApp 發佈新路由 | **通過** | 發佈版本 v85(線上):+5 新增(`netops.ad-backfill.create`、`netops.ad-backfill.get`、`netops.ad-recon.list`、`netops.ad-recon.run`、`netops.ad.agents`)、~1 修改(`netops.ad.days`)。AD 選單(事件總覽、Log 明細查詢、FTP Log 檔案、AI 問答)可見;`netops.ad-files.manage` 以第 2 項「立即對帳」成功確認 |
| 1 | ftp 來源 | **通過** | `/ad/days` 回 `source: ftp`;總覽沒有 DC 狀態列。總覽 11/23:事件 3,215(系統 626、DNS 1,526、安全性 1,050、目錄服務 13)。「需要注意」13 筆,ID 為 4771、37、4625、4738、5719、2089、4740、4725、3041、2887、4724、4722、4729,**無 4723、4742、群組屬性變更**(但 11/23 當天本來可能沒有這些事件,證據偏弱)。明細 DC 篩選:`GSMC-DC1`、`gsmc-dc1`、`gsmc-dc1.gsmc.com.tw` 皆回同一批,`NOPE-DC9` 回 0 筆。AD-6 名稱:事件 2887 顯示「未簽署或明文 LDAP 繫結彙總」;7036、3150、37、3041 不在名稱表,「事件」欄空白(預期,見 §3 觀察 2) |
| 2 | ClickHouse 對帳與補漏卡片 | **部分通過** | 列出 11/22、11/23 兩天,皆「一致」(FTP 4 檔、缺口 0、多出 0;各 DC × 記錄:`ftp` = `ch` = `chFtp`,`chAgent` = 0)。載入頁面只有 GET(`/ad/reconciliations`、`/ftp/ad/status`),**沒有多餘的 POST**。需求方按 11/23「立即對帳」成功。**未驗**:「補漏」按鈕與補漏工作輪詢到 done——兩天都沒有缺口所以沒有該按鈕 |
| 3 | 切換 clickhouse 來源 | **通過** | 需求方在 `/srv/giganexus/deploy/netops.env` 加 `NETOPS_AD_SOURCE=clickhouse`,重跑 `deploy-api-test`;日誌 `OK   netops-pa 沒有變更,沿用原容器(沒有重啟,Syslog 連線不受影響)`。`/ad/days` `source: clickhouse`、2 天;`/ad/agents` `items: []`、total 0,畫面「DC Agent 即時狀態」顯示「尚未有 DC Agent 回報」;總覽與明細 `source: clickhouse`,總筆數 3,215(與 ftp 相同);明細每列 `logEpoch: 0`、`source: ftp`、`dcDomain: gsmc.com.tw`、徽章「FTP 補寫」;總覽 `names` 6 筆(機房 · 伺服器網段(伺服器))、畫面顯示;「需要注意」同 13 筆;事件 2887 名稱正常;頁首「已有資料 2026-11-22 ~ 2026-11-23(2 天)」 |
| 4 | 錯誤顯示抽查 | **未做** | 需求方決定不做 |

統計:通過 4(0、1、3,與第 2 項部分)/ 部分 1(2)/ 未做 1(4)/ 失敗 0。

## 3. 失敗項目 / 可能問題

無功能失敗。

**文件缺陷(Medium)— `deploy/RUNBOOK-ad.md` §8.1**
- 步驟 2 寫的主機 `.env` 路徑 `/srv/giga-netops/test/.env` **不存在**;測試區真正的環境檔是 `/srv/giganexus/deploy/netops.env`(CI 的 `NETOPS_ENV_FILE`)。需求方照寫的路徑用 `>>` 追加時,在主機上**多建了一個只含一行的 `.env`**(28 位元組、root,2026-11-24 15:36),沒有程式讀它,已由需求方刪除(事後 `ls -a` 確認)。
- 步驟 3 的手動指令 `docker compose --env-file <.env> -f deploy/docker-compose.yml up -d --no-deps netops-api` 沒有 CI 在部署時 `export` 的 `IMAGE_TAG`(`.gitlab-ci.yml` deploy-api-test:`IMAGE_TAG=$CI_COMMIT_SHORT_SHA`),`docker-compose.yml:33` 會落回 `netops-api:dev`,可能重建成錯誤映像;compose 專案名稱是 `giganexus-netops-test`,檔案在 runner 的 build 目錄,不是文件寫的相對路徑。
- 本次改以「`netops.env` 加一行 → GitLab 重跑 `deploy-api-test`」套用,`netops-pa` 沿用原容器。
- 建議:§8.1 改寫路徑與套用方式;正式區(`/srv/giganexus/deploy/netops.env`、`deploy-prod`)同樣處理。

**待辦(需求方決定,不屬本次修正)**
- 防火牆 › FTP Log 檔案頁(`/netops/firewall/files`)「每日自動同步」表格的「AD 事件」列要移除,AD 的 FTP log 只從「AD 網域 › FTP Log 檔案」看(需求方 2026-11-24 決定;前端,待開發)。

**觀察(Low)**
1. ftp 來源下,明細每列的資料來源徽章都顯示「FTP 補寫」,但這些列是直接讀 FTP 檔,不是補寫進 ClickHouse,語意容易誤導(切到 clickhouse 後同一個徽章才正確)。
2. 名稱表(`channelEvents`)只收 AD-6 規劃的 ID(System 6、Directory Service 8、DNS Server 3),所以常見的 System 7036、1、37、DNS 3150、目錄服務 3041 在「事件」欄沒有名稱,只在「訊息」欄有 DC 的原文。是否擴充由需求方決定。
3. 對帳卡片在沒有缺口時沒有「補漏」按鈕,補漏路徑(`POST /ad/backfills`、工作輪詢、`waitingAgent` / `ambiguous` 說明)沒有實測。需等 11/24 之後 Agent 與 FTP 出現缺口,或在 AD-2 實測時一併驗。
4. 防火牆 FTP 頁的「前一天尚未完成」是 User-ID 11/23 沒有檔案(3/4 類),與 AD 無關。

## 4. 最後設定與需求方決定

- `NETOPS_AD_SOURCE`:測試區 `/srv/giganexus/deploy/netops.env` 為 `clickhouse`,**維持**(需求方 2026-11-24 決定)。
- 防火牆 FTP 頁「AD 事件」列移除:需求方決定,待開發。
- 第 4 項不做。

## 5. 建議

1. 修 RUNBOOK-ad §8.1(路徑與套用方式),正式區上線前處理。
2. 前端移除防火牆 FTP 頁「AD 事件」列(Gemini 範圍)。
3. 評估 ftp 來源下的徽章文字,或改在 ftp 來源不顯示。
4. AD-2 實測時一併驗補漏流程與 DC 狀態列(有 DC 回報、停止更新、離線)。
5. 觀察 `NETOPS_AD_SOURCE=clickhouse` 隔天 08:10 的對帳與自動補漏(11/24 資料)。
