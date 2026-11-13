# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。

## 2026-11-13 AI 改用 ClickHouse、PA 頁面 AI 功能、IP 對照表(規劃)
- 工作項目:AC1–AC7(新階段)
- 內容:需求方決定 AI 分析 / 問答 / 外部 IP 學習改查 ClickHouse、解密等在對帳後自動同步、PA 頁面新增 6 項 AI 功能、新增 IP 對照表(IP 自動帶出名稱)。只寫計畫,未改程式。
- 檔案:`docs/IMPL-PLAN.md`(AC)、`docs/ARCHITECTURE.md`(D44、D45、Q8)、`docs/HANDOFF.md`
- 驗證:文件變更,無程式測試

## 2026-11-13 對帳 08:10、自動補漏(FTP 只保留 10 天)
- 工作項目:C3
- 內容:需求方決定 FTP 只保留 10 天、對帳改每天 08:10、對帳發現缺口自動補漏(可用環境變數關閉,超過 FTP 保留期限仍有缺口記 warn)。細節見 API.md §5.3、ARCHITECTURE D43。
- 檔案:見後端修改紀錄

## 2026-11-13 Log 明細查詢加威脅 log(V-b2 驗收 C7 第二輪)
- 工作項目:V-b2 驗收追加
- 內容:需求方決定 Log 明細查詢可查威脅 log(類型、威脅名稱、嚴重度)、國家分來源 / 目的、流量類抽屜不顯示嚴重度、私有網段不當國家(C7b)。細節見 API.md §4.3、IMPL-PLAN「V-b2 驗收追加」。
- 檔案:見後端與前端修改紀錄
- 驗證:見 MR

## 2026-11-13 C3–C5、V-a / V-b 測試區收尾
- 工作項目:C1–C5、V-a、V-b
- 內容:IMPL-PLAN 狀態更新(C1–C5、V-a 測試區完成,V-b 上線待畫面驗收);HANDOFF 新增「2026-11-13」:本批合併、部署與資料回填、待測與觀察清單、後續工作
- 檔案:`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`

## 2026-11-12 C5 PA 精準查詢
- 工作項目:C5(D31、CQ6、CQ7;E4 結果)
- 內容:PA 精準查詢 API(`/pa-query/status`、`/pa-query/jobs`)、權限 `netops.pa-query.read`(只給 netops-admin)、按鈕 `netops.pa-live.query`;API.md §2、§3.3、§8;Gherkin `pa-query/query.feature`;PA-LIVE-PLAN §4 鍵表;HANDOFF-GEMINI-VIZ §10
- 檔案:`docs/{API,IMPL-PLAN,PA-LIVE-PLAN,PROJECT-MAP,HANDOFF-GEMINI-VIZ}.md`、`docs/Gherkin/`

## 2026-11-11 C3:PA 查詢只用 ClickHouse(推翻並行 2 週)
- 工作項目:C3
- 內容:需求方決定捨棄 FTP 查詢路徑、對帳改 01:00;ARCHITECTURE D43;API.md §4.1–§4.3、§5.3、§8;Gherkin `pa/overview.feature`、`pa-events/overview.feature`、`pa-log-searches/search.feature` 改寫;IMPL-PLAN、HANDOFF。
- 檔案:`docs/{API,ARCHITECTURE,IMPL-PLAN,HANDOFF,PROJECT-MAP}.md`、`docs/Gherkin/`

## 2026-11-11 V-a 熱力圖資料層
- 工作項目:V-a(第 1–4、6 步;第 5 步冷路由等 C4)
- 內容:活動熱力圖 API(年 / 月 / 日,traffic / deny / threat,`ad` 回 409 預留)與時段明細 API(30 秒同步、超過轉工作、熱 / 冷分界;冷歸檔未提供回 409 `NETOPS_COLD_ARCHIVE_DISABLED`,冷查詢鎖 429 介面已保留);API.md §4.4、§8;Gherkin `pa/heatmap.feature`;PA-LIVE-PLAN §4 加 `netops:cold:lock`、快取 `pa-heat` / `pa-slice`
- 檔案:`docs/{API,IMPL-PLAN,PA-LIVE-PLAN,PROJECT-MAP}.md`、`docs/Gherkin/{pa/heatmap.feature,README.md,check-scenarios.mjs}`

## 2026-11-11 C3 查詢切換(第 3 批:FTP 對帳與補漏)
- 工作項目:C3
- 內容:FTP 與 ClickHouse 每日對帳(每小時筆數,0.5% 門檻)與手動補漏 API;API.md §5.3、§8;ARCHITECTURE D33 補實作方式;PA-LIVE-PLAN §4 加 `netops:cache:*`、`netops:backfill:*`;Gherkin `ftp/pa-recon.feature`(畫面不在這次,補在 MR 給 Gemini 的待辦)。
- 檔案:`docs/{API,ARCHITECTURE,IMPL-PLAN,PA-LIVE-PLAN,PROJECT-MAP}.md`、`docs/Gherkin/ftp/pa-recon.feature`

## 2026-11-11 C3 查詢切換(第 2 批:Log 明細)
- 工作項目:C3
- 內容:Log 明細查詢可查 ClickHouse(`source`,預設仍 FTP;並行對帳 2 週無未處理缺口後由需求方把 `NETOPS_PA_DETAIL_SOURCE` 改 auto);API.md §4.3;Gherkin `pa-log-searches/search.feature` 加 C3 場景;前端 `api/pa.ts` 的 `PaSearchBody`、`PaSearchResult` 加 `source`(畫面不改)。
- 檔案:`docs/{API,IMPL-PLAN}.md`、`docs/Gherkin/pa-log-searches/search.feature`、`frontend/src/api/pa.ts`

## 2026-11-11 C3 查詢切換(第 1 批:總覽與安全事件)
- 工作項目:C3
- 內容:流量總覽、篩選選項、安全事件(威脅、URL、資料過濾、WildFire)可查 ClickHouse,API 多 `source`、`topsUntil`,其他欄位不變;ARCHITECTURE 新增 D42(ClickHouse 每小時摘要);API.md §4.1、§4.2、§8;Gherkin `pa/overview.feature`、`pa-events/overview.feature` 加 C3 場景;前端 `api/pa.ts`、`api/paEvents.ts` 加 `source` 參數與型別(畫面不改)。
- 檔案:`docs/{API,ARCHITECTURE,IMPL-PLAN,PROJECT-MAP}.md`、`docs/Gherkin/`、`frontend/src/api/{pa,paEvents}.ts`

## 2026-11-11 熱力圖、儀表板與偵測規則引擎規劃(V-a–V-d)
- 工作項目:V-a、V-b、V-c、V-d(規劃)
- 內容:需求方 2026-11-11 提出 GitHub 風格熱力圖、冷熱資料反查、ECharts 儀表板、動畫與偵測規則引擎,並決定 V1–V10。新增設計文件(DDL、API、規則 1–7、元件介面、資源估算、待決 X1–X16)與給 Gemini 的交接規格;ARCHITECTURE 新增 §3.2 D34–D41、§5 權限節點、Q7;IMPL-PLAN 新增 V-a–V-d。熱力圖每小時 / 每天彙總保留 5 年、每 5 分鐘 1 年,和 CQ12(分維度每小時彙總 13 個月)的差異是需求方 2026-11-11 改的。只改文件,API.md 在實作 MR 才改。
- 檔案:`docs/VIZ-RULES-DESIGN.md`、`docs/HANDOFF-GEMINI-VIZ.md`、`docs/{ARCHITECTURE,IMPL-PLAN}.md`

## 2026-11-10 C1 ClickHouse POC 與容量實測
- 工作項目:C1
- 內容:測試區 ClickHouse 容器與資料表(細節見 BackendCorrection 同日紀錄);匯入 FTP 一整天 TRAFFIC 實測容量與查詢,手冊 §4 換成實測值(每筆 20.6 bytes、30 天約 7–11 GB、Parquet 一年 80–122 GB),§7.1 `dst` 加 bloom_filter、§7.4 網段查詢改 `BETWEEN`、§10.2 補實作差異、§10.3 TTL 定案;IMPL-PLAN C0 補 E2 / E5 建議數字、C1 狀態。
- 檔案:`docs/test-reports/2026-11-10-clickhouse-c1.md`、`docs/{IMPL-PLAN,PA-LOG-CLICKHOUSE-GUIDE,HANDOFF,PROJECT-MAP}.md`

## 2026-11-10 PA log 高吞吐架構決策核准(ClickHouse,CQ1–CQ14)
- 工作項目:C0–C6
- 內容:需求方 2026-11-10 核准 !52 手冊 §12 的 14 項決策(原話「全部照建議」)。ARCHITECTURE §3.1 D27–D33 改為已核准,寫明前置條件(CQ2 正式區資源、CQ3 待 FTP 保留期限、CQ6 網通開 Log 權限、CQ9 網通改轉送格式);D16、D20、D21、D22、D26 原文保留並加註「由 D2x 修改」;§5 加按鈕 `netops.pa-live.query`、viewer 排除 `netops.pa-query.read`;Q6 結案。AGENT §0、§2、§7.2 改寫「不寫資料庫」「原始 log 不存本機」「欄位不新增」並列出例外與依據。IMPL-PLAN C0 改為外部前置事項 E1–E6(誰、做什麼),C1–C6 改為已核准並列前置與負責人。手冊 §12 加「決定」欄,威脅類 TTL 改 90 天(CQ12),權限表註明只給 admin(CQ7)。只改文件。
- 檔案:`AGENT.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/PA-LOG-CLICKHOUSE-GUIDE.md`

## 2026-11-10 R1:提高 TRAFFIC 即時 log 串流上限
- 工作項目:R1(需求方決定提高上限;細節見 BackendCorrection 同日紀錄)
- 內容:即時串流每秒檢查、每個 tick 最多讀 / 送 1500 筆(原每 2 秒 200 筆),TRAFFIC 約 120 筆/秒時畫面可看到全部。
- 檔案:`backend/src/modules/pa-live/live-routes.ts`

## 2026-11-10 R1:威脅類即時 log 帶出來源 Port
- 工作項目:R1(需求方 2026-11-10 決定補;細節見 BackendCorrection / FrontendCorrection 同日紀錄)
- 內容:威脅、URL、資料過濾、WildFire 的即時 log 新增來源 Port(`sport`)與目的 NAT Port(`natDport`)欄位,即時監控威脅表格顯示「來源 Port」。需求方須在 PA 的 HTTP Payload Format 加這兩個變數。
- 檔案:`pa-collector/netops_pa/records.py`、`frontend/src/pages/firewall/Live.vue`、`docs/PA-FORWARDING-SPEC.md`

## 2026-11-10 PA log 高吞吐架構提案(ClickHouse,待核准)
- 工作項目:C0–C6(規劃中)
- 內容:依需求方 2026-11-10 需求撰寫企劃與開發手冊 `docs/PA-LOG-CLICKHOUSE-GUIDE.md`:Syslog 即時串流 → Redis Stream(沿用)→ ClickHouse 30 天 → NAS Parquet 冷歸檔;PA SDK 只做精準查詢。容量以實測(約 1,000 萬筆 / 天)重算,主機與 NAS 資源以唯讀指令查詢;和 D20、D21、D22、D26 衝突處列為待決策 CQ1–CQ14。ARCHITECTURE 新增 §3.1 D27–D33(提案)、Q6;IMPL-PLAN 新增 C0–C6(規劃中)。只改文件,不改程式。
- 檔案:`docs/PA-LOG-CLICKHOUSE-GUIDE.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`

## 2026-11-09 R1 測試區收集器開關與 R1 安全取捨定案
- 工作項目:R1
- 內容:需求方 2026-11-09 決定:測試區要有按鈕停用 / 開啟收集器(輪詢「手動開關」);R1-1~R1-4 接受;viewer 可以匯出 Log 明細(HANDOFF j)。記為 ARCHITECTURE D26。做法:環境變數仍是總開關,按鈕只切換暫停 / 繼續(Redis `netops:pa:control`,PA-LIVE-PLAN §4);接收暫停時丟棄並計數,不關 port。IMPL-PLAN D2 加「正式區發佈 A1、R1 路由草稿」「正式區 PA 管理介面換公司 CA 憑證」。
- 檔案:`docs/ARCHITECTURE.md` D26、`docs/PA-LIVE-PLAN.md` §4、§8、`docs/PA-FORWARDING-SPEC.md` F.4.0、`docs/IMPL-PLAN.md` D2、`docs/API.md` §2、§3.2、§8、`docs/HANDOFF.md`

## 2026-11-09 A1 盤點定案:翻譯與整理筆記不搬
- 工作項目:A1
- 內容:需求方 2026-11-09 依 `docs/AI-FEATURE-INVENTORY.md` 決定:翻譯(#5)與整理筆記(#6,選項 C)不搬;外部 IP 自動學習(#9)照現在做法(直接寫入、標「自動學習」,不加「待確認」);其餘照建議。盤點文件 §1 與表格標為定案,ARCHITECTURE D25 補 ⑤,IMPL-PLAN A1 第 2、3 步拿掉翻譯與整理筆記。程式在 `fix/a1-core-trim`(核心)、`feature/a1-ai-api`(!35)、`feature/a1-ai-frontend`(!36)拿掉。
- 檔案:`docs/AI-FEATURE-INVENTORY.md`、`docs/ARCHITECTURE.md` D25、`docs/IMPL-PLAN.md` A1

## 2026-11-06 A1 決定與 AI 功能盤點
- 工作項目:A1
- 內容:記錄需求方 2026-11-06 的決定為 ARCHITECTURE D25:AI 只用一個權限 `netops.ai.use`;向量同步與每天 03:00 的外部 IP 自動學習等舊版 IIS 停用後才開(測試區一直關,預設值維持關閉,正式區切換步驟寫在盤點文件 §4);問答送給模型的 15 筆範例紀錄與 AD 訊息前 400 字照舊版,為 AGENT.md §7.4 的例外。依「功能不用全部搬」新增 `docs/AI-FEATURE-INVENTORY.md`:舊版 14 項 AI 相關功能 × 舊版位置、新版狀態、成本、風險、建議;整理筆記的三個選項(照舊直接寫入 / 先回草稿 / 不搬)。舊版主機與路徑沒有文件記載,舊版使用量未查到,文件列出要在舊版主機唯讀查的項目。本次不改程式,需求方決定後再從 !35 / !36 拿掉不搬的功能。
- 檔案:`docs/AI-FEATURE-INVENTORY.md`、`docs/ARCHITECTURE.md` D25、`docs/API.md` §10

## 2026-11-05 S0 完成:測試區驗證通過、R1 連線最長 5 分鐘
- 工作項目:S0、R1
- 內容:NetOps !32 合併部署後在測試區驗證 SSE,全部通過(不被緩衝、單一連線 375 秒不中斷、斷線重連序號接續、BFF 沒有斷路器紀錄),S0 改為完成,不改 Gateway、不改輪詢。依需求方決定:R1 單一連線最長 5 分鐘、SSE 寫法規則寫進 PA-LIVE-PLAN §7、§8;驗證路由由需求方在 GigaItApp 停用。
- 檔案:`docs/test-reports/2026-11-05-s0-sse.md`、`docs/PA-LIVE-PLAN.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`
- 驗證:Claude 內建瀏覽器(需求方登入)同源 `EventSource` 與 `fetch` 串流各一條共 6 分鐘;主機 2 唯讀 `docker logs`(BFF、`netops-api`)

## 2026-11-05 S0 串流驗證:SSE 驗證路由與腳本
- 工作項目:S0
- 內容:新增 SSE 驗證路由 `GET /api/netops/pa-live/stream-test` 與驗證腳本,作為 A1(AI 問答串流)與 R1(即時監控)的共同前提。檢查 Gateway `develop` 的 Nginx 與 BFF 後判定不需改 Gateway:Nginx 依 `X-Accel-Buffering: no` 關閉緩衝、BFF 串流轉送且 undici `bodyTimeout` 是閒置時間、斷路器只計標頭前的失敗。AGENT §7.3 加 SSE 例外說明。測試區驗證待合併部署後進行。
- 檔案:`backend/src/modules/pa-live/routes.ts`、`backend/scripts/sse-probe.mjs`、`docs/API.md` §3.1、`docs/test-reports/2026-11-05-s0-sse.md`(草稿)、`AGENT.md` §7.3、`docs/IMPL-PLAN.md`、`docs/PROJECT-MAP.md`、`docs/HANDOFF.md`
- 驗證:見 `BackendCorrection.md` 同日紀錄

## 2026-11-04 重新規劃:取消 AI 中控台、PA 即時監控、不寫資料庫
- 工作項目:S0、A1、R0–R2(新增)
- 內容:使用者與系統、網通開會後決定:取消 AI 中控台,舊版 AI 功能搬進 `netops-api`,直接呼叫 AI 主機 `10.10.130.46`(`.45` 配置相同);防火牆群組新增「即時監控」選單,用官方 pan-os-python SDK 輪詢設備狀態並接收 HTTP Log Forwarding,資料放 NetOps 自己的 Redis(log 保留 2 天);不寫入資料庫,歷史用 FTP 事後查詢;第一版只讀,封鎖 IP 排 R2。ARCHITECTURE 新增 D19–D24,改寫 D7、D8、D10、D16、D17、D18;AGENT §7.2 原始 log 規則加 Redis 例外。程式尚未改動。
- 檔案:`docs/PA-LIVE-PLAN.md`(新)、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/FLOW-ARCHITECTURE.md`、`AGENT.md`、`docs/PROJECT-MAP.md`、`docs/UI-GUIDE.md`、`docs/HANDOFF.md`
- 驗證:文件交叉引用核對;未實作。同日定案 P3–P7:主機 2 測試區容器內唯讀量測 FTP(TRAFFIC 每天約 1,000 萬筆、4.6–6.8 GB),TRAFFIC 改 Syslog、統計 1 天 / 明細 1 小時,其他類型 2 天;Redis 2 GB + RDB;沿用 Qdrant、翻譯沿用 LLM;Gateway 登記 51293 / 51294 與 Python

## 2026-11-03 收工:B2 完成、交接與待決定事項
- 工作項目:B2、D1
- 內容:B2 四批(!8–!11)合併並部署測試區,IMPL-PLAN、PROJECT-MAP、ARCHITECTURE 狀態更新為完成。HANDOFF 新增「2026-11-03 收工」:明天的合併順序、D1 下一步(跨 repo,要使用者同意)、待使用者決定的 6 件事、舊版知識庫複製前先備份。依 Gherkin 規格(!18)發現的不一致修正文件:工作上限依類型分開計算、AD 檔案清單每人保留 10 筆(API.md §1.1、§5.2);下載為 GET 不需 CSRF(IMPL-PLAN F1)。
- 檔案:`docs/HANDOFF.md`、`docs/IMPL-PLAN.md`、`docs/PROJECT-MAP.md`、`docs/ARCHITECTURE.md`、`docs/API.md`
- 驗證:對照 `develop`、各 MR 狀態與程式(`backend/src/infra/jobs/index.ts`、`backend/src/modules/pa/log-routes.ts`)

## 2026-11-03 F1 完成:文件整理
- 工作項目:F1
- 內容:依主串規則,功能 MR(!16 起)不改 PROJECT-MAP、HANDOFF、IMPL-PLAN,F1 完成後在本 MR 一次整理:專案地圖的 `frontend/` 目錄與「要改 X」、測試地圖、已知差異;IMPL-PLAN 與 HANDOFF 的 F1 狀態與 MR 合併順序。只改 F1 段落。
- 檔案:`docs/PROJECT-MAP.md`、`docs/HANDOFF.md`、`docs/IMPL-PLAN.md`
- 驗證:對照 `frontend/` 實際目錄;code-reviewer 審查

## 2026-11-03 F1 第 3 批:收尾
- 工作項目:F1
- 內容:移除 `frontend/` 的佔位頁與連線驗證卡片;舊版程式依 D12、D18 保留到舊版停用;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 2 批:知識庫
- 工作項目:F1
- 內容:知識庫改用新版畫面並串接後端;AI 相關功能連到舊版(D17);細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 2 批:Log 明細查詢
- 工作項目:F1
- 內容:防火牆與 AD 的 Log 明細查詢改用新版畫面;PA、AD 都串接後端;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 2 批:流量總覽
- 工作項目:F1
- 內容:流量總覽改用新版畫面並串接後端;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 2 批:安全事件
- 工作項目:F1
- 內容:安全事件改用新版畫面並串接後端;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 2 批:AD 事件總覽
- 工作項目:F1
- 內容:AD 事件總覽改用新版畫面並串接後端;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 2 批:FTP Log 檔案
- 工作項目:F1
- 內容:防火牆與 AD 的「FTP Log 檔案」改用新版畫面並串接後端;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 F1 第 1 批:前端框架
- 工作項目:F1
- 內容:新增 `frontend/` 框架(入口網 `src/ui/` + 工程藍主題、權限選單、應用層守衛、一般連結),頁面先佔位;細節見 `FrontendCorrection.md`。
- 檔案:`frontend/`、`.gitlab-ci.yml`、`docs/`
- 驗證:見 `FrontendCorrection.md` 同日紀錄

## 2026-11-03 B1 API 介面定稿
- 工作項目:B1
- 內容:新增 `docs/API.md`,寫完全部模組(PA、安全事件、FTP、AD、知識庫)的新路徑、權限、請求與回應格式,給 F1 前端串接。盤點舊版 41 支 API:搬移 27、移除 14(登入、跳轉、配色、AI、外部 IP 學習、向量同步)。Log 明細查詢與 AD 的 FTP 檔案清單改工作模式(D6);FTP 同步與 AD 匯入改為背景執行、回 202;時間一律 ISO 8601 含時區;清單改 `page` / `pageSize` 分頁。權限沿用 ARCHITECTURE §5,沒有新增代碼。
- 檔案:`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`
- 驗證:對照 `server/index.js`、`server/routes/*.js` 逐支盤點

## 2026-11-03 B0 測試區驗證完成
- 工作項目:B0
- 內容:NetOps !4 合併後在測試區驗證 B0 四項完成條件全部通過,B0 改為完成。`netops.ping.read` 指派給 `it-admin`(先誤派到沒有成員的 `gw-it-admin`)。
- 檔案:`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`
- 驗證:CI Pipeline #629 成功;瀏覽器經 Gateway 呼叫 `/api/netops/ping`:無權限 403、指派後 200;主機 2 容器內直連 `/v1/ping` 無 Token 401

## 2026-11-03 B0 最小骨架部署
- 工作項目:B0
- 內容:新增 `backend/`(netops-api,由 Gateway `samples/node-backend` 複製)、驗證路由 `GET /api/netops/ping`(權限 `netops.ping.read`)、`deploy/` 與 `.gitlab-ci.yml`(只部署 `netops-api` 到主機 2)。上游與路由由啟動時自動註冊為草稿。ARCHITECTURE D10 改為主機 3 WSL 已可連外。舊版程式未改動。
- 檔案:`backend/`、`deploy/`、`.gitlab-ci.yml`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`
- 驗證:`cd backend && npm run typecheck && npm test && npm run build` 通過(11 項);本機啟動確認 `/healthz` 200、`/v1/ping` 無 Token 401

## 2026-11-02 新增流程架構文件
- 內容:以 Mermaid 記錄現況、過渡期與未來目標的資料與 AI 流程。程式尚未改動。
- 檔案:`docs/FLOW-ARCHITECTURE.md`(新增)、`docs/ARCHITECTURE.md`、`docs/PROJECT-MAP.md`、`AGENT.md`
- 驗證:文件異動;Mermaid 以工作區安裝的版本在瀏覽器渲染;現況比對 `server/` 程式與 `README.md`

## 2026-11-02 AI 移出這次範圍,未來由 AI 中控台提供(D17、D18)
- 工作項目:B0、B2、F1、D1、D2
- 內容:不改寫 AI 功能;B0 不再驗證串流;知識庫只保留筆記管理與關鍵字搜尋;切換後舊版 IIS 留著提供 AI。AI 中控台 PRD 放在工作區 `GigaNexusAIPlan/docs/AI-CONSOLE-PRD.md`。程式尚未改動。
- 檔案:`AGENT.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/UI-GUIDE.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`
- 驗證:文件異動;盤點 `server/` 中 AI 相關路由與相依

## 2026-11-02 UI 規劃改為比照入口網與 GigaItApp(D5)
- 工作項目:F1
- 內容:D5 由保留 Element Plus 改為複製入口網 `src/ui/` 框架、改寫畫面,視覺只換主題色(工程藍);移除 Element Plus、Tailwind、舊配色系統與字體大小控制。程式尚未改動。
- 檔案:`docs/UI-GUIDE.md`(新增)、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/PROJECT-MAP.md`、`AGENT.md`
- 驗證:文件異動;比對 GigaItApp 與入口網 `src/ui/` 差異、NetOps 舊畫面使用的 Element Plus 元件

## 2026-11-02 B0 前決策(D13–D16)
- 工作項目:B0、B1、D1、D2
- 內容:B0 改為最小骨架部署與串流驗證,API Key 與基本 CI 從 D1 提前;切換時全部複製資料再核對;初始成員上線時重新指派;外部 IP 自動學習不擋切換;第一版不自動清除資料。D10 記錄主機 3 WSL 實測與工作區 AGENT §5 不一致。
- 檔案:`AGENT.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`
- 驗證:文件異動;比對 Gateway `router/plugin.ts`、`router/upstream.ts`、`nginx/nginx.conf`;主機 2、3 WSL 磁碟,主機 3 WSL 的 DNS 與 `rdap.arin.net`

## 2026-10-30 D0 收尾:確認負責人與 develop
- 工作項目:D0
- 內容:負責人確認為佳緯;`develop` 已建立;三個 repo 的文件 MR 已合併,D0 標示完成。
- 檔案:`AGENT.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`
- 驗證:文件異動;GitLab API 確認 !1、!20、!18 皆為 merged

## 2026-10-30 建立接入 Gateway 的規劃與 AI 守則
- 工作項目:D0
- 內容:新增 AI 協作準則與規劃文件。決定系統代碼 `netops`、`/netops/`、`netops-api` :51292;後端改 Fastify 5 + TypeScript;登入與權限交給 Gateway;第一版資料存檔案並只經 `infra/store`,未來改由服務直接寫入資料庫。程式尚未改動。
- 檔案:`AGENT.md`、`CLAUDE.md`、`GEMINI.md`、`.gitattributes`、`.gitlab/merge_request_templates/Default.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/PROJECT-MAP.md`、`docs/HANDOFF.md`
- 驗證:文件異動;工作區 `npm run arch:check`。主機 2、3 以 TCP 連線確認 FTP、LLM、Embedding、Qdrant 可達
