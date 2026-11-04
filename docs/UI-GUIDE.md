# NetOps — 前端 UI 規範

> **UI 全域套用**:頁面只組合 `src/ui/` 的全域元件與設計 token,不在頁面裡各自刻按鈕、卡片、表格、表單、對話框的樣式。
> 元件、版面與規則沿用 `../giga-Portal/docs/UI-GUIDE.md`、`../GigaItApp/docs/UI-GUIDE.md`,本文件只寫**差異**。決策見 [ARCHITECTURE.md](ARCHITECTURE.md) D5。**狀態:F1 實作中**(框架完成,頁面逐頁改寫);舊版 `src/` 仍是 Element Plus,切換前保留(D12)。

---

## 1. 框架來源

- `frontend/src/ui/` 從 `../giga-Portal/frontend/src/ui/` 複製。入口網是 GigaItApp 元件的超集,多了 `GAlert`、`GStyleToggle` 與玻璃 / 扁平 token。
- 不使用的 `GHero` 不複製。
- `GAppSwitcher` 維持同一版本,三個專案同步修改。
- 版面沿用入口網:兩層側欄(收合浮出、≤ 960px 抽屜)、頂列(風格、明暗、應用切換、帳號)、`#page-actions`。

## 2. 主題色(唯一的視覺差異)

只改 `ui/styles/tokens.css` 的顏色值與 `ui/charts/palette.ts`,元件與 token 名稱不動。主色為**工程藍**,延續舊版 `cleanroom` 主題的色系,也與 GigaItApp 靛紫、入口網綠色區分。

| Token | 明亮 | 黑暗 |
| --- | --- | --- |
| `--c-primary` | `#0369a1` | `#38bdf8` |

- 其餘色階(`--grad-*`、`--bg`、`--text*`、光暈、圖表色)在 F1 依主色調整,語意色 `info / success / warning / danger` 沿用入口網。F1 實際值:明亮主色文字 `--c-primary-text` `#075985`、底色 `--bg` `#f2f7fb`;黑暗底色 `#07111a`、主色按鈕文字 `--on-primary` `#03121c`;圖表第 4 色改用綠色(與主色區隔)。
- 四種組合實測(2026-11-03):`--text-3` 對底色最低 5.05:1,主要按鈕文字最低 5.36:1。
- 玻璃 / 扁平 × 明亮 / 黑暗四種組合的文字對比至少 4.5:1(大字 3:1),以瀏覽器實際檢查。
- 偏好記在瀏覽器:`netops.theme`、`netops.style`。

## 3. 舊畫面對應

| 舊版 | 新版 |
| --- | --- |
| `el-button` / `el-input` / `el-select` / `el-checkbox` | `GButton` / `GInput` / `GSelect` / `GCheckbox` |
| `el-table` + `el-pagination` | `GTable` |
| `el-radio-group` / `el-segmented` | `GSegmented` |
| `el-dialog` / `el-drawer` | `GModal` |
| `el-progress` | `GProgress` |
| `el-date-picker` 期間 | 兩個 `GInput`(`type="date"` 或 `datetime-local`),與 GigaItApp 相同 |
| `PageHeader` | `TabbedPage` / `GPageHeader` |
| 流量總覽自刻 SVG 圖表 | 改用 `ui/charts`;不足時先擴充元件 |
| `lucide-vue-next` 直接 import | `GIcon`,在 `icons.ts` 登記 |

沒有對應元件的(可展開表格列、`el-input-number`、`el-tooltip`、`el-dropdown`)F1 逐項處理:優先改用既有元件,必要時擴充 `src/ui/`,不在頁面內刻樣式。已處理:

| 舊版 | 新版 |
| --- | --- |
| `el-table` 勾選欄(`type="selection"`) | `GTable` 的 `#cell-sel` 放 `GCheckbox`,表格上方「全選目前清單」(`GTable` 不擴充,與入口網同步) |
| `el-table` 可展開列 | 列尾按鈕開 `GModal` 顯示明細(AD 每日檔案) |
| 流量總覽自刻 SVG 每小時長條(允許 / 阻擋堆疊、點選) | `ui/charts/GStackedBars.vue`(NetOps 新增;同步回入口網前要先討論) |
| `text-danger`、`text-run` 等狀態文字色 | `base.css` 新增 `.c-success`、`.c-warning`、`.c-danger`(語意色混入本文色,四種組合對比 ≥ 5:1;`.tone-*` 只設定 `--tone`) |

知識庫的 Markdown(`v-html`)只能輸出 `composables/markdown.ts` 的結果(marked + DOMPurify),樣式寫在頁面 `.md :deep(...)`;其他頁面不用 `v-html`。

`GTable` 的儲存格插槽內容全是 `v-if` 落空(只剩註解)時會顯示預設值,要留 `<span v-else />`。

**只換畫面,不改功能**:篩選條件、排行點擊帶到明細、知識庫操作都要保留。AI 畫面不改寫,選單放連結到舊版(ARCHITECTURE D17、D18)。

## 4. 移除

> **F1 收尾(2026-11-03)只清 `frontend/` 內的過渡程式**(佔位頁 `WipPage`、`PingCard`、`api/netops.ts`)。下列舊版項目在根目錄 `src/`、`server/` 與根 `package.json`,依 ARCHITECTURE D12(切換前 `main` 維持舊 IIS 版本,緊急修正要能合回 `develop`)與 D18(切換後舊版 IIS 仍提供 AI,在 `main` 打標籤保留)**暫不刪除**,等舊版停用(A1 AI 搬移完成,D18、D23)時再一併移除。新版 `frontend/` 已不相依 Element Plus、Tailwind。

- Element Plus、Tailwind、`unplugin-auto-import`、`unplugin-vue-components`。
- 舊配色系統:`themes/`、`src/themes/`、`scripts/make-themes.mjs`、`/theme.css`、`/__themes`。
- 字體大小控制 `FontSizeControl`、`useFontScale`:GigaItApp 與入口網都沒有。
- AI 畫面:`PaAsk`、`AiAnalysis`、`TranslateBox`、知識庫頁的語意搜尋與自動學習區塊(D17)。

## 5. 權限與禁止事項

與入口網 `UI-GUIDE` §5、§7 相同;權限代碼見 [ARCHITECTURE.md](ARCHITECTURE.md) §5,偏好 key 用 `netops.*`。
