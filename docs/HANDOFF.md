# NetOps 交接

> 接手時先讀 `AGENT.md`,再讀 `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`。

## 2026-11-03 收工

**已完成**
- B0、B1、B2 全部合併(!4、!7–!11)並部署測試區:`netops-api` 經 Gateway 可用,新版機密腳本已執行、路由已發佈、權限已指派;容器內 FTP 可用;!11 的測試區驗證(明細筆數、匯出、取消後匯入繼續)通過。
- F1 前端與 Gherkin 行為規格的 MR 已開、待合併。

**明天的合併順序**
1. F1 堆疊:!12 → !13 → !14 → !15 → !16 → !17 → !19 → !21(F1 文件)→ 本 MR(收工文件,依賴 !21)。
2. 不依賴上面的順序:!18(Gherkin 行為規格)可以獨立合併;!20(DELETE 在 OpenAPI 宣告 204)→ !22(FTP 錯誤訊息修正)要依序合併(兩者都改 `BackendCorrection.md`,!22 已合併 !20 的分支)。
3. 每批合併後在 GigaItApp「服務與路由」發佈有變動的路由草稿。

**下一步:D1 測試區部署**(IMPL-PLAN D1)
- Gateway 的 Nginx `/netops/` location、`gw.app` 登記、`.gitlab-ci.yml` 加 SPA 部署 job、`gateway-rbac.yaml` 登記畫面代碼、giga-observe 拓樸與 ingest Key。
- Gateway 與 giga-observe 是其他 repo,**動手前要使用者同意**(AGENT.md §3)。

**待使用者決定**

| # | 事項 | 說明 |
| --- | --- | --- |
| a | CI Runner 只跑受保護分支 | `check:*` 在所有分支用主機 2 的 shell executor 執行,讀得到主機上的 npm Token;機密檔為 uid 1000 所有。要不要限定受保護分支或改 docker executor(B0 既有) |
| b | FTPS | FTP 帳密與 log 目前明文傳輸(沿用舊版)。確認 FTP 伺服器支援 FTPS 後才能設 `FTP_SECURE=1` |
| c | `.gz` 提早結束 | 舊版 `readLog` 讀 `.gz` 時,來源比解壓先關閉會提早結束(測試可重現;FTP 分段串流正常)。依 D4 沒改核心;FTP 上是否有 `.gz` 未確認。要不要另開修正(新舊兩邊一起改) |
| d | 舊版 NetOps 正式網址 | F1 先用 `https://gsmc-web.gigasolar.com.tw/NetOps`(`frontend/src/config/links.ts`),AI 問答連結依賴它 |
| e | F1 新增的 UI 元件 | `GStackedBars` 等要不要回饋到入口網與 GigaItApp(跨 repo) |
| f | 知識庫匯整檔可被偽造成另一則筆記(Low) | 筆記內容可用 setext 標題或手寫「- 記錄:」做出像另一則筆記的段落;各筆記欄位不受影響。修了會改匯整檔格式(與舊版不同) |

**提醒**:舊版知識庫(`uploads/knowledge`)不可重建,D14 複製前**先備份**(NAS 備份規劃見 ARCHITECTURE Q3)。

## 目前進度

**B0 最小骨架部署完成**(2026-11-03,NetOps !4 合併,`develop` e53f8da;測試區四項完成條件驗證通過)。`backend/` 有內部 Token 驗證、統一錯誤格式、`/healthz`、`/readyz`、`/openapi.json`、`setupGateway` 與驗證路由 `GET /api/netops/ping`(`netops.ping.read`);CI 只部署 `netops-api` 到主機 2。舊版繼續在 IIS 運作。**這次不改寫 AI 功能**,未來由 AI 中控台提供,切換後舊版留著給 AI 用(D17、D18)。負責人:佳緯。

**F1 前端完成(MR 審查中)**:`frontend/` 由入口網複製 `src/ui/`、外框與守衛,換工程藍;全部頁面改寫並串接後端:FTP Log 檔案(PA、AD,!12)、AD 事件總覽(!13)、安全事件(!14)、流量總覽(!15)、Log 明細查詢(!16,PA 工作模式)、知識庫(!17,Markdown 經 DOMPurify)、收尾(!19)。MR 堆疊,依 !12 → !13 → !14 → !15 → !16 → !17 → !19 → 本文件 MR 的順序合併。AI 功能(問答、分析、知識庫語意搜尋與自動學習)改連結到舊版(D17、D18),舊版網址在 `frontend/src/config/links.ts` 待確認。舊版 `src/`、`server/` 依 D12、D18 保留。`netops.*` 畫面代碼要到 D1 才登記,測試區看畫面用 `DEV_EXTRA_PERMS` 或本機假 Gateway(`MOCK`);前端 SPA 部署屬 D1。

## 下一步

1. 確認 GitLab 已保護 `develop`(只有 Maintainer 能合併、不能直接推送);現有 Token 沒有 Protected Branch 讀取權限,要在 GitLab 畫面確認。
2. B1、B2 前兩批已合併(!7、!8、!9)並部署測試區(#640,`netops-api:e51b24f7`;新版機密腳本已執行、路由已發佈、權限已指派);瀏覽器經 Gateway 呼叫 `/api/netops/ftp/pa/files` 列得出檔案,容器內 FTP 可用。
3. B2 後兩批已合併(!10、!11)並在測試區驗證;後續修正 !20、!22 待合併。

## 已知狀況

- 主機 2、3 的 Windows 端 TCP 連得到 FTP;主機 2 測試區容器內已確認可用(2026-11-03),主機 3 未驗證。
- 測試區:`netops-api` 容器 `giganexus-netops-test-netops-api-1` 在主機 2 運作(Gateway 網路,未發佈 port);機密在 `/srv/giganexus/netops-secrets/`、變數在 `/srv/giganexus/deploy/netops.env`(`deploy/host2-set-secrets.sh` 產生)。
- `netops.ping.read` 目前指派給 `it-admin` 角色(2026-11-03);D2 上線時依 D15 重新指派。GigaItApp 中 `gw-it-admin` 與 `it-admin` 名稱相近,指派時注意。
- B0 監控 Key 為空檔,監控停用;D1 登記 giga-observe 拓樸後補上。
- 舊版關閉知識庫寫入的做法還沒確認(IMPL-PLAN D2)。
- `scripts/dc/ADLog-FtpBackup-3.ps1` 寫死 FTP 帳號名稱,密碼走憑證檔,版控內沒有密碼。
- 資料庫是後續階段,不在這次範圍(ARCHITECTURE §4.2)。
- 舊版 `palog.js` 的 `readLog` 讀 `.gz` 時,若來源串流比解壓先關閉會提早結束(測試以 `Readable.from` 一次送完整個檔案時重現,讀到 0 筆);FTP 串流分段送時正常。核心照 D4 原封不動搬移,沒有修改;FTP 上目前是否有 `.gz` 檔、實際是否受影響未確認。
