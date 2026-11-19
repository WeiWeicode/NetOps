# PA 威脅特徵碼(TS)計畫

> 狀態:計畫,需求方 2026-11-19 已決定 §1.2(資料來源、結合範圍、頁面、權限、分工、TS-Q2/Q3/Q5/Q7/Q8/Q9),未定事項見 §9。TS-1 ~ TS-4 交 Gemini,依 `docs/GEMINI-PROMPT-TS.md` 開工。時程以 NexusPlan 甘特圖為準。
> 相關:`docs/WARROOM-DIRECTION-POLICY-PLAN.md`(PR 安全規則,格式與 PR-0 做法)、`docs/HANDOFF.md`「PA API 帳號降級前要做」、`docs/ARCHITECTURE.md` D6 / D20 / D22 / D23 / D27、`pa-collector/netops_pa/policies.py`、`deploy/clickhouse/schema.sql`(`pa_threat_logs`)。
> 標「**待 TS-0**」的 PAN-OS 指令、欄位與 Threat Vault 細節是推測,實測前不當事實。

## 1. 背景

### 1.1 需求

原話:「netops 規劃新增一個頁面 Palo Alto 呈現官方釋放出危險特徵碼,並與目前功能做結合」。

網通目前要知道「PA 這次內容更新加了哪些高危特徵碼、跟我們有沒有關係」,得登入 PA GUI(Objects › Security Profiles 的例外清單或 Device › Dynamic Updates 的 release note)或上 Palo Alto 官網查,無法和 NetOps 已有的威脅 log、規則、IP 對照表對起來。

### 1.2 需求方 2026-11-19 決定(照做)

| # | 項目 | 決定 |
| --- | --- | --- |
| 1 | 資料來源 | **兩者都做,本機為主**。第一階段讀 PA 本機已安裝的特徵庫(唯讀 op),內容版本變動時比對新增 / 變更 / 停用並保存版本歷史(Redis 或 `infra/store`,D20 不用關聯式資料庫)。第二階段接 Threat Vault API 補 CVE、發布日、官方說明(需求方申請 API Key、主機要能連外,Key 用 `*_FILE`) |
| 2 | 結合範圍 | 四項都做:a. 命中比對 b. 規則覆蓋 c. AI 摘要 d. 戰情室 / 安全事件連結(§5) |
| 3 | 頁面與權限 | **防火牆 › 威脅特徵碼**;`netops.pa-signature.read`(檢視)、`netops.pa-signature.refresh`(手動更新),實作階段才寫進 `deploy/gateway-rbac.yaml` |
| 4 | 分工(修正) | 原話:「我這次全給gemini做看看」→ **TS-1 ~ TS-4 全部交 Gemini**(邏輯 + 畫面,依 `docs/GEMINI-PROMPT-TS.md`);TS-5 Threat Vault 等需求方申請到 Key 再做;TS-0 由需求方在主機 2 執行 |
| 5 | 審查 | 每個 Gemini MR 都由 **Claude 審查**(`docs/reviews/YYYY-MM-DD-ts-<批>.md` 或 MR 評論,只提問題、不改 Gemini 分支);compose / env 範本 / `gateway-rbac.yaml` / CI 屬敏感變更,MR 描述寫審查者與紀錄位置 |
| 6 | 合併 | 本計畫 MR(!161)由需求方合併後,Gemini 從 `origin/develop` 開分支 |
| 7 | TS-Q2 新特徵碼範圍 | 畫面可選 **7 / 30 / 90 天,預設 30**;API `days` 只接受這三個值 |
| 8 | TS-Q3 版本歷史 | 保留 **90 份**,存差異,不存每版完整清單 |
| 9 | TS-Q5 規則覆蓋 | 第一版**只看規則有沒有掛**弱點防護 / 間諜軟體 profile,不判斷 profile 內容 |
| 10 | TS-Q7 Threat Vault 呼叫端 | 由 **`netops-pa` 收集器**呼叫,`netops-api` 不出外網;Key 用 `*_FILE` |
| 11 | TS-Q8 命中比對的 IP | IP / 名稱要有 **Log 明細權限**才顯示;只有 `netops.pa-signature.read` 只看筆數與動作分布 |
| 12 | TS-Q9 權限分配 | `read` 給 `netops-admin`、`netops-viewer`;`refresh` 只給 `netops-admin` |

## 2. 可行性與 TS-0 實測

### 2.1 預期做法(待 TS-0)

| 要讀的東西 | 預期的唯讀 op 指令(XML `type=op`) | 待確認 |
| --- | --- | --- |
| 內容版本 | `show system info` → `threat-version`、`threat-release-date`、`app-version`、`app-release-date`、`av-version`、`wildfire-version` | 欄位名稱、日期格式 |
| 弱點特徵清單 | `show predefined xpath /predefined/threats/vulnerability` | **op 是否允許 `show predefined`**、回應大小(預估數 MB~數十 MB)、讀取耗時、管理平面 CPU |
| 間諜軟體特徵清單 | `show predefined xpath /predefined/threats/phone-home` | 同上 |
| 單筆特徵 | `show predefined xpath …/vulnerability/entry[@name='<ID>']`、CLI `show threat id <ID>` | xpath 謂詞是否支援;`show threat id` 有沒有 XML 形式 |
| 特徵欄位 | 預期有 `threatname`、`severity`、`category`、`cve`、`vendor`、`reference`、`default-action`、`affected-host` | **實際欄位與出現比例** |
| 規則覆蓋要用的設定 | `show config running xpath <vsys1 / shared>/profile-group`、`…/profiles/vulnerability`、`…/profiles/spyware` | Profile Group 內容放 vsys1 還是 shared;是否同 PR-0 可用 op 讀 |
| App 清單(AI 相關性用) | `show predefined xpath /predefined/application` | 大小;是否值得讀(或改用 ClickHouse 實際出現的 App 名稱就好) |

**不用的做法**:`type=config&action=get xpath=/config/predefined/...` 要 XML API Configuration 權限,違反 D22,不採用。`request content upgrade …` 屬 request 類指令(會連更新伺服器),不送。

**病毒(AV)特徵**數量極大、log 的 `name` 多為 `Virus/...`,第一版不讀清單,只顯示 `av-version`(§9 TS-Q4)。

### 2.2 TS-0 實測腳本

`scripts/ts0_probe.py`(仿 PR-0):

- 只送白名單 op 指令(完全比對;單筆查詢只接受純數字 ID 的固定格式),不送 `type=config`、不 Commit、不寫檔到 PA。
- 每一步前後各取一次管理平面 CPU;**讀不到或 > 50% 整個停止**。步驟間等 3 秒。
- 單一回應上限 64 MB(超過中止該步)、逾時 120 秒;都可用參數調。
- 只輸出:回應大小、耗時、解析時間、筆數、ID 範圍、子欄位名稱與出現次數、severity / default-action 分布、有 CVE 的筆數、內容版本。**不輸出特徵內容、不輸出 API Key**(Key 讀 `PA_POLICY_API_KEY_FILE` → `PA_API_KEY_FILE`,同收集器)。

**執行(需求方,測試區主機 2)**:主機 2 SSH 登入後是 PowerShell,Docker 在 WSL 內(`wsl -u root -e docker …`)。

1. 開發機(NetOps repo 目錄)把腳本複製到主機 2 的 `user` 家目錄(Windows `C:\Users\user\ts0_probe.py` = WSL `/mnt/c/Users/user/ts0_probe.py`):

   ```powershell
   scp scripts/ts0_probe.py host2:ts0_probe.py
   ```

2. 登入主機 2(`ssh host2`),在 PowerShell 找測試區 netops-pa 容器(compose 產生的名稱,不是固定的 `netops-pa`)並放進腳本:

   ```powershell
   $c = wsl -u root -e docker ps -q --filter name=netops-pa
   $c   # 應只有一個 ID;有多個時用 wsl -u root -e docker ps 看名稱再指定
   wsl -u root -e docker cp /mnt/c/Users/user/ts0_probe.py "${c}:/tmp/ts0_probe.py"
   ```

3. 執行預設步驟(不含 App 清單),JSON 結果存在主機 2 家目錄,進度印在畫面:

   ```powershell
   wsl -u root -e docker exec $c python /tmp/ts0_probe.py > ts0-result.json
   ```

4. 預設步驟正常、CPU 低時,再單獨讀 App 清單(選做):

   ```powershell
   wsl -u root -e docker exec $c python /tmp/ts0_probe.py --only application > ts0-app.json
   ```

5. 收尾:`wsl -u root -e docker exec $c rm /tmp/ts0_probe.py`(容器重建也會清掉)。

- `--only` 可單獨重跑某步(例如 `--only system-info,vulnerability`;單筆查詢要 `--only vulnerability,single`;步驟名稱寫在腳本開頭),`--cap-mb`、`--timeout` 可調。
- 腳本讀容器內既有的 `PA_HOST`、`PA_POLICY_API_KEY_FILE` / `PA_API_KEY_FILE`,不需另外給 Key。

**要回報的數字**(貼 JSON 或以下各項即可):

1. `system-info`:各內容版本與發布日(`threat-version`、`app-version` 等)。
2. `vulnerability`、`phone-home`:`ok`、`bytes`、`seconds`、`parseSeconds`、`entries`、`fields`(前 40 個)、`severity`、`defaultAction`、`withCve`、`cpuBefore` → `cpuAfter`;失敗時的 `error` / `detail`。
3. `single-entry`、`show-threat-id`:是否成功、大小、耗時。
4. `profile-group-*`、`vp-profiles-*`、`as-profiles-*`:哪一個位置(vsys1 / shared)有資料、`entries`。
5. `application`(選做):同 2。
6. 整體:有沒有 `stopped`(CPU 超標)。

### 2.3 TS-0 結果怎麼影響設計

| 實測結果 | 設計 |
| --- | --- |
| 清單可讀、< 10 秒、CPU 增加 < 10 個百分點 | 照 §4:**內容版本變了才讀全清單**,每 30 分鐘只讀 `show system info` |
| 可讀但很大或很慢(> 30 秒或 > 50 MB) | 改成只在版本變動時、離峰時段讀;收集器端串流解析(`iterparse`)只留需要的欄位 |
| `show predefined` 被拒絕(權限或不支援) | 第一階段改成只記內容版本 + log 中實際出現的特徵 ID,特徵說明全靠第二階段 Threat Vault(§6),§9 TS-Q1 重新決定 |
| 單筆查詢可用 | 抽屜可「按需查詢」未收錄的 ID(需經收集器、限流);不可用時抽屜只用快照 |
| Profile Group 在 shared | 規則覆蓋(§5.2)讀 shared 位置 |

## 3. 權限風險

- 預期只用 **Operational Requests**(同 PR-0 結論,`show config running`、`show predefined` 都是 op)。TS-0 確認 `show predefined` 不需要 Configuration 權限;若需要,依 D22 **不開**,改走 §2.3 第 3 列。
- PA 的 Operational Requests 權限無法限制指令(HANDOFF 已註記),程式端靠白名單:新模組 `signatures.py` 用自己的 `ALLOWED_CMDS`(完全比對)與 `PolicyApi` 同做法,`call()` 也檢查。
- 低頻:版本檢查 30 分鐘一次;全清單只在版本變動或手動時讀;送出前看管理平面 CPU(E4 門檻 50%);測試區暫停輪詢(`control.poll_paused`)時不送。
- Key 只在 `netops-pa`;`netops-api` 不碰 PA。Threat Vault Key(第二階段)另外一把、`*_FILE`,只放在呼叫 Threat Vault 的那個服務(§6)。

**接上 HANDOFF「PA API 帳號降級前要做」表,新增一列**(實作合併後由文件 MR 寫進 HANDOFF;本次不改 HANDOFF):

| 功能 | 送的請求 | 需要的 XML API 權限 |
| --- | --- | --- |
| 威脅特徵碼(`signatures.py`,TS-1) | op `show system info`、`show predefined xpath /predefined/threats/{vulnerability,phone-home}`(單筆 `entry[@name=…]`)、`show config running xpath …/profile-group`、`…/profiles/{vulnerability,spyware}`、`show system resources` | Operational Requests(**待 TS-0**) |

帳號若降級成只剩 Log:特徵庫、規則收集、即時監控都會停;特徵碼頁面只能靠第二階段 Threat Vault + ClickHouse 的威脅 log(§9 TS-Q6)。

## 4. 資料模型與保留

```
netops-pa(signatures.py,唯讀 op) ──► netops-redis(目前版本快照 + 狀態)
                                         └► netops-api ──► infra/store(版本歷史、差異) ──► NAS 備份
ClickHouse pa_threat_logs(90 天) ──► netops-api(命中比對,唯讀帳號)
```

### 4.1 收集器(TS-1)

- 每 30 分鐘讀 `show system info`;`threat-version` 與上次不同、或手動請求、或 Redis 沒快照時,才讀全清單。
- 正規化每筆特徵:`id`(純數字字串)、`kind`(`vulnerability` / `spyware`)、`name`、`severity`、`category`、`cves[]`、`vendorIds[]`、`references[]`(只留網址)、`defaultAction`、`affectedHost`、`minVersion`(若有)。欄位依 TS-0 的 `fields` 調整;文字欄位截斷 1024(同 `policies.MAX_TEXT`)。
- 寫 Redis(鍵名照 PA-LIVE-PLAN §4 慣例,前綴 `netops:pa:sig`):
  - `…:snapshot`:`{ fetchedAt, threatVersion, threatReleaseDate, appVersion, counts, hash, items[] }`(若 TS-0 顯示整份太大,改成 `…:items:<kind>` 分開存)。
  - `…:status`:同 `POLICY_STATUS` 欄位(state、message、lastRunAt、lastOkAt、trigger、mgmtCpu、durationMs、count、threatVersion)。
  - `…:refresh` / `…:cool`:手動請求與冷卻(同 PR)。
- 空清單、解析失敗、超過上限:標失敗、**保留上一份快照**(AGENT.md §5)。

### 4.2 版本歷史(TS-2,`netops-api`)

- 後端讀到快照的 `threatVersion` 跟最新一份歷史不同時,和上一版比對,存一份**差異**到 `infra/store`(例如 `pa-signature/history/<threatVersion>.json`):`added[]`、`changed[]`(列出改了哪些欄位,例如 severity、defaultAction)、`removed[]`(停用 / 移除)。
- **只存差異 + 版本摘要,不存每版全量**(全量只在 Redis 最新一份);保留 90 份(TS-Q3 已決定)。納入 NAS 備份(同 `warroom/history/`)。
- 「新特徵碼」定義:最近 N 天內 `added` 的 ID;N 只能是 7 / 30 / 90,預設 30(TS-Q2 已決定)。

## 5. 四項結合

### 5.1 a. 命中比對(TS-2)

- `pa_threat_logs.name` 是 `$threatid`,格式 `名稱(ID)`,例如 `generic:xxx(52316871)`;ID 用 ClickHouse `extract(name, '\\((\\d+)\\)$')` 取出。另一種格式(只有 ID 或無括號)待 TS-0 後用測試區資料確認。
- 查詢:指定特徵 ID 清單(新特徵碼,上限 500 個,用 `query_params` 傳陣列)× 時間範圍(預設 30 天,最長 90 天,`log_type = 'threat'`)→ 每個 ID 的命中筆數、首次 / 最後時間、`action` 分布(擋:`drop` / `reset-*` / `block-*`;只告警:`alert` / `allow`)、前 10 來源 / 目的 IP。
- IP 顯示(TS-Q8 已決定):有 Log 明細權限才回 / 顯示 IP;只有 `netops.pa-signature.read` 時只回筆數與動作分布(後端依身分權限決定是否回 IP 欄位,不只靠前端隱藏)。
- IP 加名稱:沿用 `ip-names` 規則 — 只有 `netops.ip-name.read` 才在前端呼叫 `POST /ip-name-lookups`;名稱不寫進快照、歷史、AI 內容。
- 「看明細」連到既有 Log 明細(`/v1/pa/log-searches`,帶 threat + 特徵名稱 / IP + 時間範圍),不另做明細 API。
- 效能:查詢一律有時間上限;30 天以內同步回應(目標 < 10 秒),> 30 天或預估超過 10 秒改走工作模式(D6;沿用 `log-searches` 的工作機制或比照 D35「30 秒內同步、超過轉工作」)。TS-0 之後用測試區資料量量一次。

### 5.2 b. 規則覆蓋(TS-2)

- 資料來源:PR 收集器快照(`policies.py` 的 `profileGroup`、`profiles`)+ TS-1 讀的 Profile Group 內容(群組裡有沒有 vulnerability / spyware)。
- 列出:`action = allow`、未停用,且**沒有弱點防護或沒有間諜軟體 profile**(群組展開後判斷)的規則,欄位:編號(`position`)、名稱、zone、應用、命中數、缺哪一種。點規則開既有規則抽屜(`usePolicyRuleDrawer`)。
- 進一步(選配):新特徵碼命中 log 的 `rule` 欄位如果是「沒有對應 profile」的規則 → 標「此規則沒有防護,命中只是 log」。
- 群組不存在、讀不到 profile 內容時標「無法判定」,不當成有防護。
- Profile 本身的動作(例如 VP profile 對 critical 只 alert)第一版不判斷(TS-Q5 已決定:只看有沒有掛)。

### 5.3 c. AI 摘要(TS-3)

- `POST /v1/ai/explanations`(既有)加 `kind: pa-signature`,或新路徑由 TS-3 定;權限綁 `netops.ai.use` + `netops.pa-signature.read`(同 PR-5 做法)。
- 送給 AI 主機(D23,`LLM_URL`)的內容**只有統計**(AGENT §7.4):本次內容版本、新增高危(critical / high)特徵的 ID、名稱、severity、CVE、預設動作;本環境近 30 天出現的前 N 個 App 名稱與筆數、這些特徵的命中筆數與動作分布、規則覆蓋缺口條數。**不送 IP、姓名、原始 log**。
- 輸出:哪些新特徵可能跟本環境有關(依 App / 廠商 / 已有命中)、建議檢查的規則;標「AI 建議,需網通確認」(只在開頭,同 PR-5 決定)。
- 新增特徵太多時只送前 50 筆高危(依 severity、有命中優先),並告訴 AI 總數。

### 5.4 d. 戰情室 / 安全事件連結(TS-2 邏輯、TS-4 畫面)

- **特徵碼說明抽屜**:安全事件、Log 明細、戰情室抽屜裡的威脅名稱可點 → 取出 ID → `GET /v1/pa-signatures/{id}` → 顯示名稱、等級、CVE、預設動作、首次出現的內容版本、近 30 天命中統計;第二階段加官方說明與發布日。快照沒有的 ID 顯示「本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)」。
- **戰情室提示**:戰情室後端彙整時,若威脅事件的特徵 ID 屬於「新特徵碼」集合 → 回傳選填欄位 `newSignatureHits`(ID、名稱、筆數),前端顯示提示列;舊前端忽略不影響。集合由 netops-api 從版本歷史取,快取 5 分鐘。
- 邏輯放 composable(`usePaSignatureDrawer`,仿 `usePolicyRuleDrawer`),畫面接線交 Gemini。

## 6. 第二階段:Threat Vault API(TS-5)

- 用途:補 CVE 詳情、官方發布日、官方說明、首次 / 最後更新的內容版本。
- **待確認(需求方申請 Key 後)**:API 網址與版本(預期 `https://api.threatvault.paloaltonetworks.com/service/v1/threats`)、驗證標頭(預期 `X-API-KEY`)、速率限制、回應欄位、使用條款是否允許快取。以下都以實測與官方文件為準,目前不當事實。
- 呼叫端:`netops-pa` 收集器(TS-Q7 已決定),`netops-api` 不出外網。Key 用 `THREAT_VAULT_API_KEY_FILE`;正式區只接受 `_FILE`。
- 做法:只查「新增特徵 + 有命中的特徵」的 ID,批次、限流、結果快取(Redis 30 天或併入版本歷史),**只送特徵 ID**,不送本環境任何資料。
- 主機連外:主機 2 / 3 要能連 Threat Vault(經 proxy 或防火牆放行),由需求方 / 網通確認;連不到時頁面標「官方資料無法取得」,第一階段功能不受影響。

## 7. API 草案(TS-2;路徑與欄位實作時再定,寫進 API.md)

| 方法 / 路徑 | 權限 | 說明 | 逾時 |
| --- | --- | --- | --- |
| `GET /v1/pa-signatures` | `netops.pa-signature.read` | 清單;篩選 `kind`、`severity`、`q`(名稱 / ID / CVE)、`isNew`、`hasHits`;分頁(`pageSize` ≤ 100)。回 `{ items: [{ id, kind, name, severity, category, cves, defaultAction, firstVersion, isNew, hits30d? }], total, page, pageSize, threatVersion, fetchedAt }` | 讀 Redis,< 1 秒 |
| `GET /v1/pa-signatures/{id}` | `netops.pa-signature.read` | 單筆(抽屜用);含 `references`、`firstVersion`、`changes[]`、`vault?`(第二階段) | < 1 秒 |
| `GET /v1/pa-signature-versions` | `netops.pa-signature.read` | 內容版本清單 `{ items: [{ threatVersion, releaseDate, savedAt, added, changed, removed }] }` | < 1 秒 |
| `GET /v1/pa-signature-versions/{version}/diffs` | `netops.pa-signature.read` | 該版差異(分頁) | < 1 秒 |
| `POST /v1/pa-signature-hit-queries` | `netops.pa-signature.read`(IP 欄位另要 Log 明細權限,TS-Q8) | 命中比對(`days` 7 / 30 / 90):`{ ids[] ≤ 500 | scope: 'new', from, to }` → 每 ID 筆數、時間、動作分布、前 10 IP;超過同步時間回 `202 { jobId }`,`GET /v1/pa-signature-hit-queries/{id}` 取結果(D6) | 同步 ≤ 10 秒,否則工作模式 |
| `GET /v1/pa-signature-coverage` | `netops.pa-signature.read` + `netops.pa-policy.read` | 規則覆蓋(§5.2) | < 1 秒(讀快照) |
| `POST /v1/pa-signature-refreshes` | `netops.pa-signature.refresh` | 手動重新整理(冷卻 5 分鐘,收集器端另限 60 秒) | 立即回 202 |
| `GET /v1/pa-signature-status` | `netops.pa-signature.read` | 收集狀態(最後成功、CPU、失敗原因) | < 1 秒 |

- 錯誤代碼 `NETOPS_PA_SIGNATURE_*`(例如 `_UNAVAILABLE` 快照不存在、`_COOLDOWN`、`_QUERY_INVALID`);Redis / ClickHouse 等外部依賴失敗時照 R1 既有規則**不回 5xx**(避免 BFF 斷路器累積),改回明確代碼與狀態,畫面標示資料不完整。
- 命中查詢回應含 IP:設 `x-audit-level: meta`(同 Log 明細)。
- RBAC(實作階段):`netops.pa-signature-page.read`(menu,`parent: netops.group.firewall`,`includes: [netops.pa-signature.read]`)、`netops.pa-signature-page.refresh`(button,`includes: [netops.pa-signature.refresh]`)、`netops.pa-signature-page.ai`(button,`includes: [netops.ai.use, netops.pa-signature.read]`);角色分配 TS-Q9。

## 8. 分批與完成標準

| 批次 | 內容 | 負責 | 分支(從 `origin/develop` 最新開) | 完成標準 |
| --- | --- | --- | --- | --- |
| TS-0 | 唯讀實測(§2.2) | **需求方**在主機 2 執行;Claude 解讀並更新計畫 | — | 回報 §2.2 的數字;更新 §2.3、§4.1 欄位,寫 `docs/test-reports/YYYY-MM-DD-ts0-probe.md` |
| TS-1 | 收集器 `signatures.py`(版本檢查、全清單、Profile Group、白名單、CPU 保護、Redis 快照、手動請求) | **Gemini**;Claude 審查 | `feature/ts-1` | pytest(`tests/fake_pa.py` 擴充)、ruff 過;審查重點:白名單、Key 不進日誌、CPU 保護 |
| TS-2 | 後端 API(§7)、版本歷史差異、命中比對、規則覆蓋、戰情室 `newSignatureHits`;RBAC;前端 `api/paSignature.ts`、composable | **Gemini**;Claude 審查 | `feature/ts-2`(TS-1 未合併時堆疊,MR 寫依賴順序) | 後端 typecheck、test、test:int;前端 test、build;OpenAPI 必填欄位 |
| TS-3 | AI 摘要(統計組裝、prompt、API) | **Gemini**;Claude 審查 | `feature/ts-3` | 單元測試確認送出內容無 IP / 姓名;測試區實跑一次 |
| TS-4 | 頁面「防火牆 › 威脅特徵碼」(清單、版本差異、命中、規則覆蓋、AI)、各頁威脅名稱抽屜接線、戰情室提示列 | **Gemini**;Claude 審查 | `feature/ts-4` | 前端 test、build;頁面驗收(需求方 + 網通) |
| TS-5 | Threat Vault 接入 | 需求方申請到 Key、確認連外後再指派 | — | Key 只走 `_FILE`;連不到時正確降級 |
| 審查 | 每個 Gemini MR | **Claude** | — | `docs/reviews/YYYY-MM-DD-ts-<批>.md` 或 MR 評論;只提問題,不改 Gemini 分支 |
| 文件 | API.md、ARCHITECTURE(新 D 編號或 D22 補充)、PA-LIVE-PLAN §4 鍵名、HANDOFF 帳號降級表、PROJECT-MAP、DevelopmentProcess(依各 MR 描述「要寫進文件的變更」) | 需求方指派 | `docs/…` | — |
| 合併、上線 | 合併各 MR;GigaItApp 路由 / 選單 / 權限、正式區部署 | **需求方** | — | — |

驗收(測試區):內容版本與 PA GUI(Dashboard / Dynamic Updates)一致;隨機抽 10 個特徵 ID 的名稱、等級、CVE 與 PA GUI(Objects › Security Profiles › Vulnerability Protection 的例外搜尋)一致;下一次內容更新後出現差異紀錄;命中筆數與 Log 明細一致;規則覆蓋清單與 PA GUI 抽 5 條比對。

## 9. 需求方決定事項(含已決定)

| # | 問題 | 選項 | 建議 |
| --- | --- | --- | --- |
| TS-Q1 | TS-0 若 `show predefined` 不能用 | A. 只靠 Threat Vault(第二階段提前)B. 只記內容版本 + log 出現的 ID C. 申請 Configuration 權限(違反 D22) | 未定,等 TS-0 結果;建議 A + B 並行,不選 C |
| TS-Q2 | 「新特徵碼」的範圍 | — | **已決定(2026-11-19)**:畫面可選 7 / 30 / 90 天,預設 30;API `days` 只接受這三值 |
| TS-Q3 | 版本歷史保留 | — | **已決定(2026-11-19)**:90 份,存差異,不存每版完整清單 |
| TS-Q4 | 病毒(AV)/ WildFire 特徵 | A. 第一版只顯示版本 B. 也讀清單 | 未定,等 TS-0 結果;建議 A |
| TS-Q5 | 規則覆蓋要不要判斷 profile 內容 | — | **已決定(2026-11-19)**:第一版只看有沒有掛弱點防護 / 間諜軟體 profile |
| TS-Q6 | 帳號降級成只剩 Log 時 | A. 特徵碼頁改只用 Threat Vault + log B. 保留 Operational Requests | 未定,上線前和 HANDOFF 降級確認一起決定 |
| TS-Q7 | Threat Vault 呼叫放哪 | — | **已決定(2026-11-19)**:`netops-pa` 收集器;`netops-api` 不出外網;Key 用 `*_FILE` |
| TS-Q8 | 命中比對結果含 IP 的權限 | — | **已決定(2026-11-19)**:IP / 名稱要有 Log 明細權限才顯示;只有 `netops.pa-signature.read` 只看筆數與動作分布 |
| TS-Q9 | 權限分配 | — | **已決定(2026-11-19)**:`read` 給 `netops-admin`、`netops-viewer`;`refresh` 只給 `netops-admin` |
| TS-Q10 | 正式區何時開 | A. 測試區驗收後立即 B. 與 PR 收集器一起開 | 未定,上線前決定;建議 B |
