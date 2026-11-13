# NetOps ClickHouse 容量與硬體資源使用查詢工具

> 透過 SSH 連線至主機 2（測試區）或主機 3（正式區），快速查詢 ClickHouse 容器配額、即時 CPU/記憶體使用率、Docker Volume 磁碟佔用，以及內部各資料表（`system.parts`）的壓縮前後大小與時間範圍，自動產出美化格式的 Excel（`.xlsx`）報表。

---

## 檔案說明

| 檔案 | 說明 |
| :--- | :--- |
| **`Get-NetOpsClickHouseCapacity.ps1`** | PowerShell 前端腳本，提供選單互動（選 1 測試區、2 正式區、3 兩區同時查詢），完成後自動以 Excel 開啟報表 |
| **`get_clickhouse_capacity.py`** | 核心查詢與 Excel 產出程式（使用 `openpyxl`，支援跨主機 SSH 查詢、JSON 規格解析與 system.parts 統計） |
| **`README.md`** | 本說明文件 |

---

## 使用方式

請以 PowerShell 切換至本目錄執行：

```powershell
cd D:\檔案分享\程式碼\GigaNexusAI\NetOps\clickhouse-capacity-tool
```

### 1. 互動式選單（推薦）

直接執行腳本即可叫出選單：

```powershell
.\Get-NetOpsClickHouseCapacity.ps1
```

執行畫面：
```text
==========================================================
   NetOps ClickHouse 容量與硬體使用查詢工具
==========================================================
 請選擇要查詢的目標環境:
   [1] 測試區 (Test - host2 / 10.10.130.124)
   [2] 正式區 (Prod - host3 / 10.10.130.122)
   [3] 兩區同時查詢 (All - 產生各區分頁)
   [Q] 離開
----------------------------------------------------------
請輸入選項 [預設 1]:
```

### 2. 參數直接執行

```powershell
# 查詢測試區並自動開啟 Excel
.\Get-NetOpsClickHouseCapacity.ps1 -Env test

# 查詢正式區
.\Get-NetOpsClickHouseCapacity.ps1 -Env prod

# 兩區同時查詢（產出同一個 Excel 檔的不同分頁）
.\Get-NetOpsClickHouseCapacity.ps1 -Env all

# 查詢但不要自動跳出 Excel 視窗
.\Get-NetOpsClickHouseCapacity.ps1 -Env test -NoOpen
```

### 3. 直接以 Python 執行

```bash
# 需安裝 openpyxl: pip install openpyxl
python get_clickhouse_capacity.py --env test
python get_clickhouse_capacity.py --env prod
python get_clickhouse_capacity.py --env all
```

---

## 產出 Excel 格式說明

報表包含兩大區塊：
1. **一、 Docker Volume 實體佔用空間與硬體資源使用現況**
   * 容器名稱、運行狀態
   * 記憶體配額上限（RAM Limit）、CPU 核心上限
   * 即時記憶體使用率（MB / %）、即時 CPU %
   * Docker Volume 實體佔用大小（`du -sh`）、Volume 名稱與掛載路徑
   * 底層 WSL2 虛擬磁碟空間與宿主機 Windows 實體 C/D 碟剩餘空間
2. **二、 內部各資料表佔用大小拆解 (`system.parts`)**
   * 表格欄位：`資料庫`、`資料表名稱`、`狀態 (Active/Inactive)`、`資料筆數 (Rows)`、`壓縮後大小 (磁碟)`、`未壓縮大小`、`壓縮比`、`分區數 / 資料涵蓋時間`
   * 分類小計：NetOps 業務日誌表、ClickHouse 系統日誌表、背景合併暫存（Inactive）
   * 總計：Active 作用中資料合計、Volume 實體總佔用對照
