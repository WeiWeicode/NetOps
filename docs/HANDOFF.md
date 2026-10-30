# NetOps 交接

> 接手時先讀 `AGENT.md`,再讀 `docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`。

## 目前進度

**D0 文件與登記**進行中。接入 Gateway 的程式尚未開始;舊版繼續在 IIS 運作。

## 下一步

1. 合併 NetOps、工作區、Gateway 的 D0 文件 MR。
2. 確認專案負責人(ARCHITECTURE Q1);Maintainer 建立 `develop`(Q2)。
3. 從 `origin/develop` 開分支做 B0 串流驗證,結果決定 AI 採串流或輪詢(D7)。

## 已知狀況

- 主機 2、3 的 Windows 端 TCP 連得到 FTP、LLM、Embedding、Qdrant;容器內未驗證。
- `scripts/dc/ADLog-FtpBackup-3.ps1` 寫死 FTP 帳號名稱,密碼走憑證檔,版控內沒有密碼。
- 資料庫是後續階段,不在這次範圍(ARCHITECTURE §4.2)。
