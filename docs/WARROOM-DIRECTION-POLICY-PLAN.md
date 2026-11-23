# 戰情室進出方向(WD)與 PA 安全規則檢視(PR)計畫

> 狀態:計畫,需求方 2026-11-18 已決定 §4(Q1–Q4),2026-11-19 加 Q5(規則圖分頁,§3.5)、Q6(規則搭配 IP 對照表,§3.6)。時程以 NexusPlan 甘特圖為準。
> 相關:`docs/WARROOM-PLAN.md`(戰情室)、`docs/SEGMENT-SETTINGS-PLAN.md`(網段設定)、`docs/ARCHITECTURE.md` D19 / D22 / D31、`pa-collector/netops_pa/poller.py`、`pa_query.py`。

## 1. 背景

1. **戰情室方向看不出來**:畫面是「左邊外部、右邊內部」,不是「左進右出」。內部連到外部(同仁上網、連雲端)也算在左邊的國家節點,但粒子一律從左往右流,網通會誤以為全部是連入。後端分類時已經有 `inbound` 旗標(`backend/src/modules/pa-live/warroom.ts` `createClassifier`),只是 link 沒有回傳方向。
2. **想在 NetOps 看 PA 的 Security 規則**:目前要登入 PA GUI(Policies › Security,168 條)才看得到。想知道 SDK(pan-os-python)能不能把每條規則的完整內容撈出來。

## 2. WD:戰情室進出方向(小改動)

### 2.1 方向定義

| 來源 | 目的 | 方向 | 畫面 |
| --- | --- | --- | --- |
| 外部 | 內部 | **連入** | 粒子 左 → 核心 → 右 |
| 內部 | 外部 | **連出** | 粒子 右 → 核心 → 左(反向) |
| 內部 | 內部 | 內部互連 | 維持 左 → 右(來源節點「內部互連」) |
| 外部 | 外部 | 轉送 | 維持 左 → 右(網段「未分類」) |

節點位置不變(左外部、右內部),只改粒子方向和顏色,版面不動。

### 2.2 後端(WD-1)

- `WarroomLink` 加三個**選填**欄位(每秒,3 位小數):`outConn`、`outDeny`、`outThreat`,是 `conn` / `deny` / `threat` 裡「連出」的部分;連入 = 總數 − 連出。舊前端忽略就好,不破壞相容。
- `WarroomSource` / `WarroomSegment` 加 `outConn`(期間內筆數),節點下方顯示「入 x / 出 y」用。
- 分類沿用 `createClassifier` 的 `inbound`:`!inbound && externalIp != null` 為連出;內部互連、轉送不算連出。
- pair key 加方向,聚合時分開累計;抽樣放大倍數(scale)同樣套用。
- 不加新 API、不加權限代碼、不加設定。單元測試補:連入 / 連出 / 內部互連 / 轉送四種、抽樣放大、Top 攻擊 IP 仍只算連入。

### 2.3 前端邏輯(WD-2)

- `frontend/src/api/warroom.ts` 型別加選填欄位;`useWarroom.ts` 提供純函式 `linkDirectionProbs(link)` → `{ out, inDeny, outDeny, inThreat, outThreat }`(欄位缺少時視為全部連入)。
- 篩選(Q1 決定要做):`direction: 'all' | 'in' | 'out'`,存在 composable 狀態(可記在 `localStorage` 當偏好),影響粒子、節點數字與節點排序,不重新呼叫 API。選「連出」時左側攻擊 IP 節點淡化(它們只有連入)。切換放在頂列(`GSegmented`)。

### 2.4 前端畫面(WD-3,`WarroomCanvas.vue`、`LegendPanel.vue`)

- 產生粒子時依 `out` 機率決定方向;連出粒子走反向路徑:右節點 → `ext(di)` → 核心 → `ent(si)` → 左節點(現有 `seg` 0/1/2 倒過來跑)。
- 顏色:**連入青綠**(現行 `34,211,166`)、**連出藍紫**(建議 `139,124,255`;網段端現行藍色改成跟著方向);阻擋紅、威脅橘不變。連出被阻擋時在核心右側(`ext`)爆火花。
- 節點標籤下方加小字「↘ 入 1,234 · ↗ 出 5,678」(數字照現行 conn/5m 格式);左側攻擊 IP 節點只有連入,不顯示出。
- 圖例(說明面板)加「連入 / 連出」兩個色塊與一句「左邊是外部端:連入的來源、連出的目的地都在左邊」。
- 效能:粒子總數上限、每秒產生預算不變(WARROOM-PLAN §7 的量測方法回歸一次)。

### 2.5 完成標準

- 後端 `typecheck`、`test`、`test:int`;前端 `typecheck`、`test`(`warroom.test.ts`、`warroom.mount.test.ts`)、`build` 通過。
- 測試區真實流量:看得出兩個方向;Taiwan / United States 等節點顯示入 / 出數字;每幀時間與 fps 不比 WARROOM-PLAN §7 差。
- 驗收報告 `docs/test-reports/YYYY-MM-DD-warroom-direction.md`。

## 3. PR:PA 安全規則檢視

### 3.1 可行性結論

**可以**。pan-os-python(已固定 1.13.1)的 `panos.policies.Rulebase` + `SecurityRule.refreshall(rulebase, running_config=True)` 讀出每條規則,欄位涵蓋 PA GUI 表格的所有欄:

| PA GUI 欄位 | SecurityRule 屬性 |
| --- | --- |
| Name / Tags / Type | `name`、`tag`、`type`(universal / intrazone / interzone) |
| Source Zone / Address / User / Device | `fromzone`、`source`、`source_user`、`source_devices` |
| Destination Zone / Address / Device | `tozone`、`destination`、`destination_devices` |
| Application / Service | `application`、`service` |
| Action / Profile | `action`、`group`(Profile Group)或 `virus` / `spyware` / `vulnerability` / `url_filtering` / `file_blocking` / `wildfire_analysis` |
| Options | `log_start`、`log_end`、`log_setting`、`schedule`、`disabled`、`description`、`negate_source` / `negate_destination`、`uuid` |

另外兩件 GUI 表格看不到、對網通很有用的資料:

- **物件展開**:規則裡是物件名稱(例如 `GSC HF Netgroup`、`Net_10.10.48...`),用 `AddressObject` / `AddressGroup` / `ServiceObject` / `ServiceGroup` / `ApplicationGroup` / `Tag` 的 `refreshall` 一併讀出,畫面可展開成實際 IP / port。
- **命中次數**:op 指令 `show rule-hit-count vsys vsys-name vsys1 rule-base security rules all`(唯讀 op,現有權限可用)回每條規則的命中數、最後命中時間、建立 / 修改時間,可找出長期沒命中的規則。

### 3.2 權限風險(要先確認)

- 讀規則是 XML API `type=config`(`action=show` 讀 running config),**需要 API 角色的 XML API「Configuration」權限**。現有 API Key 依 D22 / D31 只有 Operational Requests 與 Log。
- 依 PAN-OS 管理角色設計,XML API 的 Configuration 權限**看起來不分讀寫**(在 PA 上實測確認)。打開就代表這把 Key 理論上能改設定,違反 D22「只讀」的原意。
- 不加權限的替代:op 指令 `show config running`(可帶 xpath)回 running config XML,可能只需 Operational Requests。**PR-0 要實測**哪一種現有 Key 能用。
- 緩解(不論哪種):① 專用 PA 帳號與 Key,不和輪詢共用;② 收集器程式白名單只允許 `action=show`(或指定 op),跟 `pa_query.py` 的 `_ALLOWED_CALLS` 同做法;③ 低頻(建議每 30 分鐘 + 手動重新整理,冷卻 5 分鐘),送出前看管理平面 CPU(沿用 E4 門檻 50%);④ Key 只在 `netops-pa`,`netops-api` 不碰 PA。

### 3.3 設計(D19 / D24 延伸)

```
netops-pa(pan-os-python,唯讀) ──► netops-redis(快照 JSON + 版本) ──► netops-api ──► 頁面
                                       └► NAS 備份(kb-backup)
```

- **PR-0 實測(Claude,唯讀)**:對 PA-560 用現有 Key 試 `show config running xpath …/rulebase/security`、`show rule-hit-count`;確認回應大小、管理平面 CPU 影響、`source_devices` 等欄位在 PA-560 版本是否存在。只讀、不 Commit。結果決定 §4 Q3。
- **排序**:PA 由上往下比對,第一條符合的規則生效,所以**順序就是規則的一部分**。`refreshall` 回傳的順序即 rulebase 順序,快照保存 `position`(1 起算,同 PA GUI 的編號);API 與畫面預設依此排序,篩選後仍顯示原編號。
- **PR-1 收集器(Opus)**:`pa-collector/netops_pa/policies.py`:讀規則 + 物件 + 命中數 → 正規化成 JSON(順序、欄位、物件展開結果)→ 寫進 netops-redis 快照(鍵名照 PA-LIVE-PLAN §4 慣例,含 `fetchedAt`、內容 `hash`)。命中數每次更新;**規則內容雜湊變了才存新版本**。版本歷史放 `netops-api` 的檔案儲存(`infra/store`,同 SG `warroom/history/` 做法,保留最近 50 份並納入 NAS 備份),Redis 只放最新快照。測試用 `tests/fake_pa.py` 擴充。
- **PR-2 後端 API(Opus)**:
  - `GET /v1/pa-policies`:清單(依 `position` 排序;可依名稱 / zone / IP / 應用 / 動作 / 未命中篩選;IP 篩選比對展開後的物件)。
  - `GET /v1/pa-policies/{name}`:單條含展開與命中數。
  - `POST /v1/pa-policy-refreshes`:手動重新整理(冷卻 5 分鐘)。
  - `GET /v1/pa-policy-versions`、`GET /v1/pa-policy-versions/{id}/diffs`:版本清單與差異(新增 / 刪除 / 移動位置 / 欄位變更,逐條列出)。PA 的變更者與 Commit 時間另由 op `show config audit` / Config log 補(PR-0 一併確認可否讀)。
  - 新權限代碼(建議)`netops.pa-policy.read`(admin、viewer)、`netops.pa-policy.refresh`(admin);寫進 `deploy/gateway-rbac.yaml`,依 Gateway 規範登記。
- **PR-3 前端邏輯(Opus)**:`api/paPolicy.ts`、`composables/usePaPolicy.ts`(含版本差異),以及規則圖資料 `composables/usePaPolicyViz.ts`(§3.5)。
- **PR-4 頁面(Gemini)**:「防火牆 › 安全規則」頁,表格版面仿 PA GUI(編號、來源 / 目的分組欄、物件可展開、命中數與最後命中、停用規則淡色);「變更紀錄」分頁顯示版本差異;「排序檢查」分頁顯示 PR-5 結果;「規則圖」分頁(§3.5)。另:Log 明細與戰情室抽屜的規則名稱可點開規則內容(log 已有 `rule` 欄位)。
- **跨頁規則抽屜(已接畫面,2026-11-23,!180)**:Log 明細查詢(表格規則名稱、明細視窗「規則內容」按鈕)、戰情室 Traffic Log 表、即時排行的規則排行可點開 `PolicyRuleDrawer`,邏輯沿用 `usePolicyRuleDrawer`。沒有 `netops.pa-policy.read` 與 PA 兩條內建預設規則(intrazone / interzone-default)顯示純文字。安全事件、時段明細抽屜不顯示規則名稱,未接;流量總覽的阻擋規則 / 規則命中排行維持跳 Log 明細查詢。**需求方 2026-11-23 決定:找不到規則或無快照時維持跳出提示、不開抽屜**(與威脅特徵碼頁一致)。
- **PR-5 排序檢查與 AI 判讀(Opus)**:分兩層,**先用程式算、再讓 AI 解釋**,避免 AI 對 168 條規則自行比對而漏判或誤判。
  1. **程式檢查(確定性)**,每項都標出相關規則編號:
     - **遮蔽(shadowed)**:後面的規則條件完全被前面某條涵蓋(zone、位址展開後的 CIDR、使用者、應用、服務都是子集),永遠不會命中。
     - **衝突遮蔽**:被遮蔽且動作不同(例如前面 allow 寬、後面 deny 窄),最需要處理。
     - **過寬規則位置過前**:來源或目的為 any / 應用 any / 服務 any 的 allow 排在較具體規則之前。
     - **冗餘**:前後兩條條件與動作相同、可合併。
     - **長期未命中**:命中數 0 或最後命中超過 N 天(N 由網通決定,預設 90)。
     - **停用規則**、沒有 Security Profile 的 allow、沒有 Log at Session End 的規則。
     - 無法精準判斷的(應用群組 / 動態位址群組 / 使用者群組 / negate)標「無法判定」,不當成沒問題。
  2. **AI 判讀**(`netops.ai.use`,沿用 D23 的 AI 主機呼叫方式):只送程式檢查找出的項目 + 相關規則的正規化內容(名稱、zone、物件名稱與展開後網段、應用、服務、動作、命中數),請 AI 依風險排序、說明原因與建議調整順序或合併。AI 結果標「AI 建議,需網通確認」,**不自動改 PA**。整份規則不一次送(168 條太長,且無助判斷)。
  - 需求方 2026-11-18 同意規則內容送公司內部 AI 主機(原話見 §4 Q4);不送 API Key、密碼。
- **不做**:修改規則、調整順序、Commit、封鎖 IP(D22,仍排在 R2)。

### 3.4 完成標準

- `pa-collector` pytest、後端 / 前端 typecheck、test、test:int、build 通過;code-reviewer、security-auditor 檢查(重點:白名單、Key 不進日誌、規則內容權限)。
- 測試區:168 條規則數、順序、欄位與 PA GUI 一致(抽 10 條逐欄比對);物件展開正確;命中數與 GUI 一致。
- 管理平面 CPU 在讀取期間不超過門檻。

### 3.5 規則圖分頁(Q5,需求方 2026-11-19)

「防火牆 › 安全規則」頁加「規則圖」分頁,把規則圖像化。圖表用既有的 ECharts 6.1(`frontend/package.json`),不新增套件。資料全部來自 PR-1 快照(`position`、`fromZones` / `toZones`、`action`、`disabled`)與命中數,**不需要新的後端 API**;整理資料的邏輯寫在 PR-3 的 `composables/usePaPolicyViz.ts`(Claude,含單元測試),畫面交 PR-4(Gemini)。

| 順序 | 圖表 | 呈現 | 回答的問題 | 元件 |
| --- | --- | --- | --- | --- |
| 1(主圖) | Zone × Zone 矩陣熱力圖 | 列 = 來源 zone、欄 = 目的 zone;格子深淺 = 規則數,顏色分 allow / deny / 混合;tooltip 列規則編號 | 哪些 zone 之間開了什麼、有沒有不該開的格子 | 既有 `ui/charts/GHeatmap.vue` |
| 2 | 規則順序條(rulebase 階梯) | 依 `position` 由上往下;長條 = 命中數(log 刻度,0 次另用記號);顏色 = 動作,停用淡色;PR-5 結果(遮蔽、衝突、長期未命中)加標記;規則多時用垂直捲動(dataZoom) | PA 由上往下比對,看哪幾條擋在前面吃掉流量、哪些永遠不會命中 | 新元件(ECharts 橫條圖) |
| 3 | Sankey | 來源 zone → 動作 → 目的 zone;線寬 = 命中數 | 實際流量經過規則後往哪裡走 | 既有 `ui/charts/GSankey.vue` |

**連動**:點矩陣格子或 Sankey 線 → 順序條只標出相關規則;點順序條上的規則 → 開規則內容(物件展開,同清單分頁的詳細)。篩選(動作、zone、長期未命中 N 天)三張圖共用。

**資料規則(`usePaPolicyViz.ts`)**:

- `any` zone 獨立成一列 / 一欄,不攤到每一格。
- 規則有多個 zone 時每個(來源, 目的)組合各算一次;矩陣的「規則數」是規則出現次數,不能加總成總規則數。
- Sankey 的命中數:多 zone 規則依組合數平均分攤,tooltip 標「多 zone 規則平均分攤,為估算值」。
- 停用規則不進矩陣與 Sankey,只在順序條淡色顯示。
- `intrazone-default` / `interzone-default` 只有命中數沒有規則內容(PR-0):順序條放在最後並標「預設規則」;Sankey 以「預設規則」節點呈現,不歸到任何 zone 組合。
- 輸出純資料(矩陣格、順序條列、Sankey 節點與連線),不依賴 ECharts 型別,方便測試與換圖。
- PR-5 尚未完成時,順序條的檢查標記欄位留空,不顯示「無問題」。

**不採用**:網路圖 / 力導向圖(規則 166 條、位址物件 302 個,畫面會糊成一團且看不出順序)。

### 3.6 規則搭配 IP 對照表(Q6,需求方 2026-11-19)

規則的位址物件展開後,對照 IP 對照表(AC3,API.md §11)顯示姓名 / 部門 / 設備。

| 情況 | 做法 | 負責 |
| --- | --- | --- |
| 單一 IP(`/32`) | 前端呼叫既有 `POST /ip-name-lookups`(每次最多 200 個,超過分批);顯示「IP(姓名 / 部門 / 設備)」 | PR-3 |
| 網段 / 範圍 | 新增反查 API `POST /v1/ip-name-range-lookups`:`{ ranges: string[] }`(IPv4 網段或 `a-b` 範圍,上限同 lookups 200 個)→ 每個範圍回「對照表中落在範圍內的項目」(依 IP 排序,每個範圍最多 50 筆並回 `total`、`truncated`);權限 `netops.ip-name.read`、`x-audit-level: meta`、POST(不把查詢放網址)。經 `infra/store` 的 `listIpNames` 比對,不改資料 | PR-2(API)、PR-3(`api/` + composable) |
| 用名稱找規則(選配) | 規則清單篩選加 `name`:同 Log 明細的做法,姓名 / 部門 / 設備 → 對照表 IP / 網段 → 找展開後位址涵蓋它的規則;POST 或前端轉 IP 後再篩,姓名不進網址 | PR-2 / PR-3 |

規則:

- 姓名、部門屬個資,只給 `netops.ip-name.read`(網管);沒有此權限時只顯示 IP,不呼叫上述 API(畫面不顯示錯誤)。
- 名稱只在前端即時查,**不寫進規則快照、版本歷史、NAS 備份**,也不送 AI 判讀(PR-5 只送規則內容)。
- 顯示位置:清單分頁的物件展開、規則詳細;規則圖(§3.5)以 zone 為單位,不放名稱,點開規則詳細才顯示。
- 動態位址群組、FQDN 物件不比對,標「無法對照」。
- 第一版只支援 IPv4(同 AC3)。

## 4. 決定事項(需求方 2026-11-18)

| # | 問題 | 決定 |
| --- | --- | --- |
| Q1 | 戰情室方向呈現範圍 | 反向粒子 + 顏色 + 節點入 / 出數字,**再加篩選切換**(全部 / 連入 / 連出) |
| Q2 | WD-3 Canvas 動畫由誰做 | **Claude 一起做**;圖例文字、樣式微調之後可交 Gemini |
| Q3 | 規則讀取的權限做法 | **先做 PR-0 唯讀實測**;op 能讀就不加權限,不行再請網通開專用帳號的 Configuration 權限並修改 D22 |
| Q4 | 規則功能範圍 | 原話:「清單+物件展開+命中數+版本差異 是否可以依照PA的排序?並且讓AI判斷security排序是否符合邏輯」→ 第一版含清單、物件展開、命中數、**版本差異**;**依 PA 排序**(§3.3 排序);加 **PR-5 排序檢查與 AI 判讀** |
| Q5 | 規則圖像化(2026-11-19) | 原話:「前端再幫我規劃新增一個tab,把規則圖像化」、「寫入並併入 PR-3」→ 加「規則圖」分頁(§3.5):Zone 矩陣熱力圖、規則順序條、Sankey;資料邏輯併入 PR-3,畫面歸 PR-4 |
| Q6 | 規則可看到已匯入的 IP 清單(2026-11-19) | 原話:「規則可以看到已匯入的IP清單嗎」、「寫進 !143」→ 規則位址對照 IP 對照表(§3.6):單一 IP 用既有 lookups,網段新增 `ip-name-range-lookups`(PR-2),選配用名稱找規則;只給 `netops.ip-name.read` |

## 5. 分批與負責人

| 批次 | 內容 | 負責 | 分支(從 `origin/develop` 開) |
| --- | --- | --- | --- |
| WD-1+2+3 | 後端方向欄位、composable、Canvas、圖例 | Claude Opus 子任務 | `feature/warroom-direction` |
| WD 驗收 | 測試區真實流量、效能回歸、報告 | Claude Sonnet 子任務 + 網通 | — |
| PR-0 | 權限實測(唯讀) | Claude(主串或 Sonnet),需求方同意對 PA 送查詢 | — |
| PR-1~3 | 收集器、API(含 `ip-name-range-lookups`,§3.6)、composable(含規則圖資料 `usePaPolicyViz.ts`、IP 對照) | Claude Opus 子任務 | `feature/pa-policy-collector`(堆疊 `feature/pa-policy-api`) |
| PR-4 | 安全規則頁(清單、變更紀錄、排序檢查、規則圖) | Gemini | `feature/pa-policy-page` |
| PR-5 | 排序檢查(程式)+ AI 判讀 API 與 composable | Claude Opus 子任務 | 堆疊在 `feature/pa-policy-api` 之後 |
| 文件 | API.md、ARCHITECTURE(D22 修改或新 D49)、IMPL-PLAN、HANDOFF | Claude Sonnet 子任務(統一一個 docs MR) | `docs/…` |
| 上線 | GigaItApp 路由 / 選單 / 權限、正式區部署 | 需求方 | — |

WD 和 PR 互不相依,可同時進行(同時最多 2 個子任務)。
