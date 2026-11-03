# 後端修改紀錄

> `backend/`、`deploy/` 的修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-03 B1 後端骨架:資料存取、長時間工作與完整設定
- 工作項目:B1
- 內容:`config.ts` 新增資料目錄 `NETOPS_DATA_DIR`、FTP(密碼 `FTP_PASSWORD_FILE`,正式區只接受 `_FILE`)、同時連線上限與明細查詢上限;test / prod 缺少時啟動失敗,數字或規則寫錯也啟動失敗(舊版會靜默改用預設)。`infra/store` 建立資料存取邊界(目錄與舊版 `uploads/` 相同,D14),`/readyz` 改為檢查資料目錄可寫入。`infra/jobs` 工作只有建立者本人可查(比對工號)、每人 2 個 / 全部 6 個進行中、完成後保留 30 分鐘、有執行時間上限,重啟後回 `NETOPS_JOB_NOT_FOUND`。FTPS 預設驗證憑證(舊版一律不驗證,改成 `FTP_TLS_INSECURE=1` 才放寬)。映像檔設 `TZ=Asia/Taipei`(log 與知識庫時間沿用台灣時間)。`deploy/`:資料目錄掛載、FTP 變數與 `ftp_password` 機密;`host2-set-secrets.sh` 隱藏輸入 FTP 密碼並建立 `/srv/giga-netops/test`;CI 檢查 `ftp_password`。
- 檔案:`backend/src/config.ts`、`backend/src/app.ts`、`backend/src/infra/{store,jobs}/`、`backend/test/unit/{app,config,jobs}.test.ts`、`backend/Dockerfile`、`backend/.env.example`、`deploy/`、`.gitlab-ci.yml`、`docs/API.md`
- 驗證:`npm run typecheck`、`npm test`(31 項通過)、`npm run build`

## 2026-11-03 建立 netops-api 骨架與測試區部署
- 工作項目:B0
- 內容:由 Gateway `samples/node-backend` 複製,`gateway.project = NetOps`、`SERVICE_CODE = netops-api`(設錯時啟動失敗)、port 51292;錯誤代碼改為 `NETOPS_*`;移除樣本的 `public` 免 Token 路徑。`@giganexus/backend-sdk` 改由 GitLab npm Registry 安裝。`deploy/docker-compose.yml` 加入 Gateway 網路、不發佈 port;`host2-set-secrets.sh` 比照 giga-Portal 建立 API Key,監控 Key 先留空檔(D1 補)。
- 檔案:`backend/src/`、`backend/test/unit/app.test.ts`、`backend/Dockerfile`、`deploy/`、`.gitlab-ci.yml`
- 驗證:`npm run typecheck`、`npm test`(11 項通過)、`npm run build`;本機啟動冒煙測試
