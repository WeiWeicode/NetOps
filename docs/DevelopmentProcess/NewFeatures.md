# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。

## 2026-10-30 建立接入 Gateway 的規劃與 AI 守則
- 工作項目:D0
- 內容:新增 AI 協作準則與規劃文件。決定系統代碼 `netops`、`/netops/`、`netops-api` :51292;後端改 Fastify 5 + TypeScript;登入與權限交給 Gateway;第一版資料存檔案並只經 `infra/store`,未來改由服務直接寫入資料庫。程式尚未改動。
- 檔案:`AGENT.md`、`CLAUDE.md`、`GEMINI.md`、`.gitattributes`、`.gitlab/merge_request_templates/Default.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/PROJECT-MAP.md`、`docs/HANDOFF.md`
- 驗證:文件異動;工作區 `npm run arch:check`。主機 2、3 以 TCP 連線確認 FTP、LLM、Embedding、Qdrant 可達
