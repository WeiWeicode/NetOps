# Gemini 提示詞:防火牆 › 安全規則頁 驗收修正(PR-FIX)

> 給 Gemini 的工作提示詞。來源:2026-11-19 驗收報告 `docs/test-reports/2026-11-19-pa-policy-acceptance.md` §2 第 6、7 項、§3,與需求方同日的兩項新需求(規則圖點選篩選、匯出給外部 AI)。
> 資料與邏輯已由 Claude 完成(分支 `feature/pa-policy-fix`);這份只交代**畫面**。結構同 `GEMINI-PROMPT-PR.md`。

---

你在 NetOps repo(`D:\檔案分享\程式碼\GigaNexusAI\NetOps`)做**前端頁面與元件**。

## 先讀

1. 工作區 `../AGENT.md` §7(Claude / Gemini 分工)、本 repo `AGENT.md`「AI 分工」。
2. `docs/GEMINI-PROMPT-PR.md`(上一版畫面的交代,欄位說明仍有效)。
3. 下列 composable **開頭的說明註解**(都回傳 reactive 物件,模板直接用,不要解構、不用 `.value`):
   - `frontend/src/composables/usePaPolicyViz.ts`(新增「點選篩選」段落)
   - `frontend/src/composables/usePaPolicyExport.ts`(新檔)
   - `frontend/src/composables/useAiExplain.ts`(新增 `flags`、`AI_FLAG_LABELS`)

## 分支

- `feature/pa-policy-fix` 已合併 develop:從 `origin/develop` 最新開 `feature/pa-policy-page-fix`。
- 還沒合併:從 `origin/feature/pa-policy-fix` 開,MR 描述寫「依賴 feature/pa-policy-fix,須在其後合併」。
- 先 `git remote -v`,指向 `10.10.130.123` 的(這個 repo 是 `origin`)才是 GitLab。

## 要做的事

| # | 項目 | 檔案 | 怎麼做 |
| --- | --- | --- | --- |
| 1 | 頁面標題 / 副標重複兩組(需求方:「有兩個說明」) | `frontend/src/pages/firewall/Policies.vue` | 外層版面已顯示選單標題時,刪掉頁內重複的那組標題與說明,只留一組(保留含快照時間、收集狀態、重新整理按鈕的那一列)。看其他頁(`Search.vue`、`Insight.vue`)怎麼做,照同樣方式 |
| 2 | FQDN 字樣「無法展開」→「無法對應 IP」 | `frontend/src/components/policies/PolicyObjectExpand.vue`(第 89 行附近的 GBadge)與註解;全頁搜尋「無法展開」一併改 | `unresolved` 為 true 的意思是「有成員無法換成 IP」(FQDN、動態群組、地區),不是展不開;展開後仍列出 `fqdn:…` 成員 |
| 3 | 規則圖點選篩選(需求方新需求) | `frontend/src/components/policies/PolicyVizTab.vue` | 點矩陣格子或 Sankey 線後,**順序條與 Sankey 只顯示選取的規則**(不是只標記):順序條改用 `v.shownOrder`、Sankey 改用 `v.shownSankey`(取代原本的 `v.order`、`v.sankey`);矩陣仍用 `v.matrix`(不縮小,才能改點別格),選取的格子維持現在的選取樣式。`v.focused` 為 true 時在圖上方顯示「已篩選:<格子 from → to 或連線>,共 N 條」(N = `v.shownRules.length`)與「清除選取」按鈕 → `v.clearSelection()`。點縮小後 Sankey 上的線仍呼叫 `v.select({ kind: 'link', source, target })`。註明「Sankey 會畫出選取規則的所有 zone 組合」 |
| 4 | 規則圖匯出給外部 AI(需求方新需求:「規則內容,不含姓名部門」) | `PolicyVizTab.vue`(或其工具列) | 加「匯出規則(給 AI)」按鈕,兩個選項 Markdown / JSON:`ex.download('md')` / `ex.download('json')`,回傳 false 時提示「目前沒有規則可匯出」。按鈕旁小字:「匯出目前圖上的規則(含篩選與選取);不含 IP 對照姓名 / 部門、說明欄與使用者名稱」。另可加「複製 Markdown」→ `navigator.clipboard.writeText(ex.markdown())`。**不要**在匯出內容加任何 IP 對照結果(`p.nameOf` 等) |
| 5 | AI 判讀區顯示驗證標註 | `frontend/src/components/policies/PolicyChecksTab.vue`(AI 回答區) | 回答完成後 `check.ai.flags`:`null` = 沒有驗證(不顯示);空陣列 = 「系統比對:引用的規則編號都在檢查資料內」(小字、成功色);有項目時在回答**上方**顯示警告框「系統比對發現 N 處 AI 引用與檢查結果不符,請以排序檢查清單為準」,逐項列:`#position`、`AI_FLAG_LABELS[kind]`、`kind === 'mismatch'` 時加 `CHECK_LABELS[code]`、`line`(回答原句,**純文字顯示**,用 `{{ }}`,不要 v-html)。回答本文照舊用 AiMarkdown |

## 可用的 composable 與欄位

**規則圖** `usePaPolicyViz(...)`(`PolicyVizTab` 已建立,變數 `viz`):

| 欄位 | 說明 |
| --- | --- |
| `shownOrder` | 順序條資料(`OrderRow[]`,欄位同 `order`);有選取時只含選取的規則,預設規則只在點「預設規則」Sankey 線時出現 |
| `shownSankey` | `{ nodes, links }`,同 `sankey`;有選取時以選取的規則重畫 |
| `focused` | 有有效的選取(選取的格子 / 線被篩選條件拿掉時自動為 false,圖顯示全部) |
| `selection` | 目前選取 `{ kind: 'cell', from, to }` / `{ kind: 'link', source, target }` / null |
| `shownRules`、`shownDefaults` | 目前圖上的規則與預設規則(匯出用) |
| `clearSelection()` | 清除選取(同 `select(null)`) |
| `matrix`、`order`、`sankey`、`highlighted`、`filters`、`zones`、`select()` | 不變 |

**匯出** `usePaPolicyExport(rules, defaults, checks, meta)`(在 `PolicyVizTab` 建立):

```ts
const ex = usePaPolicyExport(
  () => viz.shownRules,
  () => viz.shownDefaults,
  () => check.items,               // usePaPolicyCheck 的檢查項目;還沒載入時給 null
  () => ({ fetchedAt: p.info.available ? p.info.fetchedAt : null, unusedDays: check.unusedDays, scope: '<目前篩選與選取的文字說明>' }),
);
ex.download('md' | 'json'); ex.markdown(); ex.json(); ex.build()  // build() 是物件,可用來顯示筆數
```

`scope` 由畫面組字串,例如「動作 allow;zone trust;選取 trust → untrust」,沒有篩選給 null。匯出只用畫面已有的資料,能進這頁就有 `netops.pa-policy.read`,**不必另判權限**。

**AI 判讀** `check.ai`(`useAiExplain`):

| 欄位 | 說明 |
| --- | --- |
| `flags` | `null` 或 `AiFlag[]`:`kind`(`unknown` 資料中沒有這條規則 / `mismatch` 程式檢查沒有把它列在這一類 / `user` 資料沒標它有使用者條件)、`position`、`code?`(mismatch 時的檢查類別)、`line`(回答原句,最多 200 字) |
| `AI_FLAG_LABELS` | `import { AI_FLAG_LABELS } from '@/composables/useAiExplain'`,三種 kind 的中文 |

標註是**提醒**(以關鍵字比對,不是判決),文案用「請對照」而不是「錯誤」。

## 不要做

- 不改 `composables/`、`api/`、後端、`package.json`、測試以外的設定(AGENT.md §7)。需要新欄位或邏輯寫在 MR 說明交給 Claude。
- 不在規則圖或匯出顯示 IP 對照姓名 / 部門。

## 驗收(做完自己先看,寫進 MR 說明)

1. 頁首只剩一組標題 / 說明。
2. FQDN 物件(例 #18 `paloaltonetworks.com`)標「無法對應 IP」,展開仍列出 `fqdn:` 成員。
3. 點矩陣格子:順序條與 Sankey 只剩那幾條,顯示「已篩選 … 共 N 條」;清除選取後恢復;改篩選讓格子消失時自動顯示全部。
4. 點 Sankey 線同樣篩選;點「預設規則」線只剩該預設規則。
5. 匯出 Markdown / JSON 下載成功,內容沒有姓名、部門、說明欄、使用者帳號;有選取時只含選取的規則。
6. AI 判讀完成後顯示驗證標註(測試區真實資料若沒有不符,會顯示「引用的規則編號都在檢查資料內」)。
7. `npm run typecheck`、`npm test`、`npm run build` 通過(只執行,失敗寫進報告交 Claude)。
