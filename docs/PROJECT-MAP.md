# 專案地圖 — NetOps

> **最後更新:2026-11-03**(F1 第 2 批:FTP Log 檔案(PA、AD)、AD 事件總覽、安全事件改寫;F1 第 1 批:新增 `frontend/` 框架;B2-ad:安全事件總覽、AD 匯入 / 總覽 / 明細 / 匯出、FTP Log 檔案(AD);舊版程式未改動)。
> 開發新功能後,在同一個變更內更新本文件(`AGENT.md` §9)。只寫結構與職責,細節連到 `docs/`。

資訊網通管理系統:PA-560 防火牆 log、AD 事件與網通知識庫;AI 問答只留在舊版(ARCHITECTURE D17)。目標是接入 GigaNexus Gateway(`/netops/`、`netops-api` :51292),目前部署於 IIS `/NetOps`。

---

## 1. 目前目錄(舊架構)

```
NetOps/
├─ AGENT.md / CLAUDE.md / GEMINI.md / README.md
├─ docs/               ARCHITECTURE、IMPL-PLAN、HANDOFF、本文件、DevelopmentProcess/
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
├─ .gitlab-ci.yml           check:backend、check:frontend(所有分支)、deploy-api-test(develop → 主機 2)
├─ backend/                 netops-api :51292(Fastify 5 + TypeScript,由 Gateway samples/node-backend 複製)
│  ├─ src/
│  │  ├─ server.ts、app.ts  啟動;內部 Token 驗證、錯誤格式、/healthz、/readyz、/openapi.json、setupGateway
│  │  ├─ config.ts          服務設定:資料目錄、FTP(*_FILE 機密)、明細查詢上限;test / prod 缺少時啟動失敗
│  │  ├─ errors.ts、openapi.ts、print-openapi.ts
│  │  ├─ infra/store/       資料存取邊界(D8):模組只呼叫具名函式;/readyz 檢查資料目錄
│  │  ├─ infra/jobs/        長時間工作(D6):本人才能查、數量與時間上限、程序重啟後失效
│  │  ├─ infra/ftp/         FTP 唯讀(列目錄、串流下載);連線上限 FTP_MAX_CONNECTIONS
│  │  ├─ shared/            時間轉換(核心本地時間 ↔ ISO 8601)、共用 schema、匯出 CSV
│  │  └─ modules/
│  │     ├─ ping/routes.ts  GET /v1/ping(對外 /api/netops/ping,netops.ping.read)
│  │     ├─ pa/             core/palog.js(舊版逐字)、core/flows.js、importer.ts(TRAFFIC 匯入)、routes.ts(總覽)
│  │     ├─ pa-events/      core/paevents.js(舊版逐字)、importer.ts(其他類型 log 匯入)、routes.ts(安全事件總覽)
│  │     ├─ ad/             core/adlog.js(舊版逐字)、importer.ts(AD 匯入)、routes.ts(總覽、明細、匯出)
│  │     └─ ftp/            routes.ts(PA)、ad-routes.ts(AD;清單為工作模式)
│  ├─ test/unit/            app、config、jobs、store、ftp、pa / ad(與舊版結果比對);test/fixtures 假 log、假 AD 匯出檔、假 FTP
│  └─ Dockerfile、.npmrc(@giganexus/* 取自 GitLab npm Registry)
├─ frontend/                netops-web(Vue 3 + TypeScript,base /netops/;F1,框架由入口網複製,docs/UI-GUIDE.md)
│  ├─ src/
│  │  ├─ ui/                全域元件與設計 token(入口網 src/ui/,只換 tokens.css 顏色)
│  │  ├─ layouts/           AppLayout(兩層側欄、頂列)、TabbedPage
│  │  ├─ router.ts          選單群組、功能頁、一般連結、路由守衛(應用 / 頁面權限)
│  │  ├─ api/               gateway.ts(web-kit 包裝)、perms.ts(權限代碼)、netops.ts、ftp.ts、ad.ts、paEvents.ts(/api/netops/*,docs/API.md)、jobs.ts(工作狀態)、format.ts(顯示格式)
│  │  ├─ composables/       apps、guard(守衛判斷)、menu、session、theme、useJob(工作模式輪詢)、usePolling(背景工作狀態輪詢)、ftpFiles(FTP 清單的純函式)、adEvents、dates
│  │  ├─ components/        PingCard、TopList(排行清單,安全事件與流量總覽共用)
│  │  ├─ config/links.ts    舊版 AI 問答(含帶入問題的 legacyAskUrl)、Veeam 連結(D11、D18)
│  │  └─ pages/             firewall/、ad/(已改寫的頁面)、WipPage(改寫中)、Forbidden、NotFound、Unavailable
│  ├─ mock/                 本機假 Gateway(gateway.ts;MOCK=admin|viewer|noapp|anon,只在 dev)與各模組假 API(ftp.ts、ad.ts、paEvents.ts)
│  └─ test/                 vitest:選單、路由守衛、應用層守衛、風格、工作輪詢、FTP 清單
└─ deploy/
   ├─ docker-compose.yml    netops-api 加入 Gateway 網路,不對主機發佈 port
   ├─ host2-set-secrets.sh  主機 2 機密與 netops.env(使用者執行)
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
├─ deploy/                  compose、gateway-routes.yaml、gateway-rbac.yaml、env 範本
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
| 知識庫與向量 | `server/lib/kb.js`、`server/lib/vector.js`、`server/lib/iplearn.js` |
| 選單與頁面 | 舊版 `src/router/menu.js`、`src/views/`;新版 `frontend/src/router.ts`、`frontend/src/pages/` |
| 新版權限代碼(前端) | `frontend/src/api/perms.ts`(ARCHITECTURE §5) |
| 新版 API、權限代碼 | `docs/API.md`(介面定稿)、`backend/src/modules/*/routes.ts`、`backend/src/openapi.ts` |
| 新版部署 | `.gitlab-ci.yml`、`deploy/` |
| 接入規劃與決策 | `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md` |
| 資料與 AI 流程(現況、過渡期、未來目標) | `docs/FLOW-ARCHITECTURE.md` |
| 新版畫面與主題色 | `docs/UI-GUIDE.md` |

## 6. 測試地圖

`backend/test/unit/`:OpenAPI 必填欄位、內部 Token 驗證與錯誤格式、部署區與服務設定、`/readyz`、長時間工作(`cd backend && npm test`)。`frontend/test/`:選單、路由守衛、應用層守衛、風格、工作輪詢、FTP 清單(`cd frontend && npm test`);畫面以 `MOCK=admin|viewer|noapp npm run dev` 在瀏覽器檢查。舊版沒有自動化測試,只有 `scripts/` 的手動探測;B2 搬移時補上模組測試。

## 7. 已知差異(與 Gateway §10.7.2)

| 差異 | 狀態 |
| --- | --- |
| 整個後端使用 Express 與 JavaScript、沒有 OpenAPI | B1、B2 處理 |
| 前端 JavaScript、Element Plus,與 GigaItApp、入口網元件不同 | F1 改用 `src/ui/` 與 TypeScript(ARCHITECTURE D5、`docs/UI-GUIDE.md`) |
| 自建登入、Bearer Token 存 localStorage | B2、F1 移除 |
| 回應格式與時間不符 BACKEND-GUIDE §5 | B2 處理 |
| 資料寫在 `uploads/`、各模組自行讀寫 | B2 集中到 `infra/store`;資料庫為後續階段(D8) |
