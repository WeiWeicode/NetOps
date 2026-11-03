# 後端修改紀錄

> `backend/`、`deploy/` 的修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-03 B2-logs:PA Log 明細查詢與匯出(工作模式)
- 工作項目:B2
- 內容:`scan.js` 搬到 `pa/core/scan.js`,只把 `openStream` 改成由呼叫端注入(其餘逐字相同);篩選沿用 `palog.js` 的 `buildFilter`、`buildPrefilter`。舊版 `POST /palog/search` 同步等待最長 180 秒,改成工作模式(D6):`POST /v1/pa/log-searches`(202)、`GET /v1/pa/log-searches/:id`(狀態只回摘要)、`/rows`(分頁)、`/export`(伺服器端 CSV,舊版在前端產生)、`DELETE`(取消並中斷 FTP 掃描,冪等 204)。工作只有本人可查;期間最長 31 天;與匯入共用 FTP 連線上限。
- 檔案:`backend/src/modules/pa/{core/scan.js,log-routes.ts}`、`backend/test/unit/logs.test.ts`、`backend/test/fixtures/fake-ftp.ts`
- 驗證:`npm run typecheck`、`npm test`(107 項通過,含同一批假 log 以舊版 `scan.js` 原封不動執行,5 組條件的結果列與新版完全一致)、`npm run build`

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
