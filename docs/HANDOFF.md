# NetOps 交接

> 接手時先讀 `AGENT.md`,再讀 `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`。

## 目前進度

**B0 最小骨架程式完成,待合併與測試區驗證**(2026-11-03,`feature/netops-b0`)。`backend/` 有內部 Token 驗證、統一錯誤格式、`/healthz`、`/readyz`、`/openapi.json`、`setupGateway` 與驗證路由 `GET /api/netops/ping`(`netops.ping.read`);CI 只部署 `netops-api` 到主機 2。舊版繼續在 IIS 運作。**這次不改寫 AI 功能**,未來由 AI 中控台提供,切換後舊版留著給 AI 用(D17、D18)。負責人:佳緯。

## 下一步

1. 確認 GitLab 已保護 `develop`(只有 Maintainer 能合併、不能直接推送);現有 Token 沒有 Protected Branch 讀取權限,要在 GitLab 畫面確認。
2. B0 合併前:使用者在主機 2 WSL 執行 `sudo sh deploy/host2-set-secrets.sh`(API Key、`netops.env`)。
3. B0 合併後:確認 CI `deploy-api-test` 成功與自動註冊草稿 → GigaItApp「服務與路由」發佈 → 把 `netops.ping.read` 指派給負責人 → 驗證 IMPL-PLAN B0 完成條件(200 / 403 / 401)。
4. 接著做 B1 後端骨架。

## 已知狀況

- 主機 2、3 的 Windows 端 TCP 連得到 FTP;容器內未驗證。
- 主機 2 `windows-runner` 已能接 NetOps 的 job(2026-11-03 `feature/netops-b0` Pipeline #627 `check:backend` 成功);`deploy-api-test` 合併 develop 後才會跑。
- B0 監控 Key 為空檔,監控停用;D1 登記 giga-observe 拓樸後補上。
- 舊版關閉知識庫寫入的做法還沒確認(IMPL-PLAN D2)。
- `scripts/dc/ADLog-FtpBackup-3.ps1` 寫死 FTP 帳號名稱,密碼走憑證檔,版控內沒有密碼。
- 資料庫是後續階段,不在這次範圍(ARCHITECTURE §4.2)。
