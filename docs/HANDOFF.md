# NetOps 交接

> 接手時先讀 `AGENT.md`,再讀 `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`。

## 目前進度

**B0 最小骨架部署完成**(2026-11-03,NetOps !4 合併,`develop` e53f8da;測試區四項完成條件驗證通過)。`backend/` 有內部 Token 驗證、統一錯誤格式、`/healthz`、`/readyz`、`/openapi.json`、`setupGateway` 與驗證路由 `GET /api/netops/ping`(`netops.ping.read`);CI 只部署 `netops-api` 到主機 2。舊版繼續在 IIS 運作。**這次不改寫 AI 功能**,未來由 AI 中控台提供,切換後舊版留著給 AI 用(D17、D18)。負責人:佳緯。

**F1 前端進行中**:第 1 批框架(`feature/netops-f1-frame`)建立 `frontend/`,由入口網複製 `src/ui/`、外框與守衛,換工程藍;頁面先佔位,選單依 ARCHITECTURE §5 權限顯示(已合併)。第 2 批起逐頁改寫,每頁一個 MR:FTP Log 檔案(PA、AD,`feature/netops-f1-ftp`)完成,AD 清單用工作模式(`composables/useJob.ts`,之後明細查詢共用);AD 事件總覽(`feature/netops-f1-ad-events`)完成,點選帶條件到 `/ad/search`。`netops.*` 畫面代碼要到 D1 才登記,測試區看畫面用 `DEV_EXTRA_PERMS` 或本機假 Gateway(`MOCK`)。

## 下一步

1. 確認 GitLab 已保護 `develop`(只有 Maintainer 能合併、不能直接推送);現有 Token 沒有 Protected Branch 讀取權限,要在 GitLab 畫面確認。
2. B1 後端骨架 MR 審查中(`feature/netops-b1`);**合併前**在主機 2 重新執行 `sudo sh deploy/host2-set-secrets.sh`(補 FTP 帳號、隱藏輸入密碼、建立 `/srv/giga-netops/test`),否則部署會因缺少設定啟動失敗。
3. B2 依 `docs/API.md` 分批:`feature/netops-b2-pa` → `-ad` → `-kb` → `-logs`(堆疊 MR,狀態見 IMPL-PLAN B2)。

## 已知狀況

- 主機 2、3 的 Windows 端 TCP 連得到 FTP;容器內未驗證。
- 測試區:`netops-api` 容器 `giganexus-netops-test-netops-api-1` 在主機 2 運作(Gateway 網路,未發佈 port);機密在 `/srv/giganexus/netops-secrets/`、變數在 `/srv/giganexus/deploy/netops.env`(`deploy/host2-set-secrets.sh` 產生)。
- `netops.ping.read` 目前指派給 `it-admin` 角色(2026-11-03);D2 上線時依 D15 重新指派。GigaItApp 中 `gw-it-admin` 與 `it-admin` 名稱相近,指派時注意。
- B0 監控 Key 為空檔,監控停用;D1 登記 giga-observe 拓樸後補上。
- 舊版關閉知識庫寫入的做法還沒確認(IMPL-PLAN D2)。
- `scripts/dc/ADLog-FtpBackup-3.ps1` 寫死 FTP 帳號名稱,密碼走憑證檔,版控內沒有密碼。
- 資料庫是後續階段,不在這次範圍(ARCHITECTURE §4.2)。
- 舊版 `palog.js` 的 `readLog` 讀 `.gz` 時,若來源串流比解壓先關閉會提早結束(測試以 `Readable.from` 一次送完整個檔案時重現,讀到 0 筆);FTP 串流分段送時正常。核心照 D4 原封不動搬移,沒有修改;FTP 上目前是否有 `.gz` 檔、實際是否受影響未確認。
