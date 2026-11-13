# 後端修改紀錄

> `backend/`、`deploy/` 的修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-13 AI 分析、問答、外部 IP 學習改查 ClickHouse(AC2)
- 工作項目:AC2(ARCHITECTURE D44)
- 內容:
  - 新增 `modules/ai/ch-source.ts`:分析(每小時摘要 + `pa_heat_1d` / 每小時彙總的粗摘要,`meta.grain`)、PA 其他 log(威脅類 30 天內每小時摘要、30–90 天原始表前 30 種組合;解密 / GlobalProtect / User-ID 仍讀 FTP 摘要)、問答證據(原始 TRAFFIC 依組合與小時累計最多 20,000 列 + 15 筆範例;威脅類依組合累計;超過保留期限標示 `skipped`)、外部 IP 學習的 `recentSummaries`(每小時摘要)。
  - `infra/clickhouse/reader.ts`:新增 `aiTrafficFlows`、`aiTrafficSamples`、`aiThreatGroups`、`aiDays`、`aiTops` 與 `aiWhere`;IP 條件抽成 `ipClause`(`trafficWhere` 共用,行為不變)。值一律放 query_params。
  - `modules/ai/service.ts`:依來源分流(`ftp` 舊流程原封保留);`prepareAnalysis` / `prepareQuestion` 改 async,ClickHouse 失敗在串流開始前回 503;AD 問題 ClickHouse 失敗時只略過防火牆資料。`meta` 加 `source` / `dataSource`、粒度;`scan` / `evidence` 加 ClickHouse 欄位。
  - `config.ts`:`NETOPS_AI_SOURCE`(未設定時 test → clickhouse、prod / dev → ftp)、`IPLEARN_DAYS` 上限 30;`POST /kb/ip-learnings` 的 `days` 上限 30。
  - `ai/core/context.js` `buildContext` 加選填 `opts.source`(來源說明;不給時同舊版)。`iplearn.js` 的 `recentSummaries` 可回 Promise(`await`,舊版測試基準仍相同)。`pa-events/importer.ts` `eventsForIps` 加 `types`。`evidence.js` 未改(與舊版逐字相同的測試仍通過)。
  - Compose:`NETOPS_AI_SOURCE`(空白依 GW_ENV);`deploy/test.env.example` 加說明。
- 檔案:`backend/src/modules/ai/ch-source.ts`、`backend/src/modules/ai/service.ts`、`backend/src/modules/ai/index.ts`、`backend/src/modules/ai/routes.ts`、`backend/src/modules/ai/core/context.js`、`backend/src/infra/clickhouse/reader.ts`、`backend/src/config.ts`、`backend/src/app.ts`、`backend/src/modules/kb/ai-routes.ts`、`backend/src/modules/iplearn/core/iplearn.js`、`backend/src/modules/pa-events/importer.ts`、`deploy/docker-compose.yml`、`deploy/test.env.example`、`backend/test/unit/ai-ch.test.ts`、`backend/test/integration/ai.int.test.ts`、`backend/test/fixtures/fake-ch.ts`
- 驗證:見 MR(typecheck、`npm test`、`npm run build`;整合測試在 CI `check:ingest-int`)

## 2026-11-13 對帳後每日同步解密 / GlobalProtect / User-ID / AD(AC1)
- 工作項目:AC1(ARCHITECTURE D43、D44)
- 內容:新增 `modules/ftp/daily-sync.ts`:自動對帳每一輪結束後(`createReconciler` 新增 `after`)接著同步這四類;只排 FTP 保留期限內的日子(依檔名日期,`fileDataDay`),不同步 TRAFFIC 與威脅類。前一天沒全部匯入時照對帳規則每 10 分鐘再看、FTP 30 分鐘最多列一次、一天最多 90 次後停止並 warn;超過保留期限仍沒匯入記 warn(每類型每天一次,從沒匯入過的類型不記)。其他類型 log 的 `sync` 可只排指定類型與日期,新增 `dayState`、`hasAnyFile`;AD 新增 `dayState`、`hasAnyDay`。`GET /ftp/pa/status`、`GET /ftp/ad/status` 加 `daily`。新設定 `NETOPS_DAILY_SYNC`(預設 1)。
- 檔案:`backend/src/modules/ftp/daily-sync.ts`、`backend/src/modules/pa/reconcile.ts`、`backend/src/modules/pa/importer.ts`、`backend/src/modules/pa-events/importer.ts`、`backend/src/modules/ad/importer.ts`、`backend/src/modules/ftp/routes.ts`、`backend/src/modules/ftp/ad-routes.ts`、`backend/src/app.ts`、`backend/src/config.ts`、`deploy/docker-compose.yml`、`backend/test/unit/daily-sync.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`(見 MR)

## 2026-11-13 對帳改每天 08:10、缺口自動補漏
- 工作項目:C3(需求方 2026-11-13 決定)
- 內容:對帳時間支援分鐘(`NETOPS_RECON_TIME=HH:MM`,預設 08:10;舊 `NETOPS_RECON_HOUR` 相容,`-1` 不自動)。自動對帳發現 `gap` 時同手動補漏的流程送出工作(`createdBy` = `system:recon`;`planBackfill` 手動與自動共用),補漏排隊 / 執行中、FTP 還沒分析、佇列滿時照對帳重試規則每 10 分鐘再試,同一天每天最多自動送 3 次、補完 20 分鐘後才重新判斷、全系統同時只有 1 個自動補漏(資安審查:不擋人工補漏);FTP 保留期限(`NETOPS_FTP_RETENTION_DAYS`,預設 10,最多 30)內的缺口與 pending 每天再補,到期仍未完成記 warn。`NETOPS_RECON_AUTO_BACKFILL=0` 關閉。
- 檔案:`backend/src/config.ts`、`backend/src/app.ts`、`backend/src/modules/pa/reconcile.ts`、`backend/src/modules/pa/recon-routes.ts`、`deploy/docker-compose.yml`、`backend/test/unit/ch-recon.test.ts`、`backend/test/unit/ch-overview.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`(見 MR)

## 2026-11-13 Log 明細查詢加威脅 log 與來源 / 目的國家(V-b2 驗收 C7 第二輪)
- 工作項目:V-b2 驗收追加(需求方 2026-11-13 決定)
- 內容:`POST /pa/log-searches` 加 `type`(TRAFFIC / THREAT)、`severity`、`threat`、`srcCountry`、`dstCountry`。THREAT 查 `pa_threat_logs`(log_type = threat;`reader.searchThreat`、`threatSearchWhere`、`threatCount`),資料列 `threat` 為威脅名稱、嚴重度 informational 回 info,匯出檔名 `PA_threat_`;TRAFFIC 帶 severity / threat 回 400。`trafficWhere` 加 srcCountry / dstCountry,`searchTraffic` 與 `searchThreat` 共用 `search()`。路由與權限不變。
- 檔案:`backend/src/infra/clickhouse/reader.ts`、`backend/src/modules/pa/log-routes.ts`、`backend/test/fixtures/fake-ch.ts`、`backend/test/unit/ch-detail.test.ts`、`backend/test/integration/reader.int.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`(見 MR);`test:int` 看 CI

## 2026-11-13 熱力圖:彙總表沒有的格子回 null 並列進 gaps(C1)
- 工作項目:V-a(V-b2 第一輪驗收 C1)
- 內容:`buildCells` 原本把 `coverage.since` 之後、彙總表沒有列的格子補成 0,11-13 00:00–08:30(彙總部署前)因此顯示 `v=0`、`partial=false`、`gaps=[]`。改成沒有列一律 `v=null`、`level=0`;`since` 之後、已結束超過 10 分鐘(`MISSING_GRACE_MS`,避免最後幾格遲到的寫入一直閃「不完整」)的連續缺格合併成 `{ reason: 'no-data' }`,併進 `coverage.gaps`,重疊的格子 `partial=true`。`gapsKnown` 仍只代表每日對帳。`docs/API.md` §4.4、OpenAPI `description` / `x-gherkin` 同步。時段明細 `severity` 後端原本就支援,不改。
- 檔案:`backend/src/modules/pa-heat/heat.ts`、`service.ts`、`routes.ts`、`backend/test/unit/pa-heat.test.ts`、`docs/API.md`
- 驗證:`npm run typecheck`、`npm test`(330 / 330)、`npm run build` 通過;`npm run test:int` 本機沒有 Docker,交給 MR 的 CI(整合測試未改)

## 2026-11-13 冷歸檔 NAS 準備腳本:權限檢查誤報
- 工作項目:C4
- 內容:`deploy/host2-setup-pa-archive.sh` 的群組權限檢查 `case "$G" in "1000 d???r?x"*)` 把萬用字元 `?` 放在引號內,被當成字面字元,永遠比對不到,權限正確(群組 1000、`r-x`)也印 WARN(需求方 2026-11-13 在主機 2 執行時發現)。改成 `"1000 d"???r?x*`(引號外才是萬用字元)。只影響提示訊息:目錄、標記檔與寫入測試本來就正確,不需要重跑腳本。
- 檔案:`deploy/host2-setup-pa-archive.sh`
- 驗證:同一段比對在本機 sh 與主機 2 WSL(dash)執行:`1000 drwxr-x---`、`1000 drwxr-xr-x`、`1000 drwxrwx---` 通過;`0 drwxr-x---`、`1000 drwx------`、`1000 drwxr-----`、`10000 drwxr-x---` 警告;`sh -n` 語法檢查

## 2026-11-13 ClickHouse 建表:舊表也能升級(測試區部署失敗修正)
- 工作項目:V-a、C1(`BugFix.md` 同日紀錄)
- 內容:① `deploy/clickhouse/schema.sql`:`pa_traffic_hourly_src_mv` 之前先 `ALTER TABLE netops.pa_traffic_hourly_src ADD COLUMN IF NOT EXISTS bytes_sent / bytes_recv`;檔頭補規則「MV 用到 migration 才加的欄位,MV 之前要先補欄位」。其他 MV 檢查過:`pa_traffic_hourly_app_mv` 沒用到新欄位;熱力圖 6 個 MV 的目標表是 V-a 新表、來源欄位(`pa_traffic_logs.bytes_sent / bytes_recv`、`pa_threat_logs.severity / log_type / src`)C1 起就有;`migrations/001`(threat 欄位)沒有 MV 依賴;`002` 只改設定。② `deploy/clickhouse/test-upgrade.sh` 與 `upgrade-test/before-va.sql`(V-a 合併前 e0a8e79 的 schema + 001、002):套舊版 → 寫一列 → `apply-schema.sh` 兩次 → 檢查欄位、8 個 MV、003 的新查詢、升級後的寫入有進來源彙總與 3 個熱力圖表 → 刪資料庫;只能對 `netops-int-*` 容器執行。③ `.gitlab-ci.yml` `check:ingest-int` 在原本的空資料庫建表之前跑升級測試。
- 資料影響(主機 2 唯讀查詢,2026-11-13):測試區沒有 `pa_heat_5m / 1h / 1d` 與 6 個熱力圖 MV;`pa_traffic_hourly_src` 沒有上傳 / 下載欄位,MV 仍是舊查詢(sessions、bytes 有在寫);原始 TRAFFIC 從 2026-11-11 08:36 起。合併部署後用 `rebuild-day.sh` 回填(需求方同意後執行),步驟見 MR。
- 檔案:`deploy/clickhouse/{schema.sql,test-upgrade.sh,upgrade-test/before-va.sql}`、`.gitlab-ci.yml`
- 驗證:`sh -n`、CI `check:ingest-int`(本機沒有 ClickHouse)

## 2026-11-12 C4 冷歸檔與時段明細冷路由
- 工作項目:C4、V-a 第 5 步(ARCHITECTURE D30、D35;X1 = A 歸檔原始 log,CQ12、CQ14)
- 內容:① `netops-ingest` 每天 02:30 起把前一天的 TRAFFIC 與威脅類匯出成 Parquet(IP 轉文字、ZSTD、row group 10 萬列),本機暫存(volume `netops_ingest_staging`)→ NAS `pa-archive/YYYY/` 的 `.tmp` → 重讀比對 SHA-256 → ClickHouse(`netops_cold`)讀回列數 = 來源 → 改名、`.sha256`、manifest `netops.pa_archive_manifest`(migration 004)。② 失敗每小時重試到資料被 TTL 刪除前;D+25(測試區 D+2)心跳 `archiveState=late`、日誌 error;沒有標記檔 `.giga-netops-archive` 不寫(`nas-missing`)。③ 每小時比對來源列數,補漏 / 去重後重新歸檔。④ 保留期限 `NETOPS_ARCHIVE_KEEP_DAYS`(測試區 14、正式區 0 或 ≥ 366)。⑤ 冷查詢鎖加 `refresh`,歸檔與冷明細共用。⑥ `netops-api` 時段明細冷路由:先查 manifest(缺任何一天 404 `NETOPS_COLD_ARCHIVE_NOT_FOUND`),再以 Parquet 子查詢跑和熱路由相同的查詢(`heat.ts` 抽出 `runSlice`、`queryRunner`,熱路由行為不變)。⑦ Compose:`netops-clickhouse` 唯讀掛 NAS 歸檔到 `user_files/archive`、`group_add: ["1000"]`;`netops-ingest` 讀寫掛載與暫存 volume;兩個服務加 `ch_cold_password`;`NETOPS_ARCHIVE_ENABLED`(預設 1)。⑧ CI `check:ingest-int` 的一次性 ClickHouse 掛暫存歸檔目錄、整合測試 `archive.int.test.ts`;`deploy-api-test` 檢查 `ch_cold_password` 並顯示歸檔狀態。⑨ 需求方腳本 `deploy/host2-setup-pa-archive.sh`(建目錄與標記檔)。
- 檔案:`backend/src/{ingest/{archive,config,main}.ts,infra/clickhouse/{archive,heat}.ts,infra/redis/cold-lock.ts,modules/pa-heat/{cold,routes}.ts,app.ts,config.ts}`、`backend/Dockerfile`、`backend/test/{unit/archive.test.ts,integration/archive.int.test.ts}`、`deploy/{docker-compose.yml,host2-setup-pa-archive.sh,clickhouse/migrations/004-c4-archive-manifest.sql}`、`.gitlab-ci.yml`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-12):匯出不帶 `max_threads`(netops_writer const);鎖延長失敗 90 秒或遺失就中止、改名前檢查;manifest `updated_at` 遞增;冷讀明列欄位;一輪最多 6 個檔、檔間讓出 5 秒;歸檔預約鍵 `netops:cold:archive-wanted`(資安 M1);剩餘空間 < 2 GB 不歸檔、單檔上限 `INGEST_ARCHIVE_MAX_MB`(資安 M2);來源列數只比對最近 7 天;改名後寫入失敗下一輪重做;保留天數不能少於原始表保留;關機中止不記 failed;正常時清掉舊錯誤;保留期限只刪一般檔案、不跟隨 symlink、單檔失敗不中斷,`.tmp` 以 `wx` 建立(資安 L2);錯誤訊息去掉路徑(資安 L5);setup 腳本檢查 uid 1000 與 symlink(資安 L6);0 列的日子整合測試。`netops_cold` 權限收斂(資安 L3)與讀檔時重算雜湊(L1)列為待需求方決定(手冊 §8.6)
- 驗證:`npm run typecheck`、`npm test`、`check-scenarios.mjs`;CI `check:ingest-int`(真 ClickHouse 匯出 / 讀回、冷熱明細一致)
## 2026-11-12 C5 PA 精準查詢
- 工作項目:C5(PA-LOG-CLICKHOUSE-GUIDE §9;D31、CQ6、CQ7;E4:15 分鐘、500 筆、60 秒、一次一個、管理平面 CPU > 50% 不送)
- 內容:① `pa-collector/netops_pa/pa_query.py`:查詢執行者(`PA_QUERY_ENABLED`,預設關閉)。從 Redis 取工作、確認名額、參數再驗、送出前取樣管理平面 CPU、XML API `type=log`(每 2 秒起逐次加到 5 秒輪詢,60 秒逾時送 `action=finish`)或 Session Browser(`show session all filter`)、結果寫回 Redis、釋放名額、設全域間隔。自寫最小 XML API 用戶端:API Key 放 `X-PAN-KEY` 標頭(pan-python 的 `log()` 逾時不取消 PA 上的工作)。只送唯讀請求(D22)。② `config.py` 加 `QueryConfig`(`PA_QUERY_MAX_MGMT_CPU` 上限 50,實測前不放寬);`keys.py` 加 `netops:paq:*`;`__main__.py` 啟動執行者、心跳 `queryEnabled`。③ `backend/src/infra/redis/pa-query.ts`(名額 SET NX、冷卻、建立工作失敗時歸還)、`modules/pa-query/`(送出 / 狀態 / 結果 API,429 帶 `Retry-After`)、`openapi.ts` 權限 `netops.pa-query.read`。④ `deploy/gateway-rbac.yaml` 按鈕 `netops.pa-live.query`(只加進 netops-admin);`docker-compose.yml` 傳 `PA_QUERY_ENABLED`、`PA_QUERY_MAX_MGMT_CPU`;`host2-set-pa-secrets.sh` 補 `PA_QUERY_ENABLED=0`
- 檔案:`pa-collector/netops_pa/{pa_query,config,keys,__main__}.py`、`pa-collector/tests/{test_pa_query,test_config}.py`、`backend/src/{app,openapi}.ts`、`backend/src/infra/redis/pa-query.ts`、`backend/src/modules/pa-query/`、`backend/test/{unit/pa-query.test.ts,helpers.ts}`、`deploy/{gateway-rbac.yaml,docker-compose.yml,host2-set-pa-secrets.sh}`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-12,沒有 Critical / High):執行者端:非預期錯誤也把工作標 failed(不卡在 queued / running)、參數壞掉標 invalid;全域 10 秒間隔在執行者也強制,且只在真的送過 PA 請求才設;開工時把名額續到 90 秒;CPU 擋下(rejected)時歸還使用者冷卻;IPv4-mapped IPv6 轉成 IPv4。XML API 用戶端:不跟隨 3xx 轉址(urllib 會把 X-PAN-KEY 帶到新網址)、`call()` 只接受 log(查詢 / get / finish)與 op、Session 指令以完整正規式比對、PA 錯誤原文只寫日誌(畫面只顯示分類與 code)、結果寫進 Redis 上限 2 MB(超過截斷標 truncated)。netops-api:工號格式不符回 403(原本被包成 424)。需人工:PA API Key 的 Admin Role 只開 XML API Log + Operational Requests、管理介面 Permitted IP 限 netops 主機(MR 列為需求方 / 網通確認事項)
- 驗證:pa-collector `ruff check`、`pytest`(本機 Python 3.14);backend `npm run typecheck`、`npm test`;`check-scenarios.mjs`;CI 見 MR

## 2026-11-12 V-b1 測試:儀表板並行上限測試不再卡住 CI
- 工作項目:V-b1(CI pipeline 901 job 2776 卡在 `test/unit/pa-insight.test.ts` 超過 10 分鐘,最後 Force cancel)
- 根因(本機重現):兩件事加在一起。① 「全系統同時 2 個」測試固定等 30ms 就送第 3 個請求;機器慢時第 3 個比前兩個先進到計算,也卡在測試的 gate 上,`await` 永遠不回來,`finally` 的 `close()` 不會執行。② 測試沒有逾時,而測試 app 的 JWKS server(127.0.0.1)只有 `close()` 會關;它一直 listen,`node --test` 就一直等。實測:一個請求永遠卡住時,舊 helper 有沒有加測試逾時都卡住;新 helper 加逾時 6 秒內失敗結束
- 修正:① 等兩個實際計算都進到 `insightFlows` 再送第 3 個(最多等 5 秒,計時器 `unref`),`finally` 先 `release()` 再 `close()`;這個測試逾時 20 秒。② `test/helpers.ts`:JWKS server `unref()`,`close()` 先關 JWKS(含 `closeAllConnections`)再關 app。③ `npm test` 加 `--test-timeout=60000`:任何測試卡住都會失敗,不會佔住 runner。沒有改門檻或跳過測試
- 檔案:`backend/test/unit/pa-insight.test.ts`、`backend/test/helpers.ts`、`backend/package.json`(test script)
- 驗證:`npx tsx --test test/unit/pa-insight.test.ts` 4 個同時跑 × 18 輪(72 次)都自己結束、沒有卡住;故意改壞斷言時回失敗並結束;`npm test` 全過

## 2026-11-12 V-b1 分析儀表板 API、畫面節點
- 工作項目:V-b1 第 1、2 步(VIZ-RULES-DESIGN §4.4、§4.8)
- 內容:① `GET /v1/pa/insight/traffic`(趨勢、桑基、Top 10 頻寬 IP、Top 10 App、Allow vs Deny)、`/v1/pa/insight/threat`(計分卡含前一期、時序、國家 ISO2、內網來源 RFC 1918、Top 10 威脅名稱;伺服器網段 V-c 前回 null + notes),最長 90 天,快取含今天 60 秒、其他 10 分鐘。② `infra/clickhouse/heat.ts` 加 6 個查詢(`pa_traffic_hourly_app` / `_src`、`pa_threat_logs` 的 log_type 排序鍵);`reader.ts` 加表常數 `hourlySrc`。③ `modules/pa-insight/countries.ts`:PA 國家英文全名 → ISO2(i18n-iso-countries 名稱 + PAN-OS 寫法,測試區實際值已比對)。④ `deploy/gateway-rbac.yaml`:選單 `netops.pa-heatmap.read`(sort 12)、`netops.pa-insight.read`(sort 15),includes `netops.pa.read`、`netops.pa-log.read`,加進 netops-admin、netops-viewer。⑤ 時段明細 429 另帶 `details.retryAfter`(前端讀不到回應標頭)
- 檔案:`backend/src/{app.ts,infra/clickhouse/{heat,reader}.ts,modules/pa-insight/,modules/pa-heat/service.ts}`、`backend/test/{unit/pa-insight.test.ts,unit/pa-heat.test.ts,integration/heat.int.test.ts}`、`deploy/gateway-rbac.yaml`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-12):前一期是否完整改用每天表的資料起點(原本用 5 分鐘表,短期間時 prev 常被誤判 null);Allow / Deny 用自己粒度的資料起點、allow 不為負;威脅名稱的嚴重度改取最高(`any()` 每次可能不同);儀表板實際計算全系統同時 2 個,超過 429 `NETOPS_INSIGHT_BUSY`(換日期繞過快取時保護 ClickHouse);日期來回驗證(`2026-02-31`)與 5 年下限;`gateway-rbac.yaml` 註明選單 includes `pa-log.read` 的實際範圍。未改:查詢不隨使用者斷線中止(每支查詢有 20–30 秒上限)
- 驗證:`npm run typecheck`、`npm test`(302 通過)、`check-scenarios.mjs`(119 / 119);CI `check:ingest-int` 見 MR

## 2026-11-11 C3:PA 查詢只用 ClickHouse、對帳 01:00
- 工作項目:C3(ARCHITECTURE D43,需求方 2026-11-11 晚上決定)
- 內容:① 總覽、篩選選項、有資料的日期、安全事件(威脅類)、Log 明細只查 ClickHouse;`source` 只接受 clickhouse;`NETOPS_PA_OVERVIEW_SOURCE`、`NETOPS_PA_DETAIL_SOURCE` 移除;test / prod 必須設定 `CLICKHOUSE_URL`。② 期間整個超過保留期限回 404 `NETOPS_PA_OUT_OF_RETENTION`;回應加 `coverage`、`partial`、`topsState`(摘要還沒建好時排行標不完整,筆數照回)。③ `/pa/days`、`/pa-events/types` 改列 ClickHouse 有資料的日期(新增 `trafficDays`、`threatDays`)。④ 明細移除 FTP 掃描路徑。⑤ 每日對帳 `NETOPS_RECON_HOUR` 預設 1,FTP 檔沒分析完時自己同步(30 分鐘最多一次)並每 10 分鐘再試;FTP 完整的判斷改回「有檔涵蓋到 23:50 以後或隔天有檔」(PA 前一天的檔約 07:45 才出現,隔天的檔要再等一天)。⑥ 每小時摘要:每段 2 萬列、每段最多等 180 秒(測試區 15 時一直逾時);失敗日誌記本程式組的原因文字。
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-11):有資料的日期在程序內記 2 分鐘、威脅類一次查全部類型、日期以 `Asia/Taipei` 切;`/pa-events/types` 在 ClickHouse 失敗時只標 ClickHouse 類型 `unavailable`,保留 `dir`;`/pa/options` 也檢查保留期限;`partial` 以最早一小時判斷;`topsState` 不是 ok 的結果不快取;摘要日誌的 `reason` 只記本程式組的訊息;自動對帳防重入、單日失敗不中斷其他日、pending 超過 120 次停止自動重試;新增自動對帳測試。
- 檔案:`backend/src/{config.ts,app.ts,infra/clickhouse/reader.ts,infra/redis/cache.ts,modules/pa/{ch-overview,ch-summary,routes,log-routes,reconcile}.ts,modules/pa-events/routes.ts}`、`backend/test/`、`deploy/docker-compose.yml`
- 驗證:`npm run typecheck`、`npm test`

## 2026-11-11 V-a 熱力圖資料層:彙總表、熱力圖與時段明細 API
- 工作項目:V-a(第 1–4、6 步;第 5 步冷路由等 C4)(ARCHITECTURE D34、D35;VIZ-RULES-DESIGN §3、§4.2、§4.3)
- 內容:① `deploy/clickhouse/schema.sql`:`pa_heat_5m` / `_1h` / `_1d`(AggregatingMergeTree,總數 + topK Top IP)與 6 個物化檢視(TRAFFIC、威脅 × 3 粒度;威脅只算 `log_type = threat` 筆數);`apply-schema.sh` 加 `{{TTL_HEAT_*}}`(正式區 1 年 / 5 年 / 5 年,測試區 3 天)與 `YEAR` 單位。② `migrations/003`:`pa_traffic_hourly_src` 加 `bytes_sent`、`bytes_recv` 並 `MODIFY QUERY`(新安裝的 `schema.sql` 直接含)。③ `rebuild-day.sh`:重建一天的全部彙總(上線回填、補漏後);`dedupe-day.sh` 改呼叫它並比對熱力圖。④ `infra/clickhouse/heat.ts`(熱力圖、時段明細查詢;`reader.ts` 只把欄位對照與 `paramText` 等改成 export)、`infra/redis/cold-lock.ts`(冷查詢鎖,C4 接上)、`infra/redis/cache.ts` 加 `longTtl`(上限 1 小時,預設仍 60 秒)、`config.ts` 加 `paTtlDays`(`NETOPS_TTL_TRAFFIC_DAYS` / `_THREAT_DAYS`,預設依部署區)。⑤ `modules/pa-heat/`:`GET /v1/pa/heatmap`、`GET /v1/pa/slice`、`GET|DELETE /v1/pa/slices/{id}`
- 檔案:`deploy/clickhouse/{schema.sql,apply-schema.sh,dedupe-day.sh,rebuild-day.sh,migrations/003-va-hourly-src-sent-recv.sql}`、`backend/src/{app,config}.ts`、`backend/src/infra/{clickhouse/heat.ts,clickhouse/reader.ts,redis/cold-lock.ts,redis/cache.ts}`、`backend/src/modules/pa-heat/`、`backend/test/{unit/pa-heat.test.ts,integration/heat.int.test.ts,helpers.ts}`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-11):TRAFFIC 物化檢視的輸出別名遮蔽來源欄位(`sum(bytes) AS bytes` + `topKWeightedState(src, bytes)`,26.3 ILLEGAL_AGGREGATION,CI 整合測試抓到)→ 來源欄位一律用表別名 `l.`;冷查詢改成獨立佇列(全系統 1 個、不排隊、執行上限 110 秒 < 鎖 TTL 120 秒),鎖值加亂數;同條件併發請求先登記再取鎖(重用同一個工作,不回 429);同步等待改為輪詢狀態(排隊中被取消也立即結束);時段明細的 8 支查詢改依序執行、熱查詢同時 2 個(避免佔滿 ClickHouse `max_concurrent_queries` 影響寫入);時間對齊到分鐘(快取鍵);長 TTL 只給結束超過 1 小時的期間;`rebuild-day.sh` 日期改整數比較並註明執行期間不要補漏、失敗要重跑;`dedupe-day.sh` 原始表沒資料時不比熱力圖。未改(列為已知限制,寫進 MR):取消熱查詢不中止已送出的 ClickHouse 查詢(結果是共用快取);全系統 6 個工作滿時回 409(沿用 `JobRunner`);`netops_reader` 的 `max_concurrent_queries_for_user` 建議另案調整(會影響 C3)
- 另修(既有測試,不是 V-a 造成):`test/integration/ingest.int.test.ts`(C2)的測試資料寫死 2026-11-09 / 11-10,測試區 TTL 3 天,2026-11-12 起寫入後立即被 TTL 刪掉(CI `0 !== 2`);改成台灣時間的昨天,斷言不變
- 驗證:`npm run typecheck`、`npm test`(294 通過)、`check-scenarios.mjs`(116 / 116);CI `check:ingest-int`(真 ClickHouse 26.3)見 MR

## 2026-11-11 C3 第 3 批:FTP 每日對帳與補漏
- 工作項目:C3(ARCHITECTURE D33;手冊 §11.2、§11.3、§12 CQ10)
- 內容:① `modules/pa/reconcile.ts`:每小時比 FTP 摘要筆數(已分析的 FTP 檔,不另外讀 FTP)與 ClickHouse 每小時彙總,> 0.5% 為缺口;FTP 還沒涵蓋到隔天或分析中為 pending;每天 `NETOPS_RECON_HOUR`(預設 6)對帳前 3 天,結果存 `palogs/ch/recon/`(不新增 ClickHouse 表)。② `recon-routes.ts`:`GET/POST /v1/pa/reconciliations`、`POST /v1/pa/backfills`、`GET /v1/pa/backfills/{id}`(`netops.ftp.read` / `netops.ftp.write`,沿用既有權限代碼)。③ `infra/redis/backfill.ts`:補漏佇列 `netops:backfill:*`(7 天 TTL)。④ `ingest/backfill.ts`:`netops-ingest` 逐小時查已有的 seqno(`trafficSeqnos`)、從 FTP 逐列讀 CSV,只補寫缺的列(`source = 'ftp'`,先序列化成 JSON 字串省記憶體,`insertJson`);不刪除既有資料。⑤ Compose:`netops-ingest` 加 FTP 設定、`ftp_password`、只連外的 `ingest-egress` 網路。
- 檔案:`backend/src/{config.ts,app.ts,infra/clickhouse/index.ts,infra/redis/backfill.ts,infra/store/pa.ts,ingest/{backfill,config,main}.ts,modules/pa/{reconcile,recon-routes}.ts}`、`backend/test/{unit/ch-recon.test.ts,fixtures/fake-ingest.ts,helpers.ts}`、`deploy/docker-compose.yml`、`docs/Gherkin/{check-scenarios.mjs,ftp/pa-recon.feature}`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-11):沒有涵蓋的 FTP 檔、FTP 檔沒有 Sequence Number 欄位、整小時都沒有 seqno 時工作標失敗(不標完成);建立工作時找不到 FTP 檔回 409;`netops:backfill:running` 記執行中工作,`netops-ingest` 重啟時標失敗;停止時讀檔中斷;進度更新失敗不影響寫入;佇列讀取失敗限頻記錄;小時以時間值判斷;ClickHouse 開始的那一小時不對帳;FTP 完整改成隔天也有已分析的檔;`netops-ingest` 執行前再驗工作內容(Redis 沒有 ACL:小時、日期、31 天內、檔案在 `FTP_LOG_DIR` 之下且符合 `FTP_PATTERN`、數量上限);一個檔最多 70,000 列待補;seqno 用和即時寫入相同的檢查。未處理(寫在 MR):`ingest-egress` 只放行 FTP 主機要在主機防火牆設定;工作內容 HMAC 簽章;`readLog` 單行長度上限(核心逐字沿用舊版)。
- 驗證:`npm run typecheck`、`npm test`(274 通過)

## 2026-11-11 C3 第 2 批:Log 明細改查 ClickHouse(可切換)
- 工作項目:C3(ARCHITECTURE D6、D29;手冊 §7.4、§12 CQ10)
- 內容:`infra/clickhouse/reader.ts` 加 `trafficWhere`(明細條件 → SQL,值一律放參數:IP 完全相同 `toIPv6OrNull`、CIDR 換成 `IPv6CIDRToRange` 的 BETWEEN、萬用字元換 LIKE 並跳脫,不用正規表示式)、`searchTraffic`(依時間由舊到新取 limit+1 筆判斷 `limit`,執行上限 50 秒,工作取消時 `cancel_http_readonly_queries_on_client_close` 讓 ClickHouse 停止查詢)、`trafficCount`。`modules/pa/log-routes.ts`:`source`(設定 `NETOPS_PA_DETAIL_SOURCE`,預設 ftp,並行對帳 2 週後改 auto);ClickHouse 明細另一個工作佇列(同時 2 個,不佔 FTP 連線),結果格式、分頁、匯出、取消與 FTP 相同,`result.source` 標實際來源;期間最長 30 天。
- 檔案:`backend/src/{infra/clickhouse/reader.ts,modules/pa/log-routes.ts,app.ts}`、`backend/test/{unit/ch-detail.test.ts,unit/logs.test.ts,integration/reader.int.test.ts,fixtures/fake-ch.ts}`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-11):auto 時 ClickHouse 沒有資料改走 FTP(不回 404);明細查詢的用戶端等待改為伺服器上限 + 10 秒(逾時由 ClickHouse 回 159,訊息提示縮小範圍);ClickHouse 明細每人同時 1 個、全部保留 30 份結果;只用 `q` 沒有其他條件時 ClickHouse 期間最長 1 天;IPv6 改用 `node:net` 驗證,不合法的不送進 `toIPv6`。未處理(寫在 MR):`netops_reader` 加 `max_rows_to_read`(要改 users.d)、取消時 `KILL QUERY`(唯讀帳號不能)。
- 驗證:`npm run typecheck`、`npm test`(263 通過);主機 2 測試區 ClickHouse 唯讀執行 7 種條件的明細 SQL(完全相同、CIDR、萬用字元、Port + block、文字條件、不合法 IP、IPv6 CIDR),一天範圍(約 177 萬筆)每次伺服器端不到 1 秒

## 2026-11-11 C3 第 1 批:總覽、安全事件、篩選選項改查 ClickHouse
- 工作項目:C3(ARCHITECTURE D29、D32、D42;手冊 §7.4、§10.2、§12 CQ10、CQ11)
- 內容:① `infra/clickhouse/reader.ts`:`netops-api` 用唯讀帳號 `netops_reader`,表名只用常數、條件一律 `param_*`、`max_execution_time` ≤ 50;原始 log 依每分鐘筆數切段(每段 ≤ 80,000 筆,不超過帳號的 `max_result_rows` 100,000),逐行串流,HTTP 200 後中途的錯誤也會丟出。② `modules/pa/ch-summary.ts`:彙總表只涵蓋 App、區域、來源 IP,掃原始表算 27 種排行一天約 9 秒(主機 2 實測),改由背景每 5 分鐘把已結束的小時讀出、用和 FTP 相同的核心算每小時摘要,存 `palogs/ch/`;筆數變了重建、超過 `NETOPS_CH_SUMMARY_DAYS` 清除(ARCHITECTURE D42,不新增 ClickHouse 表)。③ `modules/pa/ch-overview.ts`:`source`(ftp / clickhouse / auto,設定 `NETOPS_PA_OVERVIEW_SOURCE` 預設 auto);筆數、每小時統計、動作查每小時彙總,排行查每小時摘要(只到 `topsUntil`);auto 時 ClickHouse 失敗改用 FTP,指定 clickhouse 回 503 `NETOPS_CLICKHOUSE_UNAVAILABLE`。④ `infra/redis/cache.ts`:`netops:cache:*` 60 秒(CQ11)。⑤ Compose:netops-api 加 `netops-ch` 網路、`ch_reader_password`、`CLICKHOUSE_*`、`NETOPS_PA_*_SOURCE`、`NETOPS_CH_SUMMARY_*`;CI 部署檢查 `ch_reader_password`、整合測試加 `INT_CLICKHOUSE_READER_PASSWORD_FILE`。
- 檔案:`backend/src/{config.ts,app.ts,shared/time.ts,infra/clickhouse/{index,reader}.ts,infra/redis/cache.ts,infra/store/pa.ts,modules/pa/{ch-summary,ch-overview,routes}.ts,modules/pa-events/routes.ts}`、`backend/test/{unit/ch-overview.test.ts,integration/reader.int.test.ts,fixtures/fake-ch.ts,helpers.ts}`、`deploy/docker-compose.yml`、`.gitlab-ci.yml`
- 審查修正(`code-reviewer`、`security-auditor` 2026-11-11):摘要還沒建好或太久沒成功(ClickHouse 停止)時不回空結果,auto 改用 FTP、指定 clickhouse 回 503;單一小時建失敗不中斷整輪(30 分鐘後重試),單一分鐘超過 80,000 筆改看每秒切段;讀到的筆數比分段時少就丟錯(截斷不當成完整);沒有回應內容丟錯;每小時最多算一次 missing;摘要讀檔每 24 份讓出事件迴圈、串流每塊讓出;快取鍵不含 top(一律算前 100 名再截)且同鍵同時只算一次;停機時小查詢也帶中止訊號;日誌與狀態只留 ClickHouse 錯誤代碼,不留原文;類型整個查不到資料時不清光摘要。未處理(寫在 MR):Redis 快取可被同網路的 netops-pa 改寫(Redis ACL 需求方 2026-11-11 決定不做)、`netops_reader` 授權縮到三張表(要改帳號腳本並由需求方重跑)。
- 驗證:`npm run typecheck`、`npm test`;主機 2 測試區 ClickHouse 以 `clickhouse-client` 唯讀執行產生的 SQL;一小時真實資料(399,461 筆)的摘要筆數與每小時彙總相同;整合測試見 CI `check:ingest-int`

## 2026-11-11 C2:netops-ingest 審查修正
- 工作項目:C2(`code-reviewer`、`security-auditor` 2026-11-10 審查;需求方 2026-11-11 同意繼續)
- 內容:① 結構性錯誤(欄位或表不存在、JSONEachRow「Unknown field」的 117、帳密權限)改當暫時性:不拆批、不 ACK、退避重試;資料錯誤拆批時前 3 個單列都被拒、沒有任何子批成功就熔斷成結構性錯誤(不會把整批拆光丟掉,也不會打出上萬次請求);心跳 `state` 新增 `clickhouse-schema-error`。② 無法分類的 HTTP 400 整批連續失敗 5 次後才拆批(資安 M2)。③ 單筆超過 64 KB 計 malformed、一輪讀取超過 16 MB 提早寫入、`INGEST_BATCH_MAX` 上限 5000、`NODE_OPTIONS=--max-old-space-size=160`(資安 M1)。④ 缺口判斷扣掉已回報的基準(`netops:ingest:gapbase`;Redis 不會把被修剪跳過的筆數補進 `entries-read`,發生過缺口後差值一直存在、之後誤報;`max-deleted-entry-id` 只記 XDEL、XTRIM 不更新,CI 實測不能用),缺口分 `pending-trimmed` / `undelivered-trimmed`;正在寫入的那批被修剪不算缺口;心跳上的缺口在恢復後清掉。⑤ 主迴圈退避在有進度後歸零。⑥ 子批 token 帶筆數。⑦ 錯誤訊息去掉控制字元(含 C1)再寫心跳;`verify-ingest.sh` 輸出前過濾控制字元(資安 L2)。⑧ fetch `redirect: 'error'`(資安 L4)。⑨ `dedupe-day.sh`:日期與容器名稱以 `case` 檢查整個字串(資安 L1);彙總和原始表筆數不同就重建(中途失敗重跑也會補)。⑩ ClickHouse 26.x 的 HTTP 寫入預設走 async insert,去重 token 不生效(CI 整合測試:同一 token 重送寫了兩次),寫入改帶 `async_insert=0`;26.3 來源表略過重送的區塊時仍會推給物化檢視(彙總重複),寫入另帶 `deduplicate_blocks_in_dependent_materialized_views=1`,`migrations/002-c2-hourly-dedup.sql` 給兩張彙總表開去重視窗,`dedupe-day.sh` 重建彙總改帶 `insert_deduplicate = 0`。⑪ CI:`check:ingest-int` 的 npm Token 只給 `npm ci`、一次性容器放專用網路、暫存檔移到 checkout 外、輸出另存主機 2 `/tmp/netops-int-<job>.log`(保留 3 天,AI 沒有 Job 讀取權限時以 ssh 唯讀查看);`deploy-api-test` 的心跳檢查要求 `startedAt` 晚於這次部署(同一 commit 重跑不會放行舊心跳),`redis-cli` 失敗時重試(資安 L5、審查 #7、#8)。Redis ACL(資安 M3)與 `netops_writer` 縮成只有 INSERT(L3)待需求方決定。
- 檔案:`backend/src/{infra/clickhouse/index.ts,infra/redis/ingest.ts,ingest/*.ts}`、`backend/test/{unit/ingest.test.ts,integration/ingest.int.test.ts,fixtures/fake-ingest.ts}`、`deploy/{docker-compose.yml,clickhouse/dedupe-day.sh,clickhouse/verify-ingest.sh}`、`.gitlab-ci.yml`
- 驗證:`npm run typecheck`、`npm test`(234 通過,其中 ingest 40);整合測試見 CI `check:ingest-int`

## 2026-11-10 C2:寫入管線 netops-ingest
- 工作項目:C2(ARCHITECTURE D28;手冊 §6、§10;C1 報告 §9 的建議)
- 內容:新服務 `netops-ingest`(netops-api 同映像,進入點 `dist/src/ingest/main.js`):consumer group `ch-writer` 讀 traffic、threat、url、data、wildfire 五個 Stream,每 5 秒(`INGEST_BATCH_SECONDS` 3–5)或任一類型滿 5,000 筆批次寫 ClickHouse(`netops_writer`),成功才 `XACK`;重啟先把待處理清單單獨成批補寫,去重 token(類型 + 第一、最後 ID + 筆數)與當機前相同,ClickHouse 略過已寫過的批次(物化檢視也不重算);ClickHouse 暫時性錯誤不 ACK、退避 1–60 秒重試,資料錯誤對半拆批只丟壞列;壞 JSON、已修剪的待處理條目計數後 ACK;不過濾雜訊(CQ8)。缺口偵測(啟動與每 10 秒):待處理已被修剪、或還沒讀就被修剪(`entries-added − entries-read − length` > 0)時寫 `netops:ingest:gaps`。心跳 `netops:ingest:heartbeat`。`infra/clickhouse/`(HTTP 介面 + fetch,不加套件)、`infra/redis/ingest.ts`。DDL:`migrations/001-c2-threat-columns.sql`(`pa_threat_logs` 加 `session_id`、`sport`、`nat_dport`),`apply-schema.sh` 每次依序執行 migrations(可重複執行)。Compose:`netops-ingest`(256m、唯讀根目錄、`cap_drop: ALL`、healthcheck 看 `/tmp/netops-ingest.alive`、secret `ch_writer_password`);ClickHouse 改放獨立 internal 網路 `netops-ch`(C1 資安審查 L3)。CI:`check:ingest-int`(一次性 Redis + ClickHouse 整合測試、`dedupe-day.sh` 測試)、`deploy-api-test` 起 `netops-ingest` 並確認心跳是這一版且 `ok`。驗收工具 `deploy/clickhouse/verify-ingest.sh`(只讀)、重複修正 `deploy/clickhouse/dedupe-day.sh`。
- 檔案:`backend/src/ingest/**`、`backend/src/infra/{clickhouse/index.ts,redis/ingest.ts}`、`backend/test/{unit/ingest.test.ts,integration/ingest.int.test.ts,fixtures/fake-ingest.ts}`、`backend/package.json`(`test:int`)、`deploy/docker-compose.yml`、`deploy/clickhouse/{apply-schema.sh,schema.sql,migrations/,verify-ingest.sh,dedupe-day.sh}`、`.gitlab-ci.yml`、`docs/{IMPL-PLAN,PA-LIVE-PLAN,PA-LOG-CLICKHOUSE-GUIDE,PROJECT-MAP,HANDOFF}.md`
- 驗證:見 MR(typecheck、單元測試、CI 整合測試)

## 2026-11-10 C2:收集器保留 seqno、sessionId
- 工作項目:C2(CQ9 核准;E3 網通已在 PA-560 的 Syslog 與 HTTP Payload 加 `"seqno":"$seqno","sessionId":"$sessionid"`)
- 內容:`records.py` 的 `TRAFFIC_FIELDS`、`THREAT_FIELDS`(threat、url、data、wildfire 共用)加 `seqno`、`sessionId`(AGENT §7.2「不新增欄位」的例外,註解寫明)。`seqno` 是 64 位元(實測 19 位數)超過 JavaScript 安全整數,存成去掉前導 0 的數字字串(≤ 2^64-1,不合法就不寫這個 key);`sessionId` 加進 `NUMERIC`。decryption、globalprotect、userid 不收。**改了 `pa-collector/`,合併後 CI 會重建 `netops-pa`,TRAFFIC Syslog 會斷線,要請網通對 `netops-syslog` 再 Commit**。
- 檔案:`pa-collector/netops_pa/records.py`、`pa-collector/tests/test_store.py`、`docs/PA-LIVE-PLAN.md`
- 驗證:`ruff check`、`pytest`(84 通過)

## 2026-11-10 CI:netops-pa 沒有變更時部署不重建
- 工作項目:R1(需求方 2026-11-10 同意;pipeline 783 只改文件也在 13:45 重建 `netops-pa`,PA-560 Syslog TRAFFIC 斷線且不會自動重連)
- 內容:`deploy-api-test` 原本每次 `build` + `up --force-recreate netops-pa`,映像標籤是 commit 短 SHA,每次都重建。新增 `deploy/ci-netops-pa.sh` 判斷:正在執行的 `netops-pa` healthy、映像標籤的 commit 到 HEAD 之間 `pa-collector/` 沒變、用原標籤算的 `docker compose config --hash netops-pa` 等於容器的 `com.docker.compose.config-hash`(Compose 的 `netops-pa` 段與 `netops.env` 沒變),容器用的映像就是標籤現在指的映像,而且沒設 `NETOPS_PA_RECREATE=1` 時就 keep;判斷出錯一律重建;`netops-redis` 被重建時 `netops-pa` 也重建:不 build、不 up,沿用原容器;否則照舊先建置、再 `--force-recreate`,日誌印 `WARN netops-pa 已重建,TRAFFIC Syslog 可能需要網通重新 Commit netops-syslog`。`deploy-api-test` 改完整 clone(`GIT_DEPTH: "0"`),淺層 clone 找不到原 commit 時一律重建。其他服務與冒煙測試不變。HANDOFF、PA-FORWARDING-SPEC F.3、`host2-set-pa-secrets.sh` 的提示補「只有 netops-pa 重建時才需要重新 Commit」與 `NETOPS_PA_RECREATE=1`。
- 檔案:`deploy/ci-netops-pa.sh`、`.gitlab-ci.yml`、`deploy/host2-set-pa-secrets.sh`、`docs/{HANDOFF,PA-FORWARDING-SPEC}.md`
- 驗證:主機 2 dry run(只跑 ps / inspect / config / git,沒有 build、up):`config --hash` 與執行中容器的標籤一致;只改文件 → keep、只改 backend → keep、改 pa-collector → rebuild、`PA_POLL_SECONDS` 改 → rebuild、compose 的 netops-pa 段改 → rebuild、`NETOPS_PA_RECREATE=1` → rebuild、淺層 clone → rebuild;測試區 `netops-pa` 沒有被重啟(StartedAt 不變)

## 2026-11-10 C1:測試區新增 netops-clickhouse 與 POC 實測工具
- 工作項目:C1(需求方 2026-11-10 同意 E6)
- 內容:Compose 新增 `netops-clickhouse`(`clickhouse/clickhouse-server:26.3.62.3`;`mem_limit` / `memswap_limit` 1536m、`cpus` 2、uid 101、`cap_drop: ALL`、唯讀根目錄、只在 `netops-internal`、不開 port、healthcheck `/ping`;帳號檔以 `create_host_path: false` 掛載,不存在就啟動失敗)。`deploy/clickhouse/`:`config.d/low-memory.xml`(伺服器記憶體 = 容器 × 0.75、快取調小、背景池 4 與對應的 `merge_tree` 門檻、只留 `query_log` / `part_log` 3 天、log 只輸出 stdout)、`users.d/default.xml`(default 只限 127.0.0.1 / ::1)、`users.d/profiles.xml`(default / writer / reader / cold 設定檔,reader、cold 以 constraints 固定上限)、`schema.sql`(手冊 §7 DDL,`dst` 加 bloom_filter)、`apply-schema.sh`(依部署區代入 TTL,已存在的表 `MODIFY TTL`)。`deploy/host2-set-clickhouse-secrets.sh`:三個帳號的隨機密碼與帳號檔(只含 SHA-256 雜湊),使用者執行。CI `deploy-api-test`:檢查帳號檔、`up -d --wait netops-clickhouse`、`apply-schema.sh test`、確認伺服器記憶體上限。POC 工具 `deploy/clickhouse/poc/`(FTP 唯讀串流匯入一天、容量與查詢實測)。
- 檔案:`deploy/docker-compose.yml`、`deploy/clickhouse/**`、`deploy/host2-set-clickhouse-secrets.sh`、`.gitlab-ci.yml`
- 驗證:主機 2 臨時 POC 容器實測(報告 `docs/test-reports/2026-11-10-clickhouse-c1.md`);以臨時 project `GW_ENV=c1dry` 照 CI 指令跑 `up --wait`、`apply-schema.sh`、記憶體檢查、reader 登入,缺帳號檔時 `up` 失敗;`apply-schema.sh prod` / `test` 來回切 TTL。完成後刪除 POC 容器、volume 與一次性密碼

## 2026-11-10 R1:提高 TRAFFIC 即時 log 串流上限
- 工作項目:R1(需求方 2026-11-10 驗收後決定「可以提高上限」;實測 5 分鐘 SSE:Redis 42,005 筆、頁面收 31,960 筆,`dropped` 9,300、`skipped` 2 次)
- 內容:`live-routes.ts`:檢查間隔 2 秒 → 1 秒;`READ_PER_TICK` 500 → 1500;`SEND_PER_TICK` 200 → 1500(與讀取上限相同,正常不再捨棄);新增 `SEND_CHUNK` 200(大批分成多個 `logs` 事件,只有最後一個帶游標,斷線重連不漏、由瀏覽器依 id 去重);`MAX_PENDING_BYTES` 256 KB → 2 MB(單 tick 最壞約 1.5 MB,舊值會在尖峰誤殺連線)。每人 3 條、全系統 20 條、最長 5 分鐘、心跳 15 秒不變。新增單元測試(1200 筆批次全收、無重複、分段只有最後一段帶 id、Last-Event-ID 重連不重複;超過讀取上限標 `skipped`)。Gherkin 來源行號、`docs/API.md` §3.2、`PA-LIVE-PLAN.md` §8 同步。
- 檔案:`backend/src/modules/pa-live/live-routes.ts`、`backend/test/unit/pa-live-r1.test.ts`、`docs/Gherkin/pa-live/realtime.feature`、`docs/{API,PA-LIVE-PLAN}.md`
- 驗證:`npm run typecheck`、`npm test`(194 通過)、`npm run build`;`check-scenarios.mjs` 90 / 90

## 2026-11-10 R1:威脅類 log 帶出來源 Port
- 工作項目:R1(需求方 2026-11-10 驗收後決定補;驗收報告 `docs/test-reports/2026-11-10-pa-live-uat.md` §3.6、§7-3)
- 內容:PA Monitor 威脅詳細檢視有 Source Port、NAT Port,NetOps 沒有:規格 B.3 的 payload 漏了 `sport`、`natDport`,收集器 `THREAT_FIELDS` 也沒有,PA 就算送了也會被丟掉。`THREAT_FIELDS`(threat、url、data、wildfire 共用)加入 `sport`、`natDport`(`NUMERIC` 已含,非數字變 0)。`netops-api` 的 `toLogItem` 直接帶出所有欄位,不需修改;`matchLog` 的 Port 篩選本來就比對 `dport` 與 `sport`,補單元測試。規格 B.3、PA-LIVE-PLAN、API.md 同步。**需求方要在 PA 的 HTTP Payload Format 手動加 `"sport":"$sport","natDport":"$natdport"`(只加變數)並 Commit,部署後才有值**。不改 TRAFFIC 欄位與 `SEND_PER_TICK`。
- 檔案:`pa-collector/netops_pa/records.py`、`pa-collector/tests/test_store.py`、`backend/test/unit/pa-live-r1.test.ts`、`docs/{PA-FORWARDING-SPEC,PA-LIVE-PLAN,API}.md`
- 驗證:`ruff check`、`pytest`(82 通過);backend `typecheck`、`npm test`(192 通過)、`build`

## 2026-11-10 R1:即時監控串流每人上限 2 → 3
- 工作項目:R1(需求方 2026-11-10 決定「提高到每人 3 條」;驗收報告 `docs/test-reports/2026-11-10-pa-live-uat.md` §3.1 項目 4、§4.4-2)
- 內容:`GET /v1/pa-live/stream` 每人(工號)同時串流上限由 2 改為 3(`LIVE_MAX_PER_USER`),同一人多個分頁或多台裝置不再互相擠掉;全系統上限 20 不變。串流驗證(`stream-test`,§3.1)每人 2 條、AI 串流每人 2 個 / 全系統 6 個都不變。OpenAPI 說明與 `x-gherkin`、`docs/API.md` §3.2 與錯誤代碼表、Gherkin 同步;`x-gherkin` 來源行號依新位置更新。
- 檔案:`backend/src/modules/pa-live/live-routes.ts`、`backend/test/unit/pa-live-r1.test.ts`、`docs/API.md`、`docs/Gherkin/pa-live/realtime.feature`
- 驗證:`npm run typecheck`、`npm test`(192 通過;測試改用預設值,3 條成功、第 4 條 429)、`npm run build`;`check-scenarios.mjs` 90 / 90

## 2026-11-09 R1:測試區收集器開關、CI 冒煙測試不再產生 401
- 工作項目:R1(需求方 2026-11-09 決定「在測試區我想要有按鈕可以停用或開啟」;驗收報告 `docs/test-reports/2026-11-09-a1-r1-uat.md` §4.5;ARCHITECTURE D26)
- 內容:① `infra/redis` 新增 `collectorControl()`、`setCollectorControl()`(鍵 `netops:pa:control`,PA-LIVE-PLAN §4;`netops-api` 對 Redis 唯一的寫入)。② `PUT /v1/pa-live/collector-control`(`netops.pa-realtime.write`、`x-audit-level: body`;內容 `pollPaused` / `receivePaused` 至少一個;記錄「姓名(工號)」與時間,日誌記工號與要求);正式區(`GW_ENV=prod`)回 403 `NETOPS_PA_CONTROL_DISABLED`、`snapshot` 不讀控制鍵。③ `snapshot` 回 `control`;收集器狀態加 `poll.paused`、`receive.paused`、`counters.paused` 與 `state: paused`(有開的部分都暫停),暫停中的舊輪詢錯誤不算 `degraded`。④ `netops-pa`:`control.py` 每次輪詢前讀(暫停時不查 PA-560、清掉介面計數與舊錯誤)、每 5 秒(心跳)讀一次接收狀態(暫停時丟棄並計數 `paused`,HTTP 仍回 200);讀取失敗沿用上一次;正式區不讀;心跳加 `pollPaused`、`receivePaused`。⑤ `gateway-rbac.yaml` 新增按鈕 `netops.pa-live.manage`(→ `netops.pa-realtime.write`),只放進 `netops-admin`。⑥ CI `deploy-api-test` 的冒煙測試原本不帶 Token 打 `/v1/ping` 確認 401,每次部署都在 giga-observe 留一筆 401(驗收 §4.5 的來源);改打 `/healthz`(監控忽略),401 由單元測試涵蓋。
- 檔案:`backend/src/{infra/redis/index.ts,modules/pa-live/{live-routes,service}.ts,openapi.ts,app.ts}`、`backend/test/{unit/pa-live-r1.test.ts,fixtures/fake-redis.ts,helpers.ts}`、`pa-collector/netops_pa/{control,keys,store,status,pipeline,poller,__main__}.py`、`pa-collector/tests/test_control.py`、`deploy/gateway-rbac.yaml`、`.gitlab-ci.yml`
- 驗證:見 MR 描述(backend typecheck / test / build、pytest、check-scenarios)

## 2026-11-09 A1-api:名額測試在 CI 不穩
- 工作項目:A1(`feature/a1-ai-api`)
- 內容:!35 的 pipeline 723(38c1937)`check:backend` 失敗,同一份後端程式在 !36 的 pipeline 724 通過(兩條 pipeline 同時在主機 2 跑)。三支名額測試(每人上限、全系統上限、分析的每人 2 個)固定等 100 毫秒就送第三個請求,假設前兩個已經佔住名額;主機忙時 Token 驗證較慢,前兩個還沒佔到名額,第三個就回 200 而不是 429。改成等前兩個請求真的到了假模型(名額已佔用)才送第三個:生命週期測試的假模型改成閘門(確認 429 後才放行),分析的測試改看假 AI 主機收到的請求數、模型延遲拉長到 2 秒。程式不變。
- 檔案:`backend/test/unit/ai.test.ts`
- 驗證:`npm test`(163 項通過;`ai.test.ts` 連跑 3 次、兩份完整測試同時跑都通過)

## 2026-11-09 A1-api:移除翻譯與整理筆記 API(決定不搬)
- 工作項目:A1(`feature/a1-ai-api`;需求方 2026-11-09 依 `docs/AI-FEATURE-INVENTORY.md` 決定翻譯(#5)與整理筆記(#6)不搬,ARCHITECTURE D25)
- 內容:拿掉 `POST /v1/ai/notes`(整理筆記,原本直接寫知識庫)與 `POST /v1/ai/translations`(翻譯)兩支路由與服務(`note`、`translate`、`checkTranslate`、記錄人檢查、分段上限常數);先合併 `fix/a1-core-trim`(核心拿掉 `translate.js`、`NOTE_PROMPT`、`parseJsonReply`)。權限不變:`netops.ai.use` 仍給分析與問答;`netops.kb.write` 仍給知識庫編輯、立即同步與外部 IP 學習;`gateway-rbac.yaml` 沒有只為這兩支 API 存在的節點,不需修改。測試:名額、全系統上限、用戶端斷線改用 AD 問答測(不需要 PA 資料),斷線測試改成確認同一人可以再問並完成(原本只驗 400,沒有真的證明名額歸還);新增「沒有這兩支 API(404)」。
- 合併衝突:`feature/a1-ai-api` 合併 `fix/a1-core-trim` 時,本檔(修正紀錄)檔頭兩邊都新增紀錄而衝突;依工作區 AGENT §9.4 三筆都保留、依日期排序,由主討論串核准(2026-11-09)。程式檔沒有衝突。
- 檔案:`backend/src/modules/ai/{service,routes,sse}.ts`、`backend/src/{app,openapi}.ts`、`backend/test/{unit/ai.test.ts,fixtures/fake-ai.ts}`、`docs/API.md` §2、§9、§10、`docs/Gherkin/{ai/ai.feature,README.md}`
- 驗證:`npm run typecheck`、`npm test`(163 項通過;移除前 165 項:拿掉整理筆記、翻譯、翻譯驗證 3 項與核心的翻譯比對 1 項,新增「沒有這兩支 API」與核心的 `chatOnce` 比對各 1 項)、`npm run build`、`check-scenarios.mjs`(x-gherkin 70 個場景全部對應,0 個問題)

## 2026-11-09 A1-core:移除翻譯與整理筆記的核心(決定不搬)
- 工作項目:A1(`fix/a1-core-trim`;需求方 2026-11-09 依 `docs/AI-FEATURE-INVENTORY.md` 決定翻譯(#5)與整理筆記(#6)不搬,ARCHITECTURE D25)
- 內容:刪除 `modules/ai/core/translate.js`(語言清單、分段、翻譯提示);`ai/core/context.js` 拿掉整理筆記用的 `NOTE_PROMPT` 與 `parseJsonReply`;測試基準拿掉翻譯分段與 `NOTE_PROMPT` / `parseJsonReply` 的比對(其餘提示仍與舊版逐字比對),改加一項 `chatOnce` 請求內容與舊版相同(外部 IP 自動學習仍使用;審查建議)。`infra/llm` 的 `chatOnce` 保留(外部 IP 自動學習使用),只改註解。設定與 `.env.example` 的說明改為「AI 未設定回 409」(與 API 一致)。
- 檔案:`backend/src/modules/ai/core/{context.js,translate.js(刪除)}`、`backend/src/infra/llm/index.ts`、`backend/src/config.ts`、`backend/.env.example`、`backend/test/unit/ai-core.test.ts`
- 驗證:`npm run typecheck`、`npm test`(148 項通過;與移除前同為 148 項:拿掉翻譯分段的比對、新增 `chatOnce` 的比對)、`npm run build`;`code-reviewer`、`security-auditor` 審查(無必修)

## 2026-11-05 A1-api 審查修正
- 工作項目:A1(第 2 批;`code-reviewer`、`security-auditor` 審查後)
- 內容:① SSE:用戶端在處理請求前就斷線時不開始(否則掃描與模型照跑、名額佔到最長時間);串流結束時一併中斷還在進行的工作(翻譯其中一段失敗,其餘段落不再等);用戶端讀不動被中斷時寫 warn 日誌。② 翻譯最多 12 段、同時 3 段(舊版全部同時送,AI 主機與其他系統共用),空白內容與分段超過上限在串流開始前回 400。③ 問答的 FTP 掃描全系統同時只跑 1 個(排隊時送 `scan` `{ waiting: true }`;唯讀使用者不能藉 AI 問答佔滿 FTP 連線);掃描逾時或連線組合超過 20 萬列(`queryFlows` 的 `truncated`)時標資料不完整且不快取。④ `gateway-rbac.yaml`:三個 AI 按鈕一併綁定 `netops.pa.read`、`netops.ad.read`、`netops.kb.read`(`netops.ai.use` 實際可取得 PA、AD 與知識庫的彙整,授權畫面要看得到)。⑤ 稽核:整理筆記、翻譯、立即同步、外部 IP 學習加 `x-audit-level: meta`。⑥ `/ai/status` 與外部 IP 學習紀錄不帶上游原文(模型回應不是 JSON 時改分類錯誤;寫入知識庫與 RDAP 連線錯誤只留固定文字,原文寫日誌)。⑦ 排程:筆記異動的同步計時器在關閉時清除,`setInterval` 用 `clearInterval`。⑧ `history` 上限放寬到 100 則(只送最近 6 則)。⑨ `host2-set-secrets.sh` 的 Qdrant Key 輸入先設 trap 再關回顯。
- 另記與舊版不同(審查指出原本漏記):`analyze` 的 `question`、`ask` 與 `note` 的文字超過上限回 400(舊版截斷);模型連不到時舊版在串流前回 5xx,新版以 `error` 事件回傳;掃描並行數改為 `FTP_MAX_CONNECTIONS`(舊版 `parallel + 1`,另開連線);整理筆記的 `source` 截 1,000 字;`ask` 的 `meta` 時間改 ISO 8601。
- 未改(交需求方決定):`netops.ai.use` 是否拆成 PA / AD 各自的權限;整理筆記是否改成「先回草稿、管理者確認後才存」(AI 回答可能夾帶外部可控的文字,例如 URL、RDAP、PTR,記錄後會影響之後所有人的分析);AI 主機以 http 傳 API Key(內網,同舊版)。
- 檔案:`backend/src/modules/ai/{sse,service,routes,index}.ts`、`backend/src/modules/kb/ai-routes.ts`、`backend/src/infra/llm/index.ts`、`backend/test/unit/ai.test.ts`、`deploy/{gateway-rbac.yaml,host2-set-secrets.sh}`、`docs/API.md` §8、§10
- 驗證:`npm run typecheck`、`npm test`(165 項通過,新增 4 項:名額共用與歸還、全系統上限、用戶端中途斷線中斷模型並歸還名額、翻譯驗證)、`npm run build`、`check-scenarios.mjs`

## 2026-11-05 A1-api:AI API(SSE)、知識庫 AI 功能、權限與部署設定
- 工作項目:A1(第 2 批 `feature/a1-ai-api`,從第 1 批開出)
- 內容:`modules/ai/service.ts` 搬舊版 `routes/ai.js` 的分析、問答、整理筆記、翻譯流程(送給模型的內容不變);`modules/ai/sse.ts` 是 AI 共用的 SSE(依 S0 §3.6:`x-timeout-ms: 60000`、立即送 `open`、心跳 15 秒、`X-Accel-Buffering: no`、名額滿 429、`preClose` 結束;每人 2 個、全系統 6 個,單一回答最長 15 分鐘,使用者關頁時中斷掃描與模型);`modules/ai/routes.ts`:`GET /v1/ai/status`、`POST /v1/ai/{analyses,questions,translations,notes}`;`modules/kb/ai-routes.ts`:`GET /v1/kb/{semantic-search,vector-status,ip-learning}`、`POST /v1/kb/{vector-syncs,ip-learnings}`;`modules/ai/index.ts` 組裝(模型、向量庫、RDAP 用戶端,向量同步與外部 IP 學習的排程);知識庫服務新增 `onChange`(向量同步用)。權限 `netops.ai.use`(OpenAPI `x-permissions`;不是 `.read`,`gateway-rbac.yaml` 以按鈕 `netops.pa-ask.use`、`netops.ad-ask.use`、`netops.pa-dashboard.ai` 綁定,另加選單 `netops.pa-ask.read`、`netops.ad-ask.read`;admin 與 viewer 都有);整理筆記用 `netops.kb.write`。部署:compose 加 AI 設定(預設 `.46`、`VECTOR_SYNC=0`、`IPLEARN_HOUR=-1`)與機密 `qdrant_api_key`(`host2-set-secrets.sh` 隱藏輸入;CI 檢查)。
- 與舊版不同:翻譯、整理筆記改 SSE(舊版同步回應最長 180 秒,超過路由上限);問答期間最長 31 天;AI 未設定回 409(不回 5xx);串流開始前的錯誤回 4xx、開始後以 `error` 事件回分類訊息(不含主機位址與上游原文);`status` 不回主機位址;`meta` / `evidence` / `notes` 多 `missing`、`vectorError`(AGENT.md §5);整理筆記與外部 IP 學習寫入的標題、標籤壓成一行;外部 IP 學習狀態補回 `hour`;`GET /ai/context`(開發用)不搬。
- 檔案:`backend/src/modules/ai/{index,routes,service,sse}.ts`、`backend/src/modules/kb/{ai-routes,service}.ts`、`backend/src/{app,openapi}.ts`、`backend/test/{helpers.ts,fixtures/fake-ai.ts,unit/ai.test.ts,unit/app.test.ts}`、`deploy/{docker-compose.yml,gateway-rbac.yaml,host2-set-secrets.sh,test.env.example}`、`.gitlab-ci.yml`、`docs/API.md` §2、§7、§8、§9、§10、`docs/ARCHITECTURE.md` §5、`docs/Gherkin/{ai/ai.feature,kb/ai.feature,README.md,check-scenarios.mjs}`
- 驗證:`npm run typecheck`、`npm test`(161 項通過,新增 13 項:SSE 標頭與事件順序、只送摘要不送原始 log、問答查連線組合 / 掃 FTP / 追問沿用條件、驗證錯誤 4xx、名額 429、整理筆記寫入知識庫、翻譯、語意搜尋、向量同步關閉、模型連不到、外部 IP 學習 API)、`npm run build`、`check-scenarios.mjs`(74 個 x-gherkin 場景全部對應,0 個問題)

## 2026-11-05 A1-core 審查修正(與舊版不同)
- 工作項目:A1(第 1 批;`security-auditor`、`code-reviewer` 審查後,與搬移分開提交)
- 內容:① 向量同步(共用 collection):payload 沒有 `noteId` 的 point 不列入、不刪除;知識庫是空的,或一次要刪除超過現有 20%(至少 5 筆)時整次不同步並回錯誤(寫入前就檢查);scroll 最多 200 頁、`next_page_offset` 重複時停止。② `queryFlows` 符合的組合最多 20 萬列,超過標 `truncated`(寬網段一次可能數百萬列);舊版 `out.push(...found)` 在組合很多時會超過函式參數上限,改逐一加入。③ 外部 IP 學習:RDAP 的名稱、說明、國家壓成一行、去掉控制字元並限制長度(登記人可填入要模型照做的文字,之後會寫進知識庫);DNS 反查名稱只接受主機名稱格式;模型回的 `key` 只接受這一批的分組;內容先截 8,000 字再去掉註記;管理者改過的筆記(`noteState` 為 manual)不覆寫,已刪除的重新建立,寫入失敗記錄並略過(舊版任何錯誤都改成新建,可能重複);自動學習筆記上限 1,000 則(預留管理者額度)。④ RDAP 轉址只跟到五個登記處的 https 網址(最多 3 次);`createRdap` 的解析函式改必填。⑤ `infra/llm`:使用者中斷與逾時分開判斷;串流一行超過 1 MB 視為格式錯誤。
- 另記:`IPLEARN_DAYS` / `IPLEARN_MAX` / `IPLEARN_TTL_DAYS` 改嚴格驗證(舊版 `0` 或寫錯會退回預設,新版啟動失敗);舊版 `learnStatus` 的 `hour` 由第 2 批 API 補上。
- 未改(交需求方決定):問答送給模型的逐筆範例(最多 15 筆 log,含使用者帳號)與 AD 事件訊息前 400 字(同舊版,是否符合 AGENT.md §7.4「只送統計與彙整」);AI 主機以 http 傳 API Key(內網);專用 collection(目前與舊版共用 `NetOpsKb`)。
- 檔案:`backend/src/modules/{kb/core/vector.js,pa/core/flows.js,iplearn/core/iplearn.js}`、`backend/src/infra/{rdap,llm}/index.ts`、`backend/test/unit/ai-core.test.ts`
- 驗證:`npm run typecheck`、`npm test`(新增 5 項:向量同步安全閥、關閉同步仍可搜尋、`queryFlows` 上限、RDAP 清理與轉址、管理者改過的筆記不覆寫與 TTL 不重查)、`npm run build`

## 2026-11-05 A1-core:AI 核心搬移與測試基準(不含 API)
- 工作項目:A1(第 1 批 `feature/a1-ai-core`;API 在第 2 批 `feature/a1-ai-api`)
- 內容:舊版 AI 核心依 D4 先補測試基準再搬,研判、提示與送給模型的內容不變:`evidence.js` 逐字複製(只改 import 路徑)到 `modules/ai/core/`;`routes/ai.js` 的資料整理 `buildContext` 與全部提示搬到 `modules/ai/core/context.js`(摘要讀取改由呼叫端注入);翻譯分段與提示搬到 `ai/core/translate.js`;`kb.js` 的 `notesForAi` 搬到 `kb/core/ai-notes.js`;`flows.js` 的 `queryFlows` 搬回 `pa/core/flows.js`(讀檔改注入,store 新增 `readFlows`);`paevimport.js` 的 `eventsForIps` / `eventsContext` 加進 `pa-events/importer.ts`;`adimport.js` 的問題判斷與 `adContext` 搬到 `ad/core/ad-ai.js`(事件由 `ad/importer.ts` 傳入);`vector.js` 搬到 `kb/core/vector.js`、`iplearn.js` 搬到 `iplearn/core/iplearn.js`,都改成注入相依的工廠函式(舊版 import 時就啟動計時器、直接讀設定)。外部連線放 `infra/`:`infra/llm`(vLLM;串流改 async generator,請求內容同舊版)、`infra/vector`(Qdrant、embedding)、`infra/rdap`(RDAP、DNS 反查);主機位址只從設定讀。`config.ts` 新增 AI 設定(`LLM_URL`、`LLM_MODEL`、`LLM_API_KEY_FILE`、`LLM_TIMEOUT_MS`、`EMBED_URL`、`QDRANT_URL`、`QDRANT_COLLECTION`、`QDRANT_API_KEY_FILE`、`VECTOR_SYNC`、`IPLEARN_*`、`KB_MAX_CHARS`、`AI_MAX_STREAMS*`):網址格式錯誤、網址帶帳密、有 Qdrant 沒 embedding、正式區明文 Key 都啟動失敗;外部 IP 狀態檔沿用舊版位置 `palogs/iplearn.json`。
- 與舊版不同:`VECTOR_SYNC` 預設關閉(舊版 IIS 仍同步同一個 `NetOpsKb`,兩邊都同步會互刪對方的 point;關閉時只做語意搜尋);`IPLEARN_HOUR` 預設 -1(不自動,舊版預設 3 點);模型 / 向量庫的錯誤原文(可能含主機位址)只寫日誌,對外只有分類訊息;翻譯分段同時取模型名稱時只查一次 `/models`;舊版在 `paevimport` / `adimport` / `kb` / `flows` 讀設定與檔案的地方改經 store 與匯入器。
- 開工查證(唯讀,2026-11-05):`.46:8081`、`.45:8081` 都是 `Qwen3-Embedding-8B-Q8_0`(n_embd 4096),主機 2 容器內實算 4096 維,與舊版相同,不需重建 collection;Qdrant 需要 API Key(未查 `NetOpsKb` 維度與筆數);主機 2 容器可連 `.46` / `.45` 的 8080、8081、6333,RDAP ARIN / APNIC / RIPE 可連、LACNIC / AFRINIC 逾時,DNS 反查可用;主機 3 主機層可連 `.46` 三個 port 與 RDAP ARIN,容器內未驗。
- 檔案:`backend/src/{config.ts,infra/llm,infra/vector,infra/rdap,infra/store/pa.ts}`、`backend/src/modules/{ai/core,iplearn/core,kb/core/ai-notes.js,kb/core/vector.js,ad/core/ad-ai.js,ad/importer.ts,pa-events/importer.ts,pa/core/flows.js}`、`backend/test/{legacy.ts,unit/ai-core.test.ts,unit/config.test.ts}`、`backend/.env.example`
- 驗證:`npm run typecheck`、`npm test`(143 項通過,新增 18 項:同一批假資料以舊版 `server/` 原封不動執行(只換設定與 import),比對 `buildContext`、提示、`notesForAi`、`queryFlows`、`eventsForIps` / `eventsContext`、`adContext`、送給模型的請求與串流事件、翻譯分段、向量同步對 Qdrant 的請求、外部 IP 學習的筆記與狀態檔都一致;模型、Qdrant、RDAP 都是本機假服務)、`npm run build`

## 2026-11-05 R1 API:`netops-api` 讀 netops-redis(`infra/redis`、`modules/pa-live`)
- 工作項目:R1
- 內容:`infra/redis/index.ts`(ioredis 5.11.1,Gateway TECH-STACK 已列;鍵格式同 `pa-collector/netops_pa/keys.py`,只在這裡組鍵;不排隊、3 秒逾時;連線錯誤限頻 warn)。`modules/pa-live/service.ts`:收集器狀態(心跳超過 30 秒 = stopped、兩個開關都關 = disabled、輪詢或 Redis 錯誤 = degraded、Redis 連不上 = unavailable;停止時不回舊快照)、快照、趨勢、排行合併、最新 log 掃描與篩選;心跳的錯誤原文只回分類。`live-routes.ts`:`GET /v1/pa-live/{snapshot,series,top,logs,stream}`,權限 `netops.pa-realtime.read`;`logs`、`stream` 設 `x-audit-level: meta`;SSE 照 S0 規則(`x-timeout-ms` 60000、立即送 open、心跳 15 秒、429、`preClose`),單一連線最長 5 分鐘,`Last-Event-ID` 游標接續(超過 5 分鐘不接續)。Redis 連不上時 `snapshot` 回 200 `unavailable`、其他回 **424**(不用 5xx:BFF 斷路器把上游 5xx 計為失敗)。`config.ts` 新增 `REDIS_URL`(test / prod 必填)。依 `code-reviewer`、`security-auditor` 審查修正(SSE 各類型分開處理失敗並送 `degraded`、ReplyError 與連線錯誤分開、`before` 拒絕 `0-0`、未知維度回 400、慢用戶端中斷底層連線、日誌)。
- 檔案:`backend/src/infra/redis/index.ts`、`backend/src/modules/pa-live/{service,live-routes}.ts`、`backend/src/{app,config,openapi}.ts`、`backend/test/fixtures/fake-redis.ts`、`backend/test/unit/pa-live-r1.test.ts`、`docs/API.md` §3.2、`docs/Gherkin/pa-live/realtime.feature`
- 驗證:`npm run typecheck`、`npm test`(148 passed)、`npm run build`;`check-scenarios.mjs` 69 / 69

## 2026-11-05 R1 部署:netops-redis、netops-pa 加入 Compose 與 CI(測試區)
- 工作項目:R1、R0
- 內容:`deploy/docker-compose.yml` 新增 `netops-redis`(redis:7.4-alpine,`maxmemory` 2 GB、`noeviction`、RDB 開 / AOF 關、named volume,只在 `internal: true` 的 `netops-internal` 網路,不對主機開 port)與 `netops-pa`(唯讀根目錄、tmpfs /tmp、cap_drop ALL、日誌輪替;port 51293 / 51294 只綁 WSL `127.0.0.1`;`PA_POLL_ENABLED` / `PA_RECEIVE_ENABLED` 預設 0);`netops-api` 加 `REDIS_URL` 與 `netops-internal` 網路。CI `deploy-api-test` 檢查機密、建置(`--pull`)並啟動兩個容器、確認 `noeviction`。新增 `deploy/host2-set-pa-secrets.sh`(Token 自動產生、API Key 隱藏輸入,可先留空)。新增 `docs/PA-FORWARDING-SPEC.md`(給網通:唯讀角色與 API Key、HTTP / Syslog Server Profile、各類型 payload 欄位對應、Log Forwarding Profile;附錄 F 主機端 portproxy、防火牆、開啟步驟)。
- 檔案:`deploy/docker-compose.yml`、`.gitlab-ci.yml`、`deploy/host2-set-pa-secrets.sh`、`deploy/test.env.example`、`docs/PA-FORWARDING-SPEC.md`、`docs/PA-LIVE-PLAN.md` §9
- 依 `security-auditor` 審查修正:Compose 帶入憑證設定(`/srv/giganexus/netops-pa-tls` 唯讀掛載,`PA_CA_FILE`、`PA_TLS_*`、`PA_RECEIVE_PLAINTEXT`)、Redis `cap_drop` 與 `stop_grace_period`、CI 先建置 netops-pa 並檢查 AOF / RDB / maxmemory、腳本 trap 順序、規格的 API Key 產生指令(密碼從標準輸入、驗證憑證)、Syslog 安全限制與主機 3 防火牆注意事項(附錄 F.4.1)、手動重建改用 CI 映像。
- 驗證:`docker compose -f deploy/docker-compose.yml config` 通過(本機無 Docker daemon,未實際啟動;CI 部署時驗證);`.gitlab-ci.yml` 以 YAML 解析器確認
- 2026-11-09 補充(準備接真的 PA-560):`docs/PA-FORWARDING-SPEC.md` 加入管理介面 Permitted IP Addresses(A.0)、憑證 SAN 規則(用 IP 連線時 SAN 要有該 IP)、附錄 F.4 改為先查憑證 SAN 再用 `python -m netops_pa check` 檢查後才打開輪詢、新增 G 節「請網通回覆的資訊」清單

## 2026-11-05 R1 收集器 `pa-collector/`(netops-pa)
- 工作項目:R1
- 內容:新增 Python 3.12 服務 `netops-pa`(PA-LIVE-PLAN §3.1):① SDK 輪詢(`PA_POLL_ENABLED`):pan-os-python 只執行白名單內 4 個 `show` op 指令(D22),寫快照 `netops:pa:snap:*`(60 秒 TTL)與趨勢 `series`(2 天);pan-os-python 預設不驗證 HTTPS 憑證,改為自帶 `ssl_context` 預設驗證(`PA_CA_FILE`;`PA_TLS_INSECURE` 只限 dev / test)。② HTTP 接收 :51293(`POST /v1/logs/{type}`,TRAFFIC 以外,`X-NetOps-Token` 固定時間比對)與 Syslog 接收 :51294(TCP / 選用 TLS 與用戶端憑證,只收 TRAFFIC,換行與長度分框),由 `PA_RECEIVE_ENABLED` 控制;只接受 `PA_ALLOWED_SOURCES`;單則與本文長度、同時連線數、閒置逾時、HTTP 與 Syslog 各自的速率上限、Syslog 最多用佇列 80%;畸形輸入只計數。③ 批次寫 Redis:Stream(MINID 精確修剪 + MAXLEN 上限 + EXPIRE)、每分鐘 Hash 與排行(TTL;排行每分鐘留前 200)、心跳 `netops:pa:heartbeat`(輪詢、接收、Redis 的最後成功時間與錯誤、計數)。保留時間依 D21。欄位 key 沿用舊版 `palog.js` / `paevents.js`。錯誤訊息遮罩 API Key / Token。CI 新增 `check:pa-collector`(Docker test 階段跑 ruff + pytest)。依 `code-reviewer`、`security-auditor` 審查修正(JSON 深層巢狀與超長整數、Redis 錯誤清除、Stream 過期、Hash 計數值上限、日誌限頻、工作執行緒結束時程序結束重啟、正式區接收端點預設要求 TLS)。
- 檔案:`pa-collector/`、`.gitlab-ci.yml`
- 驗證:`ruff check .` 通過;`pytest` 68 passed(假 PA XML API + 真正的 pan-os-python、fakeredis;本機 Python 3.14,CI 為 3.12)
- 2026-11-09 補充(需求方取得 PA-560 唯讀 API Key,準備接真的 PA):新增 `python -m netops_pa check`(`check.py`):容器內跑一次唯讀查詢(`show system info` 印型號、PAN-OS 版本、序號後 4 碼,加 4 個輪詢指令),不寫 Redis、不需打開 `PA_POLL_ENABLED`;失敗時提示可能原因(憑證 SAN、API Key / 角色權限、網路或 Permitted IP、版本);Key 不印出。HTTP 接收端點回錯誤前讀掉未讀的本文(不讀就關閉時,Windows 與 PA-560 可能收到 RST 而看不到錯誤碼;本機測試偶發失敗即此原因)。`pytest` 72 passed(連跑 3 次)。依 `security-auditor` 審查修正:`check` 也把 SDK 日誌壓到 WARNING、檢查 `GW_ENV` 只能是三個部署區、`show system info` 改經唯讀白名單(`CHECK_COMMANDS`)、設備字串去掉控制字元、建立連線失敗時遮罩後回結束碼 2;拒收時最多讀掉 64 KB 本文(超過直接關閉),keep-alive 每個請求重設狀態

## 2026-11-05 S0 串流驗證路由 `GET /v1/pa-live/stream-test`
- 工作項目:S0
- 內容:`modules/pa-live/routes.ts`:SSE(`PassThrough` 串流交給 Fastify,保留 hook 與監控);立即送 `retry` 與 `open`,每 15 秒 `heartbeat`(`id` 為序號,`data` 含 seq、伺服器時間、connectionId);`Last-Event-ID` 只接受正整數,接續序號;單一連線 10 分鐘;每人 2 條、全系統 20 條(超過 429 `NETOPS_STREAM_BUSY`;不用 5xx,因為 BFF 斷路器會把上游 5xx 計為失敗);用戶端在驗證 Token 期間已斷線時不建立串流;待送資料超過 64 KB 中斷;用戶端斷線、最長時間到與服務關閉(`preClose`,`onClose` 時 server 已在等候長連線)時清除計時器。OpenAPI 設 `x-timeout-ms: 60000`(BFF undici `bodyTimeout` 是閒置時間,大於心跳即可長連線)、`x-permission: netops.ping.read`(驗證用、不綁畫面,不新增權限、不改 `gateway-rbac.yaml`)。`buildApp` 的 `deps.streamTest` 只給測試縮短間隔。`scripts/sse-probe.mjs`:經 Gateway 連線,記錄事件到達時間、間隔、伺服器時間差、斷線與重連,結束時判定(不被緩衝、事件間隔含最後空窗、事件數、單一連線 65 秒、5 分鐘、重連序號接續);Cookie 由提示輸入(不回顯)或環境變數,不印出;只送到 https 的 GigaNexus 網域、不跟隨轉址;401 / 403 / 404 / 429 直接結束,連續 3 次錯誤停止重連。依 `code-reviewer`、`security-auditor` 審查修正。
- 檔案:`backend/src/modules/pa-live/routes.ts`、`backend/src/app.ts`、`backend/test/helpers.ts`、`backend/test/unit/pa-live.test.ts`、`backend/scripts/sse-probe.mjs`
- 驗證:`npm run typecheck`、`npm test`(125 項通過,新增 7 項)、`npm run build`;以本機假 Gateway 跑 `sse-probe.mjs`(心跳縮短)確認主動斷線後以 Last-Event-ID 重連;另以 BFF 使用的 undici 8.11.2 確認 `bodyTimeout` 是資料塊之間的閒置時間

## 2026-11-05 D1 驗收修正:測試區 FTP_LOG_DIR、FTP 清單不列系統資料夾、知識庫備份 healthcheck
- 工作項目:D1(驗收報告 `docs/test-reports/2026-11-05-d1-uat-pending.md` §3.1、§4.1、§5.4)
- 內容:① 測試區 TRAFFIC 在 FTP `/my-data`,`FTP_LOG_DIR` 沒設定(預設 `/`)時永遠無法分析;依需求方決定寫進部署設定:`.gitlab-ci.yml` `deploy-api-test` 加 `FTP_LOG_DIR: /my-data`(Compose 以 shell 環境變數優先,蓋過主機 `netops.env`)。compose 本身不寫值(正式區共用);正式區的值寫進 IMPL-PLAN D2 待確認。② `infra/ftp` 的列目錄不回 `$RECYCLE.BIN`、`System Volume Information`(不分大小寫;`isSystemEntry`),PA 瀏覽、同步與 AD 清單共用。只過濾清單,不擋路徑。③ `netops-kb-backup` 加 healthcheck:`/backup/LAST_RESULT` 26 小時內更新過且為 OK(FAIL、NAS 未掛載不寫結果、超過一天沒備份都會 unhealthy);interval 30 秒、start_period 5 分。CI 的 `up -d --wait` 會等 healthy,備份失敗時 `deploy-api-test` 失敗。
- 檔案:`.gitlab-ci.yml`、`deploy/docker-compose.yml`、`deploy/test.env.example`、`backend/src/infra/ftp/index.ts`(`toEntries`)、`backend/src/modules/ftp/routes.ts`(x-gherkin)、`backend/test/unit/ftp.test.ts`、`docs/API.md` §5、`docs/Gherkin/ftp/*.feature`
- 驗證:`npm run typecheck`、`npm test`(118 項通過,新增 2 項)、`npm run build`;`check-scenarios.mjs` 無問題(順帶修正既有的來源行號);healthcheck 指令以本機 shell 驗證 6 種情況(alpine busybox 的 `find -mmin` 未在容器內實測,合併後看 CI)

## 2026-11-04 D1:測試區部署前端、畫面權限、監控 Key、知識庫 NAS 備份
- 工作項目:D1
- 內容:① `.gitlab-ci.yml` 新增 `deploy-web-test`(建置 `spa-netops` 並發佈到 Gateway 的 `gw_www/netops`,冒煙測試確認 `/netops/` 與深層路由回本系統的 index.html)與 `rbac-test`(以測試區 Gateway 映像套用 `deploy/gateway-rbac.yaml`),做法同 GigaItApp、giga-Portal。② `deploy/gateway-rbac.yaml`:ARCHITECTURE §5 的應用、3 個選單目錄、8 個選單、3 個按鈕(`includes` 綁 API 權限,與前端 `requires` 一致)與角色 `netops-admin`、`netops-viewer`(不指派成員,D15);路由由服務自動註冊,不另寫 `gateway-routes.yaml`(B0 決定;`apply` 會把已發佈的路由打回草稿)。③ `deploy/host2-set-secrets.sh`:`monitor_api_key` 是空檔時改以 giga-observe `createApiKey.js` 建立 ingest Key(服務 `netops-api`)。④ 知識庫 NAS 備份(Q3):compose 新增 `netops-kb-backup`(`deploy/kb-backup/`,alpine,唯讀掛資料目錄、不連網路),每天 2 點把 `knowledge/` 打包到 NAS `docker-folder/giga-netops/<區>`,核對檔數、寫 `.sha256`、保留 30 份;沒有標記檔 `.giga-netops-backup` 時不寫入;目錄與標記檔由新的 `deploy/host2-setup-kb-backup.sh` 建立(沿用附件服務的 NAS 掛載,不經手 NAS 帳密)。
- 檔案:`.gitlab-ci.yml`、`deploy/docker-compose.yml`、`deploy/gateway-rbac.yaml`、`deploy/apply-gateway-rbac.sh`、`deploy/host2-set-secrets.sh`、`deploy/host2-setup-kb-backup.sh`、`deploy/kb-backup/{Dockerfile,backup.sh}`、`deploy/test.env.example`
- 配合:Gateway `feature/netops-spa`(Nginx `/netops/`、`gw.app`)、giga-observe `feature/topology-netops`(拓樸)
- 審查後:`apply-gateway-rbac.sh` 套用前檢查範圍(頂層只能有 permissions / roles,代碼、includes、角色權限都要是 `netops.*` / `netops-*`,不得有 adGroups / companies;CLI apply 本身不限系統);監控 Key 寫入後立即 chown / chmod,取不到 Key 時不印 createApiKey 的輸出;`publish.sh` 驗證版本名稱、回滾排除 `.tmp`;`netops-kb-backup` 加 `init`、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`,啟動時清掉中止留下的 `.part`,整點比較改數值(`KB_BACKUP_HOUR=0` 原本永不觸發);CI 冒煙測試不再用 `A | B && echo`(左側失敗不會讓 job 失敗,含既有的 `/v1/ping`);`deploy-web-test` 加 `needs: [deploy-api-test]`(同一個 compose project 不同時執行);`netops-kb-backup` 以 `--wait` 啟動
- 驗證:見 MR 描述

## 2026-11-03 FTP 錯誤訊息不外露主機與原始錯誤
- 工作項目:B2(F1 的 security-auditor 指出;!11 已記錄同類問題)
- 內容:`infra/ftp` 的 502 `NETOPS_FTP_UNAVAILABLE` 原本把 basic-ftp 的原始錯誤(可能含 FTP 主機 IP 與 port,例如 `connect ECONNREFUSED 10.10.130.66:21`)接在訊息後面,經 API 回應、匯入狀態 `lastSyncError`、FTP 檔案清單的 `error` 與工作的 `error.message` 傳給有 `netops.ftp.read`、`netops.pa-log.read` 的人。改成只回分類過的原因(`ftpReason`:逾時、拒絕連線、找不到主機、連線中斷、TLS、FTP 回應碼),原始錯誤放在 `cause`,由錯誤處理、匯入與工作的日誌寫出。FTP 路徑照舊(畫面上本來就看得到)。
- 已知:修正前已寫進分析狀態的錯誤訊息(測試區,以及 D14 從舊版複製的資料)維持原文,重新分析或同步後覆寫。
- 檔案:`backend/src/infra/ftp/index.ts`、`backend/src/app.ts`、`backend/src/infra/jobs/index.ts`、`backend/src/modules/{pa,pa-events,ad}/importer.ts`、`backend/test/unit/{ftp,jobs}.test.ts`、`docs/API.md` §8
- 審查後:分析狀態的 `errorText` 改白名單(已分類的 AppError、核心格式錯誤、「FTP 傳輸不完整」照實,其他回固定訊息);檔案大小上限改固定文字;外部錯誤(帶 cause)才在錯誤處理寫 error 日誌,預期內的 503 不記;自動同步失敗不重複記錄;TLS 只比對 Node 的錯誤碼。
- 驗證:`npm run typecheck`、`npm test`(116 項通過,含連到本機未開的 port,確認訊息不含主機與 port)、`npm run build`;`security-auditor`(無 High / Medium)、`code-reviewer`(無必修)審查後修正

## 2026-11-03 冪等 DELETE 在 OpenAPI 宣告 204
- 工作項目:B2(Gherkin 規格比對時發現,docs/Gherkin/README.md §7 #6)
- 內容:`DELETE /v1/pa/log-searches/:id`、`/v1/ftp/ad/listings/:id`、`/v1/kb/notes/:id` 實際回 204,但路由沒有宣告,OpenAPI 只有預設的 200;補上 `response: { 204 }`(`shared/schemas.ts` 的 `NO_CONTENT`)。行為不變。
- 檔案:`backend/src/shared/schemas.ts`、`backend/src/modules/{pa/log-routes.ts,ftp/ad-routes.ts,kb/routes.ts}`、`backend/test/unit/app.test.ts`
- 驗證:`npm run typecheck`、`npm test`、`npm run build`

## 2026-11-03 B2-logs:PA Log 明細查詢與匯出(工作模式)
- 工作項目:B2
- 內容:`scan.js` 搬到 `pa/core/scan.js`,只把 `openStream` 改成由呼叫端注入(其餘逐字相同);篩選沿用 `palog.js` 的 `buildFilter`、`buildPrefilter`。舊版 `POST /palog/search` 同步等待最長 180 秒,改成工作模式(D6):`POST /v1/pa/log-searches`(202)、`GET /v1/pa/log-searches/:id`(狀態只回摘要)、`/rows`(分頁)、`/export`(伺服器端 CSV,舊版在前端產生)、`DELETE`(取消並中斷 FTP 掃描,冪等 204)。工作只有本人可查;期間最長 31 天;與匯入共用 FTP 連線上限。審查後:IP 條件只允許 IP 字元、`*` 最多 4 個且連續合併(舊版大量 `*` 會讓正規表示式比對卡死整個服務,核心不改、在路由擋);明細查詢同時只執行 1 個、每人保留 5 筆結果,已完成的工作取消即丟棄結果;掃描結束一律中止還在排隊或佔 FTP 連線的 worker,等不到連線超過掃描秒數時回部分結果(`timeout`),匯出檔名標「_不完整」。
- 檔案:`backend/src/modules/pa/{core/scan.js,log-routes.ts}`、`backend/test/unit/logs.test.ts`、`backend/test/fixtures/fake-ftp.ts`
- 驗證:`npm run typecheck`、`npm test`(110 項通過,含同一批假 log 以舊版 `scan.js` 原封不動執行,5 組條件的結果列與新版完全一致)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B2-kb:知識庫
- 工作項目:B2
- 內容:舊版 `kb.js` 的解析、序列化、欄位整理、匯整檔與關鍵字查詢搬到 `modules/kb/core/notes.js`(內容不變,不含檔案讀寫);讀寫改由 `store.kb`(位置與格式同舊版 `uploads/knowledge`,D14)。新增 API:`/v1/kb/notes`(GET 分頁、POST)、`/v1/kb/notes/:id`(GET、PUT、DELETE)、`/v1/kb/notes/:id/markdown`、`/v1/kb/compilation`。與舊版不同:編輯權限改由 BFF 依 `netops.kb.write` 檢查(不再用 `KB_ADMINS`)、記錄人為 Gateway 身分「工號 姓名」、回應不含 `admin`、刪除冪等(204)、內容超過 20,000 字回 400(舊版截斷)。審查後(資安修正,與舊版不同):標籤與寫出的每個欄位都壓成一行、標題與標籤含換行回 400(舊版標籤內含換行可偽造記錄人與建立時間);新增時代號重複會重新產生、不覆蓋;筆記上限 5,000 則;下載加 `X-Content-Type-Options: nosniff`;匯整檔重產失敗不讓已寫入的筆記回 500。語意搜尋、向量同步、外部 IP 自動學習、`notesForAi` 不搬移(D17)。
- 檔案:`backend/src/infra/store/kb.ts`、`backend/src/modules/kb/`、`backend/test/unit/kb.test.ts`
- 驗證:`npm run typecheck`、`npm test`(100 項通過,含同一批筆記以舊版 `kb.js` 原封不動執行比對解析、查詢、匯整檔、新增結果一致)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B2-ad:安全事件、AD 事件與 FTP Log 檔案(AD)
- 工作項目:B2
- 內容:`adlog.js` 逐字複製;`adimport.js` 改寫成 TypeScript(讀寫只經 `store.ad`;一天的資料檔格式與簽章同舊版,複製舊資料後不會被誤判為已變更)。新增 API:`/v1/pa-events/{types,overview}`、`/v1/ad/{days,overview,events,events/export}`、`/v1/ftp/ad/{listings,listings/:id,status,syncs,imports,result-deletions}`。與舊版不同:AD 清單改工作模式(本人才能查、可取消);同步與重新匯入背景執行回 202,同步中回 409;列目錄與下載共用同一條 FTP 連線(舊版同時開兩條);明細查詢改分頁、期間最長 31 天;新增伺服器端 CSV 匯出(上限 20,000 筆,公式字元加 `'`);AD 下載單檔上限 64 MB;安全事件總覽多 `missing`。審查後:總覽與選項期間最長 92 天(PA、安全事件、AD);多人同時的 AD 清單共用同一次 FTP 列表;背景同步失敗寫日誌;沒有設定 FTP 時同步回 503;`/ad/days` 不回同步錯誤細節(細節在 `ftp.read` 的 `/ftp/ad/status`);CSV 公式字元也處理全形與前置空白。AI 用的 `adContext`、`eventsForIps` 等不搬移(D17)。
- 檔案:`backend/src/infra/store/ad.ts`、`backend/src/modules/{ad,pa-events/routes.ts,ftp/ad-routes.ts}`、`backend/src/shared/csv.ts`、`backend/test/unit/ad.test.ts`、`backend/test/fixtures/fake-ad.ts`
- 驗證:`npm run typecheck`、`npm test`(86 項通過,含同一批假匯出檔與舊版的匯入事件、總覽、明細篩選、安全事件總覽完全一致,舊版簽章的資料不會重新匯入)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B2-pa:FTP、PA 匯入與流量總覽
- 工作項目:B2
- 內容:`infra/ftp` 由舊版 `lib/ftp.js` 搬移(唯讀;匯入與明細查詢共用 `FTP_MAX_CONNECTIONS` 連線上限,舊版兩者各自開連線)。`palog.js`、`paevents.js` 逐字複製(`allowJs`);`flows.js` 只搬累計與輸出格式,寫檔改由 `infra/store`。`importer.js`、`paevimport.js` 改寫成 TypeScript(流程不變,讀寫只經 `store.pa` 的具名函式;分析中途被取消時不再誤標成功)。新增 API:`/v1/pa/{days,overview,options}`、`/v1/ftp/pa/{files,status,syncs,analyses,result-deletions}`;同步改背景執行回 202。總覽多 `missing`(摘要讀不到的檔案數)。
- 與舊版不同(審查後修正):讀取失敗(例如標頭不對)時立即中斷 FTP 傳輸並釋放連線(舊版留著連線);分析 API 只接受 TRAFFIC 與各類型目錄下的 log 檔,大小與修改時間改取 FTP 實際值(舊版信任畫面傳入,`modified` 格式錯誤會讓程序結束);分析佇列上限 5,000;畫面瀏覽優先拿 FTP 連線、最多等 25 秒(503 `NETOPS_FTP_BUSY`);取消可中斷等候中的連線;寫檔失敗的訊息不帶本機路徑;只有瀏覽 TRAFFIC 目錄時才比對搬移;路徑含控制字元回 400;FTP 連線逾時 30 → 20 秒;列目錄失敗 404 → 502;關閉服務時等分析中的檔案停止再寫入狀態。
- 檔案:`backend/src/infra/{ftp,store/pa.ts}`、`backend/src/modules/{pa,pa-events,ftp}/`、`backend/src/shared/`、`backend/test/unit/pa.test.ts`、`backend/test/fixtures/`
- 驗證:`npm run typecheck`、`npm test`(70 項通過,含同一批假 log 與舊版 `server/lib` 摘要、連線組合統計、總覽完全一致)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 B1 後端骨架:資料存取、長時間工作與完整設定
- 工作項目:B1
- 內容:`config.ts` 新增資料目錄 `NETOPS_DATA_DIR`、FTP(密碼 `FTP_PASSWORD_FILE`,正式區只接受 `_FILE`)、同時連線上限與明細查詢上限;test / prod 缺少時啟動失敗,數字或規則寫錯也啟動失敗(舊版會靜默改用預設)。`infra/store` 建立資料存取邊界(目錄與舊版 `uploads/` 相同,D14),`/readyz` 改為檢查資料目錄可寫入。`infra/jobs` 工作只有建立者本人可查(比對工號)、每人 2 個 / 全部 6 個進行中(取消後等工作真正停止才釋放名額)、完成後保留 30 分鐘、有執行時間上限,重啟後回 `NETOPS_JOB_NOT_FOUND`。資料檔損壞時丟出錯誤(回 500 `NETOPS_DATA_CORRUPT`),不當成沒有資料。FTPS 預設驗證憑證(舊版一律不驗證,改成 `FTP_TLS_INSECURE=1` 才放寬,正式區不允許);正式區連同時設定明文機密也拒絕;匯入目錄必須在 `FTP_ROOT` 之下。映像檔設 `TZ=Asia/Taipei`(log 與知識庫時間沿用台灣時間)。`deploy/`:資料目錄掛載、FTP 變數與 `ftp_password` 機密;`host2-set-secrets.sh` 隱藏輸入 FTP 密碼並建立 `/srv/giga-netops/test`;CI 檢查 `ftp_password`。
- 檔案:`backend/src/config.ts`、`backend/src/app.ts`、`backend/src/infra/{store,jobs}/`、`backend/test/unit/{app,config,jobs}.test.ts`、`backend/Dockerfile`、`backend/.env.example`、`deploy/`、`.gitlab-ci.yml`、`docs/API.md`
- 驗證:`npm run typecheck`、`npm test`(43 項通過)、`npm run build`;`code-reviewer`、`security-auditor` 審查後修正

## 2026-11-03 建立 netops-api 骨架與測試區部署
- 工作項目:B0
- 內容:由 Gateway `samples/node-backend` 複製,`gateway.project = NetOps`、`SERVICE_CODE = netops-api`(設錯時啟動失敗)、port 51292;錯誤代碼改為 `NETOPS_*`;移除樣本的 `public` 免 Token 路徑。`@giganexus/backend-sdk` 改由 GitLab npm Registry 安裝。`deploy/docker-compose.yml` 加入 Gateway 網路、不發佈 port;`host2-set-secrets.sh` 比照 giga-Portal 建立 API Key,監控 Key 先留空檔(D1 補)。
- 檔案:`backend/src/`、`backend/test/unit/app.test.ts`、`backend/Dockerfile`、`deploy/`、`.gitlab-ci.yml`
- 驗證:`npm run typecheck`、`npm test`(11 項通過)、`npm run build`;本機啟動冒煙測試
