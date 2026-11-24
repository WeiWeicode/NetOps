<#
.SYNOPSIS
  移除 NetOps AD Agent 與 Watchdog 服務(AD-2;docs/AD-AGENT-PLAN.md §3.1、§3.4)。

.DESCRIPTION
  1. Watchdog 改手動並停止(避免它把 Agent 拉起來)→ 停止 Agent
  2. 刪除兩個服務,刪除 %ProgramFiles%\GigaNexus\NetOpsAdAgent(執行檔)
  3. 預設保留 %ProgramData%\GigaNexus\NetOpsAdAgent 的 state\(bookmarks.json:重裝後從水位接續)、logs\、agent.toml 與 secrets\
     -RemoveToken:另外刪除 secrets\ad_agent.token(DC 汰換時;接收端的 Token 要另外作廢,deploy/RUNBOOK-ad.md §4)
     -RemoveData:整個資料目錄都刪除(含水位;重裝後由後端心跳的水位接續 log_epoch)

  只是 DC 維護要暫時停用,請用 Install-NetOpsAdAgent.ps1 -Pause / -Resume。需要系統管理員 PowerShell。

.EXAMPLE
  .\Uninstall-NetOpsAdAgent.ps1
  .\Uninstall-NetOpsAdAgent.ps1 -RemoveToken
#>
[CmdletBinding()]
param(
    [switch]$RemoveToken,
    [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'

$AgentService = 'NetOpsAdAgent'
$WatchdogService = 'NetOpsAdWatchdog'
$InstallDir = Join-Path $env:ProgramFiles 'GigaNexus\NetOpsAdAgent'
$DataDir = Join-Path $env:ProgramData 'GigaNexus\NetOpsAdAgent'

function Assert-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '請以系統管理員身分執行 PowerShell'
    }
}

# 移除順序(純資料,方便測試):Watchdog 先停,Agent 才不會被拉起來
function Get-UninstallOrder {
    @($WatchdogService, $AgentService)
}

function Remove-AdAgentService {
    param([Parameter(Mandatory = $true)][string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { Write-Host "  $Name 不存在,略過"; return }
    Set-Service -Name $Name -StartupType Manual
    if ($svc.Status -ne 'Stopped') { Stop-Service -Name $Name -Force -ErrorAction Stop }
    $out = & sc.exe delete $Name 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete $Name 失敗($LASTEXITCODE):$out" }
    Write-Host "  $Name 已移除"
}

function Uninstall-NetOpsAdAgent {
    Assert-Administrator
    Write-Host '移除 AD Agent 服務:'
    foreach ($n in Get-UninstallOrder) { Remove-AdAgentService -Name $n }
    if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
        Write-Host "  已刪除 $InstallDir"
    }
    if ($RemoveData) {
        if (Test-Path -LiteralPath $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
        Write-Host "  已刪除 $DataDir(含 Token 與水位)"
    } elseif ($RemoveToken) {
        $t = Join-Path $DataDir 'secrets\ad_agent.token'
        if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force }
        Write-Host '  已刪除 secrets\ad_agent.token(接收端的 Token 請另外作廢)'
    } else {
        Write-Host "  保留 $DataDir(state、logs、agent.toml、secrets)"
    }
}

if ($MyInvocation.InvocationName -ne '.') { Uninstall-NetOpsAdAgent }
