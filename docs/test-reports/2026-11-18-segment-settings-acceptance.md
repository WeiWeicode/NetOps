# NetOps 網段設定(SG)測試區驗收報告(2026-11-18)

> **狀態:進行中。** 主機端唯讀查證與程式對照已完成;**畫面與權限項目需需求方在測試區操作**,結果填入 §3 的「結果」欄。本報告只驗證、不改程式。
> 上位文件:[`SEGMENT-SETTINGS-PLAN.md`](../SEGMENT-SETTINGS-PLAN.md);前一份測試報告:[`2026-11-18-segment-settings-ui.md`](2026-11-18-segment-settings-ui.md)。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 部署版本 | `origin/develop` `93f6bea`(含 !128 SG-0、!129 SG-1、!130 SG-2、!131 SG-4 邏輯、!132 SG-3 / A–D 畫面),pipeline 1105 成功 |
| 區 | 測試區(主機 2,`host2`,資料目錄 `/srv/giga-netops/test`) |
| 容器(09:38 查) | `netops-api`、`netops-kb-backup`、`netops-clickhouse`、`netops-ingest` 約 5 分鐘前重建且 healthy;`netops-pa` 24 小時、`netops-redis` 9 天,皆 healthy |

## 2. 前置(需求方確認)

| # | 項目 | 狀態 |
| --- | --- | --- |
| P1 | GigaItApp「服務與路由」發佈 4 條路由草稿:`GET/PUT /api/netops/warroom-segments`、`POST /api/netops/warroom-segment-previews`、`POST /api/netops/ip-name-lookups` | ☐ 待確認(未發佈時 API 回 404,是路由問題不是程式問題) |
| P2 | GigaItApp「選單管理」群組改名「網通設定」,順序 網段設定 10 → IP 對照表 20 → 知識庫 30(`deploy/gateway-rbac.yaml` 已是此設定) | ☐ 待確認 |
| P3 | netops-admin 帳號重新登入 | ☐ 待確認 |
| P4 | **先備份**:網段設定頁「匯出」下載目前設定 JSON(測試區此刻沒有 `warroom.json`,見 §4.1,匯出內容會是範例網段;驗收完刪掉測試網段即可) | ☐ |

## 3. 驗收項目與操作步驟

「預期」是通過條件。結果欄請填 ✅ / ❌ 與備註;❌ 附截圖或回應內容。

### 3.1 戰情室右側聚集(SG-0)

| # | 操作 | 預期 | 結果 |
| --- | --- | --- | --- |
| 1 | 開 `/netops/` 即時監控 → 戰情室 | 右側各網段節點的線**聚集到中央核心**,不再延伸到畫面下方;與左側對稱 | ☐ |

### 3.2 網段設定頁(SG-1 / SG-2 / SG-3,netops-admin)

| # | 操作 | 預期 | 結果 |
| --- | --- | --- | --- |
| 2 | 選單:網通設定 → 網段設定,順序 網段設定 → IP 對照表 → 知識庫 | 順序正確;載入顯示來源(例如「範例」) | ☐ |
| 3 | 新增網段「ZZ測試-A」(類型 VLAN、CIDR `10.250.1.0/24`)、修改名稱、刪除 | 清單即時更新;未按儲存前不影響戰情室 | ☐ |
| 4 | 拖曳排序 | 順序改變,儲存後戰情室節點順序跟著變 | ☐ |
| 5 | 儀表滿格值(吞吐量、連線數)改值 | 可輸入、非數字 / 負值被擋 | ☐ |
| 6 | 驗證:CIDR 輸入 `10.250.1.300/24`、`abc`;兩列同 id;兩列 `10.250.0.0/16` 與 `10.250.1.0/24` | 格式錯誤、id 重複顯示欄位錯誤;重疊**標出重疊**(以最精確網段為準);有錯時儲存鈕不可按或被擋 | ☐ |
| 7 | 流量預覽(按預覽) | 顯示近 5 分鐘各網段連線數與「未分類內部 IP Top 20」;不寫入設定 | ☐ |
| 8 | 儲存 → 開戰情室 | 約 5 秒內套用;`segmentsSource` 由 example 變 file,「範例網段」提示消失 | ☐ |
| 9 | **版本衝突**:開兩個分頁 A、B 都載入;A 改名並儲存;B 再改並儲存 | B 被拒(409 `NETOPS_SEGMENTS_VERSION_CONFLICT`),提示重新載入;重新載入後看到 A 的內容 | ☐ |
| 10 | 匯出 JSON → 刪一個網段並儲存 → 匯入剛才的 JSON → 儲存 | 匯出格式與原設定檔相同;匯入後清單回復;壞 JSON 有明確錯誤 | ☐ |

### 3.3 搭配 A–D(SG-4)

| # | 操作 | 預期 | 結果 |
| --- | --- | --- | --- |
| 11 | A:預覽的「未分類 IP Top 20」 | 旁顯示 IP 對照表設備名稱 / 部門;可「加入某網段」或「依此 IP 建 /24」 | ☐ |
| 12 | B:從 IP 對照表匯入(選網段列) | 只列 CIDR 型的列;匯入後名稱帶部門或備註;不含使用者個資 | ☐ |
| 13 | C:IP 對照表頁 | 多一欄「網段」(唯讀),依目前設定算出 | ☐ |
| 14 | D:戰情室滑過右側網段節點 | 提示顯示 Top 內部 IP + 設備名稱 | ☐ |

### 3.4 權限(需 viewer 帳號)

| # | 操作 | 預期 | 結果 |
| --- | --- | --- | --- |
| 15 | viewer 登入看選單 | 看不到「網段設定」(`netops.segment-page.read` 只給 netops-admin) | ☐ |
| 16 | viewer 在瀏覽器 Console 執行 `fetch('/api/netops/ip-name-lookups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ips:['10.0.0.1']})}).then(r=>r.status)`(請依 `docs/API.md` 實際請求格式調整) | 回 **403** | ☐ |
| 17 | viewer 滑過戰情室網段節點 | 提示**只有 IP**,無設備名稱 | ☐ |

### 3.5 Q10:戰情室不含 `names`

| # | 操作 | 預期 | 結果 |
| --- | --- | --- | --- |
| 18 | 瀏覽器 F12 Network 看 `/api/netops/pa-live/warroom`、`/api/netops/pa-live/risk` 回應 | 回應 JSON 沒有 `names` 欄位(程式對照見 §4.2) | ☐ |
| 19 | 即時監控 Log 表(stream) | 維持顯示姓名(有 `netops.ip-name.read` 的帳號) | ☐ |

### 3.6 備份(主機唯讀查證,見 §4)

| # | 項目 | 預期 | 結果 |
| --- | --- | --- | --- |
| 20 | 每次儲存後 `warroom/history/` | 出現 `warroom-<時間>-v<版本>.json` 舊版檔;最多 20 份 | ⏳ 待需求方儲存後由驗收人複查(目前無檔,見 §4.1) |
| 21 | `netops-kb-backup` healthy | healthy | ✅ 09:38 為 healthy |
| 22 | NAS 最新備份 tar 含 `warroom/`、不含 `ai-hourly.json` | 是 | ⏳ **今天無法驗**(見 §4.3);最早 2026-11-19 02:02 |

## 4. 已完成的唯讀查證(2026-11-18 09:38,`ssh host2`)

### 4.1 `warroom/` 目前狀態
`/srv/giga-netops/test/warroom/` 只有 `ai-hourly.json`(09:00),**沒有 `warroom.json`、沒有 `history/`**。表示測試區從未存過網段設定:頁面來源應顯示「範例」,戰情室應顯示「範例網段」提示(§3 #2、#8 的起點)。第一次儲存時沒有舊檔,是否產生 history 檔待需求方儲存後確認;**第二次儲存起**才會有舊版檔(請需求方至少存兩次)。

### 4.2 Q10 程式對照(靜態,尚待 §3 #18 實測)
- `modules/pa-live/warroom-routes.ts` 檔頭註明不附 IP 對照表 `names`,名稱只經 `POST /ip-name-lookups`(`netops.ip-name.read`)取得。
- `modules/pa-live/live-routes.ts:393-394` 只有 stream 路徑附 `names`,與「Log 表維持姓名」一致。

### 4.3 NAS 備份:今天無法驗證 `warroom/` 內容 ⚠️
- 最新備份 `netops-kb-test-20261118.tar.gz` 於 **02:02** 產生(早於部署),內容只有 `knowledge/`(1 檔),`LAST_RESULT` = `OK … files=1`。
- `deploy/kb-backup/backup.sh` 的 `done_today` 判斷:啟動時**今天已有備份就不再補備份**,所以 09:33 重建容器後沒有產生含 `warroom/` 的新備份(容器日誌只有啟動訊息)。下一次排程是 **2026-11-19 02:00**。
- 這不是 bug(符合腳本註解「啟動時若今天還沒有備份才備份」),但 SG 規劃要求「部署後即可確認」只對當天首次部署成立。**建議**:明天 02:02 後由驗收人複查最新 tar:含 `warroom/warroom.json`、`warroom/history/*`,不含 `warroom/ai-hourly.json`;或需求方決定是否由維運者手動觸發(本驗收不寫入 NAS,未執行)。
- 腳本邏輯對照:`warroom` 目錄存在才打包,排除 `warroom/ai-hourly.json` 與 `*.tmp`;核對檔數用同一排除條件。

## 5. 發現問題

目前無(畫面項目尚未操作)。需求方操作後的問題請依下列格式補在此處:

| # | 現象與重現步驟 | 回應 / 截圖 | 推測原因與檔案 | 歸屬(Gemini 畫面 / Claude 邏輯) |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

## 6. 收尾(驗收完需求方操作)

1. 把 P4 備份的 JSON 匯回,或刪掉測試網段(`ZZ測試-*`)後儲存;
2. 若測試區原本沒有設定檔,刪除測試網段後會留下 `warroom.json`(含空或剩餘清單)——是否要回到「範例」狀態由需求方決定(需維運者刪檔,本驗收未動)。

## 7. 結論

待 §3 結果填完後下結論。目前:主機端 `netops-kb-backup` healthy、程式對照無 Q10 疑點;**備份 tar 內容(#22)與 history(#20)要等儲存與明天排程才能驗**。
