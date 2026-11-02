# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。

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
