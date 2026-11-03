# 後端修改紀錄

> `backend/`、`deploy/` 的修改;新紀錄加在最上方,格式見 `AGENT.md` §11。

## 2026-11-03 建立 netops-api 骨架與測試區部署
- 工作項目:B0
- 內容:由 Gateway `samples/node-backend` 複製,`gateway.project = NetOps`、`SERVICE_CODE = netops-api`(設錯時啟動失敗)、port 51292;錯誤代碼改為 `NETOPS_*`;移除樣本的 `public` 免 Token 路徑。`@giganexus/backend-sdk` 改由 GitLab npm Registry 安裝。`deploy/docker-compose.yml` 加入 Gateway 網路、不發佈 port;`host2-set-secrets.sh` 比照 giga-Portal 建立 API Key,監控 Key 先留空檔(D1 補)。
- 檔案:`backend/src/`、`backend/test/unit/app.test.ts`、`backend/Dockerfile`、`deploy/`、`.gitlab-ci.yml`
- 驗證:`npm run typecheck`、`npm test`(11 項通過)、`npm run build`;本機啟動冒煙測試
