# 網段設定頁(SG)規劃

> 狀態:規劃(需求方 2026-11-17 提出,隔天實作)。上位文件:[`WARROOM-PLAN.md`](WARROOM-PLAN.md)(§6 Q3 網段設定檔)、IP 對照表(IMPL-PLAN AC3)。
> 目的:戰情室右側「內部網段」目前靠主機上的 `warroom/warroom.json` 人工放檔;改成在畫面上維護,並和 IP 對照表互相搭配。

## 1. 選單調整

| 現在 | 改成 |
| --- | --- |
| 群組「網通知識」(`netops.group.knowledge`) | 群組名稱改「**網通設定**」;**權限代碼不改**(避免既有角色授權失效) |
| 知識庫、IP 對照表 | 不變,排在新頁之後或之前依需求方決定(Q5) |
| — | 新增選單「**網段設定**」`/netops/settings/segments` |

## 2. 頁面功能

1. **網段清單**:名稱、類型(VLAN / 核心服務)、圖示、CIDR(可多個)、排序;新增 / 修改 / 刪除 / 拖曳排序。
2. **儀表滿格值**:吞吐量、連線數(原設定檔 `gauge`)。
3. **即時驗證**:CIDR 格式、id 重複、網段重疊(重疊時以最精確的網段為準,畫面標出重疊)。
4. **流量預覽**:儲存前顯示「依新設定,近 5 分鐘各網段的連線數」與「仍未分類的內部 IP Top 20」,讓網通確認分得對不對。
5. **儲存**:整份寫入,帶版本號;版本不符(別人剛改過)拒絕並提示重新載入。戰情室在下一次更新(約 5 秒)自動套用。
6. **匯入 / 匯出**:JSON(和原設定檔同格式),方便測試區、正式區搬移。

## 3. 和 IP 對照表的搭配

IP 對照表記錄「IP / 網段 → 使用者、部門、設備名稱、設備類型、備註」,含個資,只給網管(`netops.ip-name.read`)。網段設定只放 CIDR 與名稱,不含個資。兩者搭配方式:

| # | 搭配方式 | 說明 |
| --- | --- | --- |
| A | **未分類 IP 協助分類** | 流量預覽的「未分類內部 IP Top 20」旁顯示 IP 對照表的設備名稱 / 部門(使用者有 `netops.ip-name.read` 才顯示),一鍵「加入某網段」或「依此 IP 建 /24 網段」 |
| B | **從 IP 對照表的網段列建立** | IP 對照表裡填的是網段(CIDR)的列,可選取後匯入成網段設定(名稱帶部門或備註) |
| C | **IP 對照表顯示所屬網段** | IP 對照表頁加一欄「網段」,依網段設定算出(唯讀) |
| D | **戰情室提示帶設備名稱** | 滑過右側網段節點時,Top 內部 IP 顯示設備名稱;只有 `netops.ip-name.read` 的人看得到,其他人只看 IP |

建議先做 A、C(不增加個資外露面,直接解決「怎麼分類」);B、D 視需求(Q3、Q4)。

## 4. 技術設計(Claude)

- **儲存**:沿用 `infra/store` 的 `warroom/warroom.json`(格式不變,`parseWarroomConfig` 驗證),加 `version` 欄位;寫入經具名函式 `saveWarroomConfig`,不在模組內組路徑。不進資料庫(D20)。
- **API**(後端 `/v1/*`,對外 `/api/netops/*`):
  - `GET /v1/warroom-segments`:設定 + version + `source`(file / example / invalid)
  - `PUT /v1/warroom-segments`:整份寫入,帶 version;驗證失敗 400(欄位錯誤清單),版本不符 409 `NETOPS_SEGMENTS_VERSION_CONFLICT`
  - `POST /v1/warroom-segment-previews`:用未儲存的設定算近 5 分鐘各網段連線數與未分類 Top 20(Redis 統計,不寫入)
  - 搭配 A / B 需要的 IP 對照表查詢沿用既有 `ip-name` API,權限不變
  - `x-audit-level: meta`(寫入稽核)
- **權限**(Gateway 規範,讀寫分開):新增 `netops.segment.read`、`netops.segment.write`;畫面節點 `netops.segment-page.read`(menu)、`netops.segment-page.write`(button),只給 netops-admin(同 IP 對照表)。
- **戰情室**:已會偵測設定檔變動(mtime),不需重啟;`segmentsSource` 從 example 變 file 後「範例網段」提示自動消失。
- **前端邏輯**:`api/segments.ts`、`composables/useSegmentSettings.ts`(載入、草稿、驗證、預覽、儲存、版本衝突)。
- **測試**:驗證規則、重疊判定、版本衝突、預覽計算、權限。

## 5. 分工與批次

| 批 | 內容 | 負責 |
| --- | --- | --- |
| SG-1 | 後端 API、儲存版本號、預覽、權限登記、選單群組改名 | Claude(Opus) |
| SG-2 | 前端 api / composable + mock | Claude(Opus,可與 SG-1 並行) |
| SG-3 | 網段設定頁畫面(清單、編輯、預覽、匯入匯出) | Gemini(用 SG-2 的 composable) |
| SG-4 | 搭配 A、C(未分類 IP 協助分類、IP 對照表顯示網段) | Claude 邏輯 + Gemini 畫面 |
| SG-5 | 測試區驗收、網通填入正式清單、正式區上線 | Claude(Sonnet)+ 需求方 |

## 6. 待決事項(實作前確認)

| # | 問題 | 建議 |
| --- | --- | --- |
| Q1 | 誰可以改網段設定? | 只給 netops-admin(同 IP 對照表) |
| Q2 | 頁面路徑 | `/netops/settings/segments`;群組改名「網通設定」,權限代碼不改 |
| Q3 | 搭配 B(從 IP 對照表網段列匯入)要不要做? | 先不做,A 足夠 |
| Q4 | 搭配 D(戰情室提示帶設備名稱,含個資)要不要做? | 先不做;要做時只給 `netops.ip-name.read` 的人 |
| Q5 | 選單順序 | 網段設定、IP 對照表、知識庫 |
| Q6 | 正式區與測試區的網段是否相同 | 相同時用匯出 / 匯入搬移,不自動同步 |
