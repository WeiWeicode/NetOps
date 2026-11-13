# 專案地圖 — NetOps

> **最後更新:2026-11-13**(C4 冷歸檔:`ingest/archive.ts`(netops-ingest 每天匯出 Parquet 到 NAS、manifest、重試、保留期限)、`infra/clickhouse/archive.ts`(匯出、manifest、`file()` 讀回)、`modules/pa-heat/cold.ts`(時段明細冷路由)、`migrations/004`、`deploy/host2-setup-pa-archive.sh`;C5 PA 精準查詢:`pa-collector/netops_pa/pa_query.py`(查詢執行者)、`backend/src/{infra/redis/pa-query.ts,modules/pa-query/}`、`frontend/src/{api/paQuery.ts,composables/usePaQuery.ts,components/PaQueryPanel.vue}`;V-b2 熱力圖 / 時段明細抽屜 / 分析儀表板畫面與 9 個圖表元件:`frontend/src/ui/styles/tokens.css`(4 組明暗×玻璃/扁平熱力圖與徽章色階)、`ui/components/{GDrawer,GSourceBadge}.vue`、`ui/charts/{GHeatmap,GTrendDualAxis,GSankey,GTopBars,GAppShare,GAllowDeny,GSeverityCards,GThreatTimeline,GWorldMap,GTopCompare}.vue`、`components/SliceDrawer.vue`、`pages/firewall/{Heatmap,Insight}.vue`、`test/viz.mount.test.ts`、測試報告 `docs/test-reports/2026-11-12-viz-b2.md`;V-b1 熱力圖 / 儀表板前端邏輯層:`frontend/src/api/{heatmap,slice,insight}.ts`、`composables/{useHeatmap,useSlice,useInsight,useChartPick,useReducedMotion,useLivePaQuery,vizTime}.ts`、`ui/charts/{echarts.ts,GEChart.vue,GHeatmap.vue,viz-types.ts,world/}`、`ui/components/{GDrawer,GSourceBadge}.vue`、`pages/firewall/{Heatmap,Insight}.vue`、`mock/viz.ts`、`test/fixtures/viz/`;新增相依 `echarts`;後端儀表板 API `modules/pa-insight/`;2026-11-11 C3 D43:PA 總覽、安全事件、明細只查 ClickHouse(`modules/pa/{routes,log-routes,ch-overview}.ts`、`pa-events/routes.ts`),FTP 只做對帳與補漏;V-a 熱力圖資料層:`deploy/clickhouse/schema.sql` 的 `pa_heat_5m` / `_1h` / `_1d` 與 6 個物化檢視、`migrations/003`、`rebuild-day.sh`;`infra/clickhouse/heat.ts`(熱力圖與時段明細查詢)、`infra/redis/cold-lock.ts`(冷查詢鎖,C4 接上)、`modules/pa-heat/`(熱力圖、時段明細 API);C3 第 3 批:`modules/pa/{reconcile,recon-routes}.ts`(FTP 每日對帳、補漏 API)、`ingest/backfill.ts`(netops-ingest 從 FTP 補寫缺的 seqno)、`infra/redis/backfill.ts`(補漏佇列)、netops-ingest 加 FTP 與 `ingest-egress` 網路;第 2 批:Log 明細可查 ClickHouse(`log-routes.ts` 的 `source`);C3 查詢切換第 1 批:`infra/clickhouse/reader.ts`(netops_reader 唯讀查詢)、`infra/redis/cache.ts`(儀表板快取)、`modules/pa/ch-summary.ts`(ClickHouse 每小時摘要,`palogs/ch/`)、`modules/pa/ch-overview.ts`(來源切換 ftp / clickhouse / auto);netops-api 加入 `netops-ch` 網路與 `ch_reader_password`;2026-11-10 C2 寫入管線:`backend/src/ingest/`(netops-ingest,netops-api 同映像不同進入點)、`backend/src/infra/clickhouse/`、`backend/src/infra/redis/ingest.ts`、`deploy/clickhouse/migrations/`、`verify-ingest.sh`、`dedupe-day.sh`、CI `check:ingest-int`;收集器 `seqno`、`sessionId`;CI:`deploy/ci-netops-pa.sh`,netops-pa 沒變更時不重建;C1 ClickHouse POC:`deploy/clickhouse/`、`netops-clickhouse`、`deploy/host2-set-clickhouse-secrets.sh`、POC 工具 `deploy/clickhouse/poc/`;R1 驗收修正:即時監控排行切換與 log 暫停鈕改用 `GCard` 的 `#actions` 插槽,前端新增掛載測試(`@vue/test-utils`、`happy-dom`)與插槽名稱檢查;串流 401 先經 web-kit 換發;串流每人上限 3。2026-11-09:R1 測試區收集器開關:`netops:pa:control` 由 `netops-api` `infra/redis` 寫、`pa-collector/netops_pa/control.py` 讀,API `PUT /v1/pa-live/collector-control`、按鈕 `netops.pa-live.manage`;即時監控頁首輪詢 / 接收狀態、429 與路由未發佈的提示;CI 冒煙測試不再打 `/v1/ping`。2026-11-05:S0 串流驗證:`modules/pa-live/` SSE 驗證路由、`backend/scripts/sse-probe.mjs`,不改 Gateway;D1 驗收修正:測試區 `FTP_LOG_DIR=/my-data` 寫進 CI、`netops-kb-backup` healthcheck、FTP 清單不列系統資料夾、AD FTP 清單改手動;2026-11-04:D1 完成並上測試區,有未驗項目:CI 發佈前端 SPA 與套用畫面權限、`deploy/gateway-rbac.yaml`、知識庫 NAS 備份 `deploy/kb-backup/`、監控 Key;驗收報告 `docs/test-reports/2026-11-04-d1-uat.md`。2026-11-03:F1、B2 完成;舊版程式未改動)。
> 開發新功能後,在同一個變更內更新本文件(`AGENT.md` §9)。只寫結構與職責,細節連到 `docs/`。

資訊網通管理系統:PA-560 防火牆 log、AD 事件與網通知識庫;AI 問答只留在舊版(ARCHITECTURE D17)。目標是接入 GigaNexus Gateway(`/netops/`、`netops-api` :51292),目前部署於 IIS `/NetOps`。

---

## 1. 目前目錄(舊架構)

```
NetOps/
├─ AGENT.md / CLAUDE.md / GEMINI.md / README.md
├─ docs/               ARCHITECTURE、IMPL-PLAN、HANDOFF、本文件、DevelopmentProcess/、Gherkin/(行為規格)、test-reports/(測試與驗收報告)
├─ server/             Express API
│  ├─ index.js         進入點、路由掛載、靜態檔
│  ├─ config.js、db.js 設定;SQL Server(只供登入與跳轉)
│  ├─ routes/          ad、ai、auth、ftp、jump、kb、paevents、palog、theme
│  └─ lib/             palog / importer(PA 分析)、paevents / paevimport(其他 log)、adlog / adimport(AD)、
│                      evidence / flows / scan(問答查證)、llm、kb / vector / iplearn(知識庫)、ftp、auth / perms / users(登入)
├─ src/                Vue 3 前端(views、components、layouts、router、stores、api)
├─ themes/             配色定義與預覽
├─ scripts/            FTP / 向量探測、發佈、配色;dc/ADLog-FtpBackup-3.ps1(DC 排程匯出,在 DC 上執行)
└─ public/             favicon、圖片
```

## 2. 新版目錄(B0 已建立骨架)

```
NetOps/
├─ .gitlab-ci.yml           check:backend、check:frontend(所有分支);develop → 主機 2:deploy-api-test(netops-api、netops-kb-backup)、
│                           deploy-web-test(SPA 發佈到 Gateway gw_www/netops)、rbac-test(套用 deploy/gateway-rbac.yaml)
├─ backend/                 netops-api :51292(Fastify 5 + TypeScript,由 Gateway samples/node-backend 複製)
│  ├─ src/
│  │  ├─ server.ts、app.ts  啟動;內部 Token 驗證、錯誤格式、/healthz、/readyz、/openapi.json、setupGateway
│  │  ├─ config.ts          服務設定:資料目錄、FTP(*_FILE 機密)、明細查詢上限;test / prod 缺少時啟動失敗
│  │  ├─ errors.ts、openapi.ts、print-openapi.ts
│  │  ├─ infra/store/       資料存取邊界(D8):模組只呼叫具名函式;/readyz 檢查資料目錄
│  │  ├─ infra/clickhouse/  netops-clickhouse 存取(HTTP 介面 + fetch,表名只用常數):index.ts netops-ingest 寫入(C2);reader.ts netops-api 唯讀查詢(C3,query_params、依每分鐘筆數切段);heat.ts 熱力圖彙總與時段明細(V-a)
│  │  ├─ infra/redis/       netops-redis:index.ts(即時監控讀取、收集器開關)、ingest.ts(consumer group ch-writer、心跳、缺口清單)、cache.ts(儀表板快取 netops:cache:*,C3)、backfill.ts(補漏佇列 netops:backfill:*,C3)、cold-lock.ts(冷查詢鎖 netops:cold:lock,V-a;C4 接上)
│  │  ├─ ingest/            netops-ingest 進入點 main.ts(dist/src/ingest/main.js)、writer.ts(批次寫入、成功才 ACK、重啟補待處理)、rows.ts(JSON → 列)、config.ts、backfill.ts(C3 FTP 補漏)、archive.ts(C4 冷歸檔)
│  │  ├─ infra/jobs/        長時間工作(D6):本人才能查、數量與時間上限、程序重啟後失效
│  │  ├─ infra/ftp/         FTP 唯讀(列目錄、串流下載);連線上限 FTP_MAX_CONNECTIONS
│  │  ├─ shared/            時間轉換(核心本地時間 ↔ ISO 8601)、共用 schema、匯出 CSV
│  │  └─ modules/
│  │     ├─ ping/routes.ts  GET /v1/ping(對外 /api/netops/ping,netops.ping.read)
│  │     ├─ pa-live/routes.ts  S0 串流驗證 GET /v1/pa-live/stream-test(SSE,heartbeat 15 秒,x-timeout-ms 60000,netops.ping.read);R1 即時監控也放這裡
│  │     ├─ pa/             core/palog.js(舊版逐字)、core/flows.js、core/scan.js、importer.ts(TRAFFIC 匯入)、routes.ts(總覽)、
│  │     │                  log-routes.ts(明細查詢與匯出,工作模式)、ch-summary.ts(ClickHouse 每小時摘要,背景)、
│  │     │                  ch-overview.ts(總覽 / 安全事件 / 篩選選項的 ClickHouse 來源與切換,C3)、
│  │     │                  reconcile.ts、recon-routes.ts(FTP 與 ClickHouse 每日對帳、補漏 API,C3)
│  │     ├─ pa-heat/        heat.ts(熱力圖期間、格子、分級,純函式)、service.ts(熱力圖快取、時段明細工作:30 秒同步、熱 / 冷分界)、routes.ts(V-a)、cold.ts(C4 冷路由:歸檔檢查 + Parquet 子查詢)
│  │     ├─ pa-events/      core/paevents.js(舊版逐字)、importer.ts(其他類型 log 匯入)、routes.ts(安全事件總覽)
│  │     ├─ ad/             core/adlog.js(舊版逐字)、importer.ts(AD 匯入)、routes.ts(總覽、明細、匯出)
│  │     ├─ kb/             core/notes.js(舊版 kb.js 的格式與匯整)、service.ts、routes.ts
│  │     └─ ftp/            routes.ts(PA)、ad-routes.ts(AD;清單為工作模式)
│  ├─ scripts/sse-probe.mjs S0 驗證腳本:經 Gateway 連 SSE,記錄事件到達時間、斷線與重連(Cookie 由執行者放環境變數)
│  ├─ test/unit/            app、config、jobs、store、ftp、pa / ad(與舊版結果比對)、pa-live(SSE,真實 HTTP 連線)、ingest;test/fixtures 假 log、假 AD 匯出檔、假 FTP、假 Stream / ClickHouse
│  ├─ test/integration/     ingest.int.test.ts、reader.int.test.ts(C3,netops_reader)、heat.int.test.ts(V-a 熱力圖彙總與時段明細):真 Redis + ClickHouse(CI check:ingest-int 起一次性容器;npm run test:int)
│  └─ Dockerfile、.npmrc(@giganexus/* 取自 GitLab npm Registry)
├─ frontend/                netops-web(Vue 3 + TypeScript,base /netops/;F1 完成,框架由入口網複製,docs/UI-GUIDE.md)
│  ├─ src/
│  │  ├─ ui/                全域元件與設計 token(入口網 src/ui/,只換 tokens.css 顏色;NetOps 新增 charts/GStackedBars、base.css 的 .c-* 文字色)
│  │  ├─ layouts/           AppLayout(兩層側欄、頂列)、TabbedPage
│  │  ├─ router.ts          選單群組、功能頁、一般連結、路由守衛(應用 / 頁面權限)
│  │  ├─ api/               gateway.ts(web-kit 包裝、download())、perms.ts(權限代碼)、ftp / pa / paEvents / ad / kb.ts(/api/netops/*,docs/API.md)、jobs.ts(工作狀態)、format.ts(顯示格式)、heatmap / slice / insight.ts(V-b1 熱力圖、時段明細、儀表板)
│  │  ├─ composables/       apps、guard(守衛判斷)、menu、session、theme;useJob(工作模式)、usePolling(背景狀態輪詢)、searchQuery(明細查詢網址條件)、markdown(marked + DOMPurify)、ftpFiles、adEvents、paDashboard、dates、dateRange(日期區間欄位的快捷選項與檢查,C3);V-b1:useHeatmap、useSlice(時段明細,202 輪詢、429 倒數)、useInsight、useChartPick(圖表點擊 → 明細條件)、useReducedMotion、useLivePaQuery(C5 前停用)、vizTime(台灣時間)
│  │  ├─ components/        TopList(排行清單,安全事件與流量總覽共用)、DateRangeField(單一欄位選起訖,總覽 / 安全事件 / 明細共用)、SliceDrawer(V-b2 時段明細抽屜,熱力圖與分析儀表板共用:冷資料掃描線過場、202 背景工作、429 倒數、409/404 保留格子彙總、明細表)
│  │  ├─ ui/charts/         既有自刻 SVG 圖表;V-b1:echarts.ts(ECharts 按需引入、主題、世界地圖,只由 GEChart 動態載入)、GEChart.vue(基底)、viz-types.ts(圖表元件介面)、world/(Natural Earth 1:110m,scripts/build-world-geo.mjs 產生);V-b2:GHeatmap.vue(GitHub 風格 CSS Grid 熱力圖)、GTrendDualAxis.vue、GSankey.vue、GTopBars.vue、GAppShare.vue、GAllowDeny.vue、GSeverityCards.vue、GThreatTimeline.vue、GWorldMap.vue、GTopCompare.vue
│  │  ├─ config/links.ts    舊版 NetOps(AI 問答、AI 分析、知識庫 AI 功能)與 Veeam 連結(D11、D17、D18)
│  │  └─ pages/             firewall/(流量總覽、活動熱力圖、分析儀表板、安全事件、明細查詢、FTP Log 檔案)、ad/(事件總覽、明細查詢、FTP Log 檔案)、knowledge/;Forbidden、NotFound、Unavailable
│  ├─ mock/                 本機假 Gateway(gateway.ts;MOCK=admin|viewer|noapp|anon,只在 dev,不進建置)與各模組假 API(ftp、pa、paEvents、paLog、ad、kb、viz:熱力圖 / 明細 / 儀表板,資料來自 test/fixtures/viz/generate.ts)
│  ├─ test/                 vitest:選單、守衛、應用層守衛、風格、工作輪詢、狀態輪詢、各頁純函式、網址條件、連結;即時監控頁掛載測試(happy-dom)、插槽名稱檢查
│  └─ Dockerfile、publish.sh SPA 映像:一次性容器發佈到 gw_www/netops(symlink 原子切換、保留 5 版、可回滾;D1)
└─ deploy/
   ├─ docker-compose.yml    netops-api 加入 Gateway 網路,不對主機發佈 port;netops-clickhouse(C1;C2 起只在 netops-ch 網路);netops-ingest(C2,寫入管線);netops-kb-backup(知識庫 NAS 備份,healthcheck 看 LAST_RESULT);spa-netops(profile publish)
   ├─ gateway-rbac.yaml     netops.* 應用 / 選單 / 按鈕、netops-admin、netops-viewer(不指派成員,D15);apply-gateway-rbac.sh 套用(檢查只動 netops 範圍)
   ├─ kb-backup/            每天把 knowledge/ 打包到 NAS docker-folder/giga-netops/<區>,保留 30 份(ARCHITECTURE Q3)
   ├─ clickhouse/           netops-clickhouse(C1):config.d/low-memory.xml、users.d/(default 只限本機、查詢設定檔)、schema.sql、migrations/(C2 起,可重複執行)、apply-schema.sh(依部署區套 TTL 與 migrations,CI 執行)、verify-ingest.sh(C2 驗收核對,只讀)、dedupe-day.sh(重複修正)
   │                        poc/:C1 實測工具(主機 2 執行):ftp-cat.mjs(在 netops-api 容器內唯讀串流 FTP)、import-day.sh / .sql(匯入一天)、bench.sh(容量與查詢)
   ├─ ci-netops-pa.sh       CI 判斷 netops-pa 要不要重建(pa-collector/、compose 段、netops.env 都沒變就不重建,避免 PA-560 Syslog 斷線)
   ├─ host2-set-clickhouse-secrets.sh  ClickHouse 帳號 netops_writer / reader / cold 的隨機密碼與帳號檔(只含雜湊;使用者執行)
   ├─ host2-set-secrets.sh  主機 2 機密(含 giga-observe ingest Key)與 netops.env(使用者執行)
   ├─ host2-setup-kb-backup.sh  NAS 備份目錄與標記檔(使用者執行;沿用附件服務的 NAS 掛載)
   └─ test.env.example
```

## 2.1 目標目錄(B1 起補齊)

```
NetOps/
├─ backend/                 netops-api
│  ├─ src/
│  │  ├─ server.ts、app.ts、config.ts、errors.ts、openapi.ts
│  │  ├─ modules/{pa,pa-events,ad,kb,ftp}/   routes.ts(介面)+ 核心邏輯
│  │  └─ infra/{ftp,store,jobs}/             外部系統、資料存取、長時間工作
│  └─ test/{unit,integration}/
├─ frontend/                Vue 3 SPA(base /netops/)
├─ deploy/                  compose、gateway-rbac.yaml、env 範本(路由由服務自動註冊,不另寫 gateway-routes.yaml)
└─ docs/
```

## 3. 分層

| 層 | 目前 | 目標 |
| --- | --- | --- |
| 介面 | `server/routes/` | `backend/src/modules/*/routes.ts` |
| 核心 | `server/lib/` 的解析、彙總、研判 | `backend/src/modules/*/`,不依賴 Fastify |
| 基礎設施 | `server/lib/{ftp,llm,vector}.js`、各模組自行讀寫 `uploads/` | `backend/src/infra/`;資料一律經 `infra/store`;`llm`、`vector` 留在舊版(D17) |

## 4. 主要流程

- **Log 匯入**:FTP 串流讀取 → 解析彙總 → 存摘要(原始 log 不落地)。
- **總覽**:依期間合併摘要回傳。
- **AI 問答**(只在舊版,D17):問題抽出 IP / Port → 查統計或掃 FTP → 連同知識庫送 vLLM → 串流回傳。
- **知識庫**:筆記存檔 → 重建匯整檔;同步 Qdrant 只在舊版。

## 5. 要改 X → 看哪裡

| 要改 | 看哪裡 |
| --- | --- |
| PA 研判或摘要欄位 | 舊版 `server/lib/palog.js`、新版 `backend/src/modules/pa/core/palog.js`(切換前兩邊一起改;`SUMMARY_VERSION` 要加 1) |
| 其他 log 欄位與排行 | `server/lib/paevents.js` |
| AD 事件解析 | 舊版 `server/lib/adlog.js`、新版 `backend/src/modules/ad/core/adlog.js`(切換前兩邊一起改)、`scripts/dc/` |
| AI 提示與流程 | `server/routes/ai.js`、`server/lib/evidence.js`、`server/lib/llm.js` |
| 知識庫 | 新版 `backend/src/modules/kb/`;向量與自動學習只在舊版 `server/lib/vector.js`、`iplearn.js`(D17) |
| 選單與頁面 | 舊版 `src/router/menu.js`、`src/views/`;新版 `frontend/src/router.ts`、`frontend/src/pages/` |
| 新版畫面呼叫的 API | `frontend/src/api/*.ts`(頁面不直接 fetch;下載用 `api/gateway.ts` 的 `download()`) |
| 舊版連結(AI、Veeam) | `frontend/src/config/links.ts`(舊版網址待使用者確認) |
| 新版權限代碼(前端) | `frontend/src/api/perms.ts`(ARCHITECTURE §5) |
| 新版 API、權限代碼 | `docs/API.md`(介面定稿)、`backend/src/modules/*/routes.ts`、`backend/src/openapi.ts` |
| PA 即時監控(R1)與測試區收集器開關 | 收集器 `pa-collector/netops_pa/`(開關 `control.py`、鍵 `keys.py`);API `backend/src/modules/pa-live/{live-routes,service}.ts`、Redis `backend/src/infra/redis/`;畫面 `frontend/src/pages/firewall/Live.vue`、`frontend/src/composables/paLive.ts`;鍵格式 `docs/PA-LIVE-PLAN.md` §4 |
| SSE 串流(S0 驗證、R1、A1 問答) | `backend/src/modules/pa-live/routes.ts`、`docs/API.md` §3.1(逾時與標頭條件)、`docs/test-reports/2026-11-05-s0-sse.md` |
| FTP 對帳與補漏(C3) | `backend/src/modules/pa/{reconcile,recon-routes}.ts`、`backend/src/ingest/backfill.ts`、`backend/src/infra/redis/backfill.ts`;API.md §5.3、ARCHITECTURE D33 |
| 活動熱力圖、時段明細(V-a) | `backend/src/modules/pa-heat/`、`backend/src/infra/clickhouse/heat.ts`、`deploy/clickhouse/{schema.sql,rebuild-day.sh}`;API.md §4.4、VIZ-RULES-DESIGN §3、§4 |
| 冷歸檔(C4) | `backend/src/ingest/archive.ts`、`backend/src/infra/clickhouse/archive.ts`、`backend/src/modules/pa-heat/cold.ts`、`deploy/clickhouse/migrations/004-c4-archive-manifest.sql`、`deploy/host2-setup-pa-archive.sh`;手冊 §8、API.md §4.4、ARCHITECTURE D30 / D35 |
| PA 精準查詢(C5) | 執行者 `pa-collector/netops_pa/pa_query.py`(XML API log、Session Browser、CPU 取樣、逾時取消);API `backend/src/modules/pa-query/`、Redis `backend/src/infra/redis/pa-query.ts`;畫面 `frontend/src/components/PaQueryPanel.vue`(即時監控頁)、`composables/usePaQuery.ts`;API.md §3.3 |
| 分析儀表板(V-b1、V-b2) | 後端 `backend/src/modules/pa-insight/`(國家對照 `countries.ts`);前端邏輯 `frontend/src/composables/useInsight.ts`、`useChartPick.ts`、`ui/charts/{GEChart.vue,echarts.ts,viz-types.ts}`;畫面與圖表 `pages/firewall/Insight.vue`、`ui/charts/{GTrendDualAxis,GSankey,GTopBars,GAppShare,GAllowDeny,GSeverityCards,GThreatTimeline,GWorldMap,GTopCompare}.vue`;API.md §4.5;規格 `docs/HANDOFF-GEMINI-VIZ.md` |
| 活動熱力圖、時段明細(V-a、V-b2) | 前端 `frontend/src/composables/{useHeatmap,useSlice}.ts`、`ui/charts/GHeatmap.vue`、`ui/components/{GDrawer,GSourceBadge}.vue`、`components/SliceDrawer.vue`、`pages/firewall/Heatmap.vue`;後端 `backend/src/modules/pa-heat/`、`backend/src/infra/clickhouse/heat.ts`、`deploy/clickhouse/{schema.sql,rebuild-day.sh}`;API.md §4.4、VIZ-RULES-DESIGN §3、§4 |
| PA 總覽 / 安全事件改查 ClickHouse(C3) | `backend/src/modules/pa/{ch-overview,ch-summary}.ts`、`backend/src/infra/clickhouse/reader.ts`、`backend/src/infra/redis/cache.ts`;ARCHITECTURE D29、D42 |
| PA log 寫入 ClickHouse(C2) | `backend/src/ingest/`、`backend/src/infra/{clickhouse,redis/ingest.ts}`、`deploy/clickhouse/`、手冊 `docs/PA-LOG-CLICKHOUSE-GUIDE.md` §6;Redis 鍵 `docs/PA-LIVE-PLAN.md` §4 |
| 新版部署 | `.gitlab-ci.yml`、`deploy/` |
| 接入規劃與決策 | `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/PA-LIVE-PLAN.md`(PA 即時監控與 AI 搬移) |
| 資料與 AI 流程(現況、過渡期、未來目標) | `docs/FLOW-ARCHITECTURE.md` |
| 新版畫面與主題色 | `docs/UI-GUIDE.md` |

## 6. 測試地圖

`backend/test/unit/`:OpenAPI 必填欄位、內部 Token 驗證與錯誤格式、部署區與服務設定、`/readyz`、長時間工作(`cd backend && npm test`)。`frontend/test/`:選單、路由守衛、應用層守衛、風格、工作 / 狀態輪詢、各頁純函式、網址條件、連結(`cd frontend && npm test`);畫面以 `MOCK=admin|viewer|noapp npm run dev` 在瀏覽器檢查。舊版沒有自動化測試,只有 `scripts/` 的手動探測;B2 已補上模組測試(`pa`、`ad`、`kb`、`logs` 以同一批假 log 與舊版 `server/lib` 比對)。

## 7. 已知差異(與 Gateway §10.7.2)

| 差異 | 狀態 |
| --- | --- |
| 整個後端使用 Express 與 JavaScript、沒有 OpenAPI | 新版已處理(B1、B2:Fastify + TypeScript、OpenAPI);舊版切換前保留(D12) |
| 前端 JavaScript、Element Plus,與 GigaItApp、入口網元件不同 | 新版 `frontend/` 已改用 `src/ui/` 與 TypeScript(F1);舊版 `src/` 與根目錄 Element Plus / Tailwind 依 D12、D18 保留到舊版停用(`docs/UI-GUIDE.md` §4) |
| 自建登入、Bearer Token 存 localStorage | B2、F1 移除 |
| 回應格式與時間不符 BACKEND-GUIDE §5 | 新版已處理(B2) |
| 資料寫在 `uploads/`、各模組自行讀寫 | 新版已集中到 `infra/store`(B2);不寫入資料庫(D20);即時資料規劃放 Redis(D19) |
