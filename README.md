# 資訊網通管理系統（NetOps）

架構與登入比照 Veeam 備份監控：**Vue 3 + Vite + Tailwind CSS v4 + Element Plus ／ Express 5 + mssql + JWT，部署 IIS + iisnode**
登入：AD 帳號密碼（`GscSystem.dbo.ADServerInfo`）或入口網站同步登入（`SyncLoginInfo`，系統代碼 `SYNC_PARAGRAM`）

## 頁面

| 頁面 | 內容 |
|---|---|
| 流量總覽 | 期間內 KPI（連線、允許 / 阻擋、流量）、每小時連線數 / 流量、來源 / 目的 IP、App、Port、區域流向、國家排行、被擋排行、外部（公網）被擋來源與允許連入、高風險 App、規則命中、疑似掃描來源；**資料外流與 AI 應用**（上傳到外部最多的內部 IP、高風險管道上傳的內部 IP 與所用 App、上傳管道排行、上傳最多的外部目的地、使用 AI 應用的內部 IP 與所用 AI、AI 應用排行；上傳 = 內部 IP → 公網 IP 允許連線的送出位元組，管道 / AI 依 PA App-ID 子分類）；點任一項 → 明細查詢 |
| 安全事件 | PA-560 TRAFFIC 以外的 log，每種一個分頁：**威脅**（`/threat`，IPS / 防毒 / 間諜軟體，嚴重度、威脅名稱、critical / high 清單、外部來源）、**URL 過濾**（`/url-filtering`，網站、類別、被擋的網站）、**資料過濾**（`/data-filtering`，檔案類型、上傳的檔案）、**WildFire**（`/wildfire-submissions`，送檢檔案與判定）、**解密**（`/decryption`，TLS 解密失敗原因）、**GlobalProtect VPN**（`/globalprotect`，登入失敗的外部 IP / 帳號 / 原因）、**User-ID**（`/user-id`，IP ↔ 帳號）。與 TRAFFIC 相同從 FTP 串流讀取、原始 log 不存本機，只存摘要 + 每小時依 IP 累計的組合（`uploads/palogs/events/`，`lib/paevents.js` 定義欄位與排行、`lib/paevimport.js` 匯入）；次數乘上 Repeat Count。AI 問答有 IP 時一併帶入這些 IP 在各類型 log 的紀錄，問到威脅 / VPN / 網站等關鍵字時帶期間摘要；AI 分析也會參考。點排行中的 IP → 帶到 AI 問答 |
| AI 問答 | 用問句查問題，例如「10.10.112.1 連到 10.10.130.154 被擋，幫我查看問題」：從問題抓出 IP / Port → 掃描期間內的 log、彙整這些 IP 的連線組合 / 規則 / 結束原因 / 時段 / 範例 → 連同問題送內部 AI 判斷原因與處理方式；可追問（沒寫 IP 沿用上一題），同條件 10 分鐘內不重複掃描。**連線組合統計**：分析每個檔案時順便依「小時 × 來源 → 目的:協定/Port × 動作 × 規則 × App × 區域 × NAT × 目的國家」累計次數 / 流量 / 時間 / 結束原因，存 `uploads/palogs/flows/*.tsv.gz`（只有統計、沒有逐筆明細，原始 log 仍不存本機；一個 6.5 萬列的檔約 6,600 組合、0.13 MB）。問答優先查統計（一天約 1～2 秒），還沒有統計或組合超過 40 萬的檔案才從 FTP 掃原始 log；統計模式沒有逐筆範例、時間以小時為單位 |
| 知識庫 | 管理者在 AI 問答輸入「請記錄：…」或按「記錄到知識庫」，AI 把說明整理成筆記存成 `.md`；每次新增 / 修改 / 刪除都重新產生匯整檔 `uploads/knowledge/_knowledge-all.md`（目錄 + 全部筆記，依 IP 排序），AI 問答 / 分析直接送這份，並在開頭標出與問題 IP（含網段）相關的筆記編號；匯整檔超過 `KB_MAX_CHARS` 時才改為逐則挑選。可查詢、檢視、修改、下載 .md、刪除（新增 / 修改 / 刪除限 `KB_ADMINS`） |
| 外部 IP 自動學習（知識庫頁） | 最近 `IPLEARN_DAYS` 天 PA 摘要裡的公網 IP（10.10、172.16、172.20 與其他私有 IP 除外；連往的目的、被擋、上傳目的、外部連入）→ 查 IP 登記處 RDAP（ARIN / APNIC / RIPE / LACNIC / AFRINIC，rdap.org 會 403 所以直接查）+ DNS 反查 → 依組織分組，交給 .45 AI 整理成筆記（作者「AI 自動學習」、標籤「自動學習」，ips 填網段），同組織只有一則、學到新 IP 會更新。狀態存 `uploads/palogs/iplearn.json`：查過的 IP `IPLEARN_TTL_DAYS` 天內不重查、落在已查過的網段內不再查 RDAP、管理者手寫筆記已涵蓋的 IP 略過；刪掉的自動筆記下次學到該組織會重建。每天 `IPLEARN_HOUR` 點自動跑，管理者可在知識庫頁手動執行。不抓 Google 搜尋（會被擋、違反使用條款）；伺服器要能連外 HTTPS（443）與 DNS 反查 |
| 知識庫向量資料庫 | 每則筆記寫進 10.10.130.46 的 Qdrant（collection `NetOpsKb`，4096 維 Cosine），向量用 10.10.130.45:8081 的 Qwen3-Embedding-8B；筆記新增 / 修改 / 刪除後 3 秒自動同步（內容沒變不重算），啟動時與每 30 分鐘全部比對。AI 問答 / 分析用問題做語意搜尋，最相近的筆記（≥ 0.68 且與最高分差 0.02 內）標為相關；知識庫頁可勾「語意搜尋」。實測：向量只放標題 / 標籤 / 內容（不放 IP 清單）、查詢不加 Instruct 前綴、算向量前拿掉問題中的 IP，效果最好（`scripts/vec-probe.mjs`）。連不到 Qdrant 時照常用關鍵字 / IP 比對 |
| AD 登入失敗原因 | AD 事件總覽的失敗原因可點 → Log 明細查詢（4625 / 4771 / 4740 / 4776 + 原因代碼），每個原因下列出前 5 個來源 IP 與帳號 |
| 翻譯 | AI 問答、AI 分析的每個回答都有「翻譯」（English / 日本語 / ภาษาไทย / 繁中），與 AiService 會議翻譯相同：.45 Qwen 關閉思考 + 翻譯專用提示 |
| Veeam 備份監控（選單「其他系統」） | 同步登入跳轉：寫一筆同步碼到 `PortalSolar.dbo.SyncLoginInfo`（`SyncParagram=Veeam`），開啟 `{VEEAM_URL}/SyncLogin?SyncCode=…`；失敗時改開 Veeam 登入頁 |
| Log 明細查詢 | 依時間 + 條件（IP 支援 `10.10.124.*`、`10.10.0.0/16`）從 FTP 即時篩選，最多 2000 筆，可匯出 CSV |
| FTP Log 檔案 | 瀏覽 FTP（PA traffic 在 `/my-data`）、同步 / 分析選取 / 刪除分析結果、分析進度；檔案在 FTP 上搬到別的資料夾時，同名同大小沿用原分析結果 |

### AD 網域（選單「AD 網域」）

GSMC-DC1 每天由 `scripts/dc/ADLog-FtpBackup-3.ps1`（排程在 DC 上執行）匯出前一天的事件到 FTP `/AD_Log_Backup/yyyyMMdd/`：Security（只匯出稽核需要的 23 種事件）、System、Directory_Service、DNS_Server，檔名帶 DC 名稱（`Security_GSMC-DC1.csv`），多台 DC 可共用同一天的資料夾。系統匯入到 `uploads/adlogs/yyyyMMdd.json`（與 PA 共用 `FTP_SYNC_MINUTES` 自動同步；同一天新舊檔名並存時依主機 + 記錄 + 記錄編號去除重複）。

| 頁面 | 內容 |
|---|---|
| AD 事件總覽 | 統計（錯誤、警告、登入失敗、特權異動、帳號鎖定）、**帳號與特權異動**（建立 / 刪除 / 停用帳號、重設密碼、加入或移出群組；Domain Admins、Administrators 等標【特權】，新建帳號隨即加入特權群組另外警示）、特權登入 4672、需要注意的事件、事件排行、登入失敗的帳號 / IP / 原因（Kerberos 錯誤碼與 NTSTATUS 換成中文）；點一列帶條件到明細查詢 |
| AI 問答 | 與防火牆的 AI 問答共用頁面（`source: 'ad'`），只看 AD 事件；問題中的帳號（工號）、IP、事件 ID 會列出相關事件明細；對話與防火牆分開保存 |
| Log 明細查詢 | 依時間（到分鐘）、記錄、等級、事件 ID、帳號、IP、關鍵字查詢，展開看完整訊息，可匯出 CSV |
| FTP Log 檔案 | FTP 上每天的資料夾與檔案、匯入狀態（未匯入 / 已變更 / 已匯入 / FTP 上已無）、同步、重新匯入、刪除匯入結果；Security 檔案是空的會提醒 |

Security 記錄在 DC 上容量太小時，隔天凌晨匯出前一天的事件會已被覆蓋（Security 檔案是空的）；v3 匯出程式會在 `C:\ADLogBackup\Backup-Execution.log` 記錄最舊事件的時間並寫 WARN，請加大 DC 的 Security 記錄上限。

## PA log 資料流程

PA-560 每天把前一天的 TRAFFIC log 以 WebUI CSV 匯出到 FTP（`10.10.130.66`，檔名 `PA-560_traffic_<匯出日>_last_calendar_day_<序號>.csv`，每檔 65,535 列、約 40 MB，一天約 150 檔 / 6 GB）。

1. **同步**：`FTP_LOG_DIR` 裡符合 `FTP_PATTERN` 的新檔 / 已變更檔，以及威脅、URL 等其他類型目錄的 .csv 加入分析（`FTP_SYNC_MINUTES` 自動執行，或按「同步新檔案」；其他類型用 1 條 FTP 連線依序分析）
2. **分析**：透過 FTP 串流讀取（**原始 log 不存本機**），每檔算出摘要存到 `uploads/palogs/summaries/*.json`（約 50 KB），狀態在 `uploads/palogs/index.json`；一檔約 2 秒，`FTP_PARALLEL` 條連線同時進行
3. **總覽**：合併期間內的摘要，資料日期依 log 內的 Receive Time（不是檔名日期）
4. **明細查詢**：依摘要記錄的每檔時間範圍挑出檔案，再從 FTP 串流逐列篩選

5. **AI 分析**（總覽頁右上）：把期間內的摘要整理成約 1 萬字的統計文字，加上前一段同長度期間的比較，送到公司內部 vLLM（`LLM_URL`，10.10.130.45）串流回傳；只送統計，不送原始 log。可輸入想特別了解的問題。送出的內容可用 `GET /api/ai/context?from=yyyy/MM/dd&to=yyyy/MM/dd` 檢查。AI 結果不存檔。

6. **AI 問答**（`POST /api/ai/ask`，`server/lib/evidence.js`）：問題裡的 IP / Port 變成篩選條件，掃描時先用整列文字快速排除不含該 IP 的列（`buildPrefilter`），一整天 739 萬列約 40 秒；彙整結果約數千字送 AI。問題沒有 IP 時改用期間統計摘要回答。

分析後的資料都在 `PA_DATA_DIR`（預設 `uploads/palogs`）：`index.json` 與 `summaries/*.json`，一檔約 45 KB（427 檔約 18 MB）。

調整研判邏輯（`server/lib/palog.js` 的 `createSummary`）後，把 `SUMMARY_VERSION` 加 1，已分析的檔案會變成「已變更」並在下次同步時重新分析。

欄位依 CSV 標題列對應（`COLUMNS`），PAN-OS 版本不同欄位順序改變也能讀；`.gz` 自動解壓。

## 開發

```bash
npm install
npm run dev:all        # API http://localhost:3081/api、頁面 http://localhost:5281
```

- Port：ERMS 3001、SolarMES 3011、SolarDMA 3021、E-Learning 3031、Veeam 3043、**NetOps 3081**（前端 5281）
- 不經 AD 測試：`node --env-file=server/.env.development scripts/dev-token.mjs S1234567`，
  瀏覽器 console 執行 `localStorage.setItem('netops-token', '<token>')`
- 測試 FTP：`node scripts/ftp-probe.mjs`；統計目錄 / 看檔頭：`node scripts/ftp-peek.mjs`；分析單一檔案：`node scripts/palog-test.mjs /檔名.csv`
  （Git Bash 執行時路徑參數前加 `MSYS_NO_PATHCONV=1`，否則 `/` 會被轉成 Windows 路徑）
- 換配色：`npm run dev` 後開 `http://localhost:5281/__themes`

## 設定（server/.env，範本 server/.env.example）

| 參數 | 說明 |
|---|---|
| `DB_USER` / `DB_PWD` | 登入驗證用：跨庫讀 `LOS.dbo.EmployeeInfo`、`GscSystem.dbo.ADServerInfo`、`PortalSolar.dbo.SyncLoginInfo` |
| `VIEW_USERS` / `VIEW_DEPTS` | 可使用的工號 / 部門代號（逗號分隔）；兩個都空白 = 所有在職員工 |
| `FTP_HOST` / `FTP_USER` / `FTP_PWD` | PA log 的 FTP；**密碼含 `#` 要用引號包住**（`FTP_PWD='ab#cd'`），否則 `#` 後面會被當成註解 |
| `FTP_ROOT` | 畫面上可瀏覽的範圍 |
| `FTP_LOG_DIR` / `FTP_PATTERN` | 同步的目錄與檔名規則（正規表示式） |
| `FTP_THREAT_DIR` / `FTP_URL_DIR` / `FTP_DATA_FILTER_DIR` / `FTP_WILDFIRE_DIR` / `FTP_DECRYPTION_DIR` / `FTP_GLOBALPROTECT_DIR` / `FTP_USERID_DIR` | 其他類型 log 的 FTP 目錄（預設 `/threat`、`/url-filtering`、`/data-filtering`、`/wildfire-submissions`、`/decryption`、`/globalprotect`、`/user-id`），設成 `-` 表示不匯入 |
| `FTP_SYNC_MINUTES` | 自動同步間隔（分鐘），0 = 只手動 |
| `FTP_PARALLEL` | 同時分析的 FTP 連線數（1~6） |
| `FTP_AD_DIR` / `AD_DATA_DIR` | AD 事件記錄的 FTP 目錄（預設 `/AD_Log_Backup`）與匯入後的存放位置（預設 `uploads/adlogs`） |
| `PA_DATA_DIR` | 摘要存放位置（預設 `uploads/palogs`，不隨發佈覆蓋） |
| `PA_SEARCH_LIMIT` / `PA_SEARCH_SECONDS` | 明細查詢上限筆數 / 秒數 |
| `LLM_URL` / `LLM_MODEL` / `LLM_TIMEOUT_MS` | AI 分析用的內部 vLLM；模型空白 = 自動取第一個 |
| `KB_DIR` / `KB_ADMINS` / `KB_MAX_CHARS` | 知識庫 .md 存放位置（預設 `uploads/knowledge`，不隨發佈覆蓋）、管理者工號（空白 = `VIEW_USERS`）、每次送給 AI 的筆記字數上限 |
| `QDRANT_URL` / `QDRANT_API_KEY` / `QDRANT_COLLECTION` / `EMBED_URL` | 知識庫向量庫（.46 Qdrant，API key 在 .46 `/home/giga/qdrant/config.yaml`）與 embedding 服務；`QDRANT_URL` 空白 = 不使用。開發機被 PA 擋，`.env.development` 走 SSH tunnel：`ssh -N -L 16333:localhost:6333 -L 18081:10.10.130.45:8081 giga@10.10.130.46`；正式主機要能連 .46:6333 與 .45:8081 |
| `IPLEARN_HOUR` / `IPLEARN_DAYS` / `IPLEARN_MAX` / `IPLEARN_TTL_DAYS` | 外部 IP 自動學習：每天幾點跑（預設 3，-1 = 不自動）、看最近幾天的 log（7）、一次最多查幾個新 IP（150）、查過的 IP 幾天內不重查（90） |
| `LLM_MODEL` | 問答模型，固定 `Qwen3.6-35B-A3B-FP8`（.45 上還有 8081 embedding、8082 qwen2.5-coder、11434 Ollama，不要自動挑到別的） |
| `TRANSLATE_URL` / `TRANSLATE_MODEL` | 翻譯用；空白 = 沿用 `LLM_URL` / `LLM_MODEL` |
| `VEEAM_URL` / `VEEAM_SYNC_PARAGRAM` | 選單跳轉 Veeam 的網址與同步登入系統代碼 |
| `JWT_SECRET` | 本系統專用，不要和其他系統共用 |

## 部署到 IIS

```bash
npm run publish        # 產生 publish/（第一次加 -- --install 一併安裝 node_modules）
```

把 `publish/` 全部內容複製到 IIS 應用程式 `/NetOps` 的實體路徑；IIS 需安裝 iisnode 與 URL Rewrite。
自動同步在 Node 程序內執行：IIS 應用程式集區閒置逾時會停止 Node，要自動同步請把集區「閒置逾時」設為 0、啟動模式設為 AlwaysRunning（或由排程呼叫 `POST /NetOps/api/ftp/sync`）。
