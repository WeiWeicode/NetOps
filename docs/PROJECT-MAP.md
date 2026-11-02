# 專案地圖 — NetOps

> **最後更新:2026-11-02**(決策 D13–D18、UI 規劃;這次不改寫 AI;程式尚未改動,仍是舊架構)。
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

## 2. 目標目錄(B0 起建立)

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
| PA 研判或摘要欄位 | `server/lib/palog.js`(`SUMMARY_VERSION` 要加 1) |
| 其他 log 欄位與排行 | `server/lib/paevents.js` |
| AD 事件解析 | `server/lib/adlog.js`、`scripts/dc/` |
| AI 提示與流程 | `server/routes/ai.js`、`server/lib/evidence.js`、`server/lib/llm.js` |
| 知識庫與向量 | `server/lib/kb.js`、`server/lib/vector.js`、`server/lib/iplearn.js` |
| 選單與頁面 | `src/router/menu.js`、`src/views/` |
| 接入規劃與決策 | `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md` |
| 資料與 AI 流程(現況、過渡期、未來目標) | `docs/FLOW-ARCHITECTURE.md` |
| 新版畫面與主題色 | `docs/UI-GUIDE.md` |

## 6. 測試地圖

目前沒有自動化測試,只有 `scripts/` 的手動探測。B1、B2 起建立 `backend/test/`。

## 7. 已知差異(與 Gateway §10.7.2)

| 差異 | 狀態 |
| --- | --- |
| 整個後端使用 Express 與 JavaScript、沒有 OpenAPI | B1、B2 處理 |
| 前端 JavaScript、Element Plus,與 GigaItApp、入口網元件不同 | F1 改用 `src/ui/` 與 TypeScript(ARCHITECTURE D5、`docs/UI-GUIDE.md`) |
| 自建登入、Bearer Token 存 localStorage | B2、F1 移除 |
| 回應格式與時間不符 BACKEND-GUIDE §5 | B2 處理 |
| 資料寫在 `uploads/`、各模組自行讀寫 | B2 集中到 `infra/store`;資料庫為後續階段(D8) |
