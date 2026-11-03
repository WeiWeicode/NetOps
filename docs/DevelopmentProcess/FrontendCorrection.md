# 前端修改紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §11。範圍:`frontend/`。

## 2026-11-03 F1 第 1 批:前端框架
- 工作項目:F1
- 內容:新增 `frontend/`(netops-web)。`src/ui/`(不含 `GHero`)、外框、選單、風格切換由入口網 giga-Portal 複製,路由守衛與 API 包裝比照 GigaItApp;`tokens.css` 換成工程藍(UI-GUIDE §2),元件不動。選單依 ARCHITECTURE §5 權限顯示,頁面先佔位;舊版 AI 問答與 Veeam 改一般連結(D11、D18)。沒有 `netops.app.access` 導回 `/?denied=netops`;`netops.ping.read` 時佔位頁顯示 `/api/netops/ping` 結果。gw.app 在 D1 才登記 netops,登記前以 `netops.app.access` 推導本系統。本機假 Gateway `mock/gateway.ts`(`MOCK=admin|viewer|noapp|anon`)只在 dev 啟用。CI 加 `check:frontend`(只檢查不部署)。
- 檔案:`frontend/`、`.gitlab-ci.yml`、`docs/UI-GUIDE.md`、`docs/IMPL-PLAN.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`
- 驗證:`cd frontend && npm run typecheck && npm test && npm run build` 通過(4 檔 25 項);瀏覽器以 `MOCK=admin` 檢查玻璃 / 扁平 × 明亮 / 黑暗 × 1440px / 375px,文字對比最低 5.05:1、無水平捲動;`MOCK=viewer` 看到全部唯讀頁;`MOCK=noapp` 導回 `/?denied=netops`
- 審查:`code-reviewer`(連結排序與顯示條件、守衛抽成 `composables/guard.ts` 並補測試、移除未用的 `usePaged`)、`security-auditor`(無 Critical / High;Registry 走 HTTP、`GAppSwitcher` 未檢查 `basePath` 屬跨專案,另行回報)已修正或列入回報
