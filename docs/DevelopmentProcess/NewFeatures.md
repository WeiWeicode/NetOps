# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。

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
