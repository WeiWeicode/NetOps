# NetOps 交接

> 接手時先讀 `AGENT.md`,再讀 `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`。

## 目前進度

**D0 文件與登記完成,D13–D18 與 UI 規劃已定案**。接入 Gateway 的程式尚未開始;舊版繼續在 IIS 運作。**這次不改寫 AI 功能**,未來由 AI 中控台提供,切換後舊版留著給 AI 用(D17、D18)。負責人:佳緯。

## 下一步

1. 確認 GitLab 已保護 `develop`(只有 Maintainer 能合併、不能直接推送);現有 Token 沒有 Protected Branch 讀取權限,要在 GitLab 畫面確認。
2. 從 `origin/develop` 開分支做 B0:最小骨架部署(D13)。

## 已知狀況

- 主機 2、3 的 Windows 端 TCP 連得到 FTP;容器內未驗證。
- 工作區 AGENT §5 記載主機 3 WSL 查不到外部 DNS,與 2026-11-02 實測不一致(ARCHITECTURE D10);工作區文件未修改。
- 舊版關閉知識庫寫入的做法還沒確認(IMPL-PLAN D2)。
- `scripts/dc/ADLog-FtpBackup-3.ps1` 寫死 FTP 帳號名稱,密碼走憑證檔,版控內沒有密碼。
- 資料庫是後續階段,不在這次範圍(ARCHITECTURE §4.2)。
