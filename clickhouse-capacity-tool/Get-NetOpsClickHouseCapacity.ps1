<#
.SYNOPSIS
    NetOps ClickHouse 容量與硬體使用快速查詢工具 (自動產出 Excel 報表)

.DESCRIPTION
    透過 SSH 連線至主機 2 (測試區) 或主機 3 (正式區)，
    查詢 ClickHouse 容器規格、即時資源使用率、Docker Volume 磁碟佔用、
    以及內部各資料表 (system.parts) 的壓縮前後大小與時間範圍，
    自動產出美化格式的 Excel (.xlsx) 檔案。

.PARAMETER Env
    查詢目標環境：'test' (測試區)、'prod' (正式區)、'all' (兩者同時查詢)。
    若未指定，將顯示互動式選單供使用者挑選。

.PARAMETER OpenReport
    產出完成後是否自動以 Excel 開啟報表 (預設: $true)。

.EXAMPLE
    .\Get-NetOpsClickHouseCapacity.ps1
    (顯示選單讓您選擇測試區或正式區)

.EXAMPLE
    .\Get-NetOpsClickHouseCapacity.ps1 -Env test
    (直接快速查詢測試區並開啟 Excel)

.EXAMPLE
    .\Get-NetOpsClickHouseCapacity.ps1 -Env all
    (同時查詢測試區與正式區，產生於同一個 Excel 檔的不同分頁)
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [ValidateSet('test', 'prod', 'all', '')]
    [string]$Env = '',

    [Parameter(Mandatory = $false)]
    [switch]$NoOpen
)

# 設置控制台輸出編碼為 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PyScript = Join-Path $ScriptDir "get_clickhouse_capacity.py"

if (-not (Test-Path $PyScript)) {
    Write-Host "[X] 找不到核心查詢程式: $PyScript" -ForegroundColor Red
    exit 1
}

# 檢查 Python
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Write-Host "[X] 系統中未找到 Python，請先安裝 Python 3。" -ForegroundColor Red
    exit 1
}

# 檢查 openpyxl 套件
$hasOpenpyxl = python -c "import openpyxl; print('OK')" 2>$null
if ($hasOpenpyxl -ne "OK") {
    Write-Host "[!] 偵測到尚未安裝 openpyxl 套件，正在自動安裝..." -ForegroundColor Yellow
    pip install openpyxl
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] 安裝 openpyxl 失敗，請手動執行: pip install openpyxl" -ForegroundColor Red
        exit 1
    }
}

# 若未傳入參數，顯示互動選單
if ([string]::IsNullOrWhiteSpace($Env)) {
    Clear-Host
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "   NetOps ClickHouse 容量與硬體使用查詢工具" -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host " 請選擇要查詢的目標環境:"
    Write-Host "   [1] 測試區 (Test - host2 / 10.10.130.124)" -ForegroundColor Green
    Write-Host "   [2] 正式區 (Prod - host3 / 10.10.130.122)" -ForegroundColor Cyan
    Write-Host "   [3] 兩區同時查詢 (All - 產生各區分頁)" -ForegroundColor Magenta
    Write-Host "   [Q] 離開離開"
    Write-Host "----------------------------------------------------------" -ForegroundColor Gray
    
    $inputChoice = Read-Host "請輸入選項 [預設 1]"
    switch ($inputChoice.Trim().ToUpper()) {
        "1" { $Env = "test" }
        ""  { $Env = "test" }
        "2" { $Env = "prod" }
        "3" { $Env = "all" }
        "Q" {
            Write-Host "已取消。" -ForegroundColor Gray
            exit 0
        }
        default {
            Write-Host "[!] 未知選項，預設選擇 [1] 測試區。" -ForegroundColor Yellow
            $Env = "test"
        }
    }
}

Write-Host "`n[*] 開始查詢目標環境: $Env ..." -ForegroundColor Cyan

# 產生報告檔名
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$ReportFile = Join-Path $ScriptDir "NetOps_ClickHouse_Capacity_${Env}_${ts}.xlsx"

# 執行 Python 核心程式
& python $PyScript --env $Env --output $ReportFile

if ($LASTEXITCODE -eq 0 -and (Test-Path $ReportFile)) {
    Write-Host "`n[V] 報表產生成功！" -ForegroundColor Green
    Write-Host "    檔案路徑: $ReportFile" -ForegroundColor Yellow

    if (-not $NoOpen) {
        Write-Host "[*] 正在為您開啟 Excel 報表..." -ForegroundColor Cyan
        Invoke-Item $ReportFile
    }
} else {
    Write-Host "`n[X] 查詢或產出報表時發生錯誤，請確認 SSH 連線與主機狀態。" -ForegroundColor Red
}
