# NetOps AI 功能盤點(舊版 IIS ↔ 新版 A1)

> 2026-11-06 需求方要求「AI 重新盤點新舊功能差異,功能不用全部搬」。本文件列出舊版每個 AI 功能在新版 A1(NetOps !34 核心、!35 API、!36 前端)的狀態、成本、風險與建議,**由需求方決定哪些不搬**;決定後再從 !35 / !36 拿掉,這份文件不改程式。
> 決策見 [ARCHITECTURE.md](ARCHITECTURE.md) D23、D25;API 見 [API.md](API.md) §10;工作項目見 IMPL-PLAN A1。

## 1. 已定案(需求方 2026-11-06)

| # | 項目 | 決定 |
| --- | --- | --- |
| 1 | 權限範圍 | 維持一個 `netops.ai.use`,不拆 PA / AD(D25) |
| 3 | 向量同步、外部 IP 自動學習 | 舊版 IIS 停用後才開:測試區一直關;正式區在 A1 上線、舊版 IIS 停用時才開 `VECTOR_SYNC=1` 與 `IPLEARN_HOUR=3`。預設值維持關閉(D25,§4 切換步驟) |
| 4 | 送給模型的逐筆資料 | 接受,照舊版:問答最多 15 筆範例紀錄、AD 事件訊息前 400 字。記為 AGENT.md §7.4 的例外(D25) |

## 2. 盤點表

舊版位置:`server/routes/ai.js`(`/api/ai/*`)、`server/routes/kb.js`、`server/lib/{evidence,llm,vector,iplearn,kb}.js`、畫面 `src/views/{PaAsk,PaDashboard,PaEvents,Knowledge}.vue`、`src/components/{AiAnalysis,TranslateBox}.vue`、選單 `src/router/menu.js`。

「拿掉的成本」是決定不搬時,從 !35 / !36 移除要做的事(程式、測試、API.md、OpenAPI、Gherkin、`gateway-rbac.yaml`)。

| # | 功能 | 舊版位置 | 新版狀態 | 搬移 / 維持成本 | 風險 | 建議 | 理由 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **AI 期間分析** | `POST /ai/analyze`;總覽頁「AI 分析」(`PaDashboard.vue` → `AiAnalysis.vue`) | 已搬(`POST /ai/analyses` SSE;總覽頁對話框,按鈕 `netops.pa-dashboard.ai`) | 已完成;拿掉約半天 | 低:只送統計摘要與知識庫;模型輸出可能含外部可控文字(已:外部連結不能點、不顯示圖片) | **搬** | 舊版的主要 AI 功能;只送統計,風險最低 |
| 2 | **AI 問答(PA)** | `POST /ai/ask`(`source: pa`);選單「防火牆 › AI 問答」(`PaAsk.vue`) | 已搬(`POST /ai/questions` SSE;`/netops/firewall/ask`) | 已完成;核心最大(evidence、連線組合、FTP 掃描、PA 其他 log、AD、知識庫) | 中:有 IP 時從 FTP 掃原始 log(已:全系統一次一個、31 天上限);送 15 筆範例(D25 接受) | **搬** | 「為什麼被擋」是網通日常查問題的主要入口,舊版也導向這裡(安全事件點 IP) |
| 3 | **AI 問答(AD)** | 同一支 API `source: ad`;選單「AD 網域 › AI 問答」(`PaAsk.vue` props) | 已搬(同頁面 `/netops/ad/ask`) | 已完成;與 PA 共用,拿掉只省選單與按鈕 | 低:只讀已匯入的 AD 事件;送訊息前 400 字(D25 接受) | **搬** | 與 PA 共用程式,邊際成本近零 |
| 4 | 安全事件點 IP → AI 問答 | `PaEvents.vue` 排行點選 | 已搬(帶問題到新版問答,由使用者送出) | 已完成 | 低:只預填 | **搬** | 只是入口 |
| 5 | **翻譯** | `POST /ai/translate`;`TranslateBox.vue`(問答、分析下方) | 已搬(`POST /ai/translations` SSE;最多 12 段、同時 3 段) | 已完成;拿掉約 2 小時 | 中低:有 `ai.use` 的人可翻任意文字(30,000 字內),等於一個通用模型代理;佔 AI 主機 | **搬,或確認沒人用就不搬** | 舊版有泰文、日文,可能是給海外廠區或外籍同仁看;實際使用量要看舊版(§3) |
| 6 | **整理筆記(請 AI 記錄)** | `POST /ai/note`;問答頁「記錄到知識庫」與「請記錄:…」 | 已搬,**直接寫入知識庫**(同舊版;`POST /ai/notes`,`netops.kb.write`) | 已完成;改草稿約半天到 1 天;拿掉約半天 | **高**:回答與對話可能夾帶外部可控文字(log 的 URL、RDAP、PTR),記錄後進入之後**所有人**的分析與問答;模型整理時可能扭曲管理者原意 | **改做法:先回草稿,管理者確認後才存**(§2.1) | 保留便利、加一道人工確認,影響最小 |
| 7 | **語意搜尋** | `GET /kb?semantic=1`(知識庫頁勾選);問答 / 分析內部也用 `searchVectors` 挑相關筆記 | 已搬(`GET /kb/semantic-search`;問答 / 分析內部同舊版) | 已完成 | 低;**限制**:`VECTOR_SYNC=0` 期間向量庫是舊版的內容,只回新版也存在的筆記;測試區知識庫是空的,搜尋不會有結果 | **搬** | 問答挑筆記也靠它;關閉只會讓相關筆記排序變差 |
| 8 | **向量同步** | 筆記異動 3 秒後、啟動、每 30 分鐘;`POST /kb/vector-sync`(管理者) | 已搬,預設關閉(`VECTOR_SYNC=0`);開啟時有刪除安全閥 | 已完成 | 中:與舊版共用 `NetOpsKb`,兩邊都同步會互刪(所以 D25 等舊版停用才開) | **搬(D25 時機開啟)** | 沒有同步,新版新增的筆記永遠搜尋不到 |
| 9 | **外部 IP 自動學習** | 每天 `IPLEARN_HOUR` 點;知識庫頁手動執行(`GET/POST /kb/learn-ips`) | 已搬,預設不自動(`IPLEARN_HOUR=-1`);知識庫頁可手動 | 已完成;拿掉約半天 | 中:RDAP / PTR 是外部可控文字(已:清理欄位、限長度;模型 key 限本批;管理者改過的筆記不覆寫;上限 1,000 則),自動寫入知識庫;連外 RDAP(LACNIC、AFRINIC 從主機 2 逾時) | **搬(D25 時機開啟)**;可考慮改成只寫「待確認」標籤 | 說明外部 IP 是誰對判讀有幫助;自動筆記已標「自動學習」、可信度低於手寫 |
| 10 | AI 服務狀態 | `GET /ai/status`(回傳 `LLM_URL`) | 已搬(不回主機位址) | 已完成 | 低 | **搬** | 畫面依此顯示 AI 是否可用 |
| 11 | 送給 AI 的資料預覽 | `GET /ai/context`(開發用,回純文字) | **沒搬** | — | 中:會回期間統計全文 | **不搬** | 開發除錯用;新版有單元測試比對內容 |
| 12 | 獨立翻譯模型 | `TRANSLATE_URL` / `TRANSLATE_MODEL` | **沒搬**(沿用 `LLM_URL` / `LLM_MODEL`) | — | — | **不搬** | 2026-11-04 決定翻譯沿用主要模型 |
| 13 | 向量效果測試腳本 | `scripts/vec-probe.mjs` | **沒搬** | — | — | **不搬** | 一次性的調校工具;結論已寫進 `kb/core/vector.js` 註解 |
| 14 | 總覽頁「AI 應用」排行 | `PaDashboard.vue`(PA App-ID 子分類 artificial-intelligence) | B2 已搬(不是 AI 功能) | — | — | (非本次範圍) | 只是流量統計,列出避免混淆 |

### 2.1 整理筆記的三個選項

| 選項 | 做法 | 影響 | 成本 |
| --- | --- | --- | --- |
| A. 照舊直接寫入(目前 !35 / !36) | 模型整理後立即存成筆記 | 最方便;外部可控文字或模型誤解會**直接**進知識庫,之後所有人的分析都會參考,出錯時要有人發現並手動刪除。舊版也是這樣,限 `KB_ADMINS`(舊版設定空白時等於全部可用的人,README「設定」) | 0 |
| **B. 先回草稿(建議)** | `POST /ai/notes` 改回 `done: { draft }`(標題、IP、標籤、內容),**不寫入**;前端用知識庫頁既有的「新增筆記」編輯框預填草稿,管理者看過、可修改,按儲存才走既有的 `POST /kb/notes` | 多按一次「儲存」;寫入路徑只剩人工確認的 `POST /kb/notes`(稽核、驗證、記錄人都沿用);`/ai/notes` 變成不寫入的 API,權限可降為 `netops.ai.use`(仍只顯示給有編輯權限的人) | 後端約 2 小時(拿掉 `saveNote`、改回應與測試、API.md、Gherkin);前端約半天(問答頁開編輯框、知識庫頁共用編輯元件) |
| C. 不搬 | 拿掉 `/ai/notes` 與問答頁的「記錄到知識庫」 | 管理者要自己到知識庫頁寫筆記;問答時想到的知識比較不會被記下來,知識庫累積變慢 | 約半天(移除程式、測試、文件、`NOTE_RE`) |

建議 B:保留「問完順手記下來」的流程,同時讓每一則進知識庫的內容都經過人看過。自動學習(#9)不在此列,它沒有人在場,由「自動學習」標籤與較低可信度處理。

## 3. 舊版實際使用情況(未查到)

只能唯讀查詢,但**舊版 IIS 的主機與實體路徑沒有文件記載**(HANDOFF 待確認 d:舊版正式網址仍未確認),本次查不到舊版的使用量:

- 測試區新版資料目錄(主機 2 `/srv/giga-netops/test`,2026-11-06 唯讀):知識庫 0 則、沒有 `iplearn.json`(新版還沒有使用資料,不能代表舊版)。
- 開發機的舊版 checkout 沒有 `uploads/`。
- Qdrant `NetOpsKb` 的筆數需要 API Key,AI 不讀機密,未查。

需求方或負責人在舊版主機唯讀查下列項目,就能判斷 #5、#6、#9 的實際使用量(不需要讀筆記內容):

| 要看的 | 位置(舊版 `uploads/`) | 判斷 |
| --- | --- | --- |
| 筆記總數、作者為「AI 自動學習」的則數 | `knowledge/*.md` 的 `author:` | 自動學習的比重 |
| `source:` 有值的筆記數與最近日期 | `knowledge/*.md` | 「請 AI 記錄」的使用頻率(只有 AI 記錄的筆記有原文) |
| 外部 IP 學習的執行紀錄 | `palogs/iplearn.json` 的 `runs`(最近 30 次:時間、觸發者、寫入則數) | 自動學習是否在跑、產出多少 |
| 向量筆數 | `curl -H "api-key: …" http://10.10.130.46:6333/collections/NetOpsKb` 的 `points_count` | 與筆記數是否一致 |
| AI API 呼叫次數 | IIS log(`/NetOps/api/ai/translate`、`/ai/note`、`/ai/ask`、`/ai/analyze` 的筆數) | 翻譯、整理筆記是否有人用 |

## 4. 向量同步與外部 IP 自動學習的切換步驟(D25)

測試區維持 `VECTOR_SYNC=0`、`IPLEARN_HOUR=-1`(compose 預設)。正式區在 **A1 上線、舊版 IIS 停用**時(IMPL-PLAN D2 / A1 第 5 步):

1. 舊版 IIS 停止(或至少停用舊版的向量同步與自動學習:舊版 `server/.env` 的 `QDRANT_URL` 清空、`IPLEARN_HOUR=-1` 後重啟)。舊版停用前不可開新版同步(兩邊會互刪向量)。
2. 確認新版正式區知識庫已是最新(D14 複製舊版 `uploads/knowledge` 之後,舊版沒有再寫入)。
3. 主機 3 的 `netops.env` 加 `VECTOR_SYNC=1`、`IPLEARN_HOUR=3`,重建 `netops-api` 容器。
4. 確認:`GET /api/netops/kb/vector-status` 的 `sync` 為 true,5 秒後 `lastSync` 更新、`error` 空白;刪除數量若超過安全上限會停止並寫在 `error`,先確認知識庫資料目錄再處理。
5. 隔天確認 `GET /api/netops/kb/ip-learning` 的 `lastRun` 為 03:00「每日自動」。
6. 舊版 `iplearn.json` 要不要一併複製(`palogs/iplearn.json`,同位置):複製可避免重查已查過的 IP;不複製會重新查一輪 RDAP(約 150 個 IP、數分鐘)。
