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
$ExeName = 'netops-ad-agent.exe'
$InstallDir = Join-Path $env:ProgramFiles 'GigaNexus\NetOpsAdAgent'
$DataDir = Join-Path $env:ProgramData 'GigaNexus\NetOpsAdAgent'

function Assert-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '請以系統管理員身分執行 PowerShell'
    }
}

# ===== 安全停止服務(Install / Uninstall 兩支腳本共用,內容必須相同;測試會比對)=====
# 0.1.0 在 GSMC-DC1 卡在 Event Log 讀取時 Stop-Service 失敗(2026-11-25)。停不下來時:先關閉 SCM 失敗復原動作並確認,
# 再只結束該服務自己的行程(路徑必須是安裝目錄的 netops-ad-agent.exe),否則 SCM 會在 10 秒後重新拉起;不動其他服務。
function Assert-AdServiceName {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name -cnotin @('NetOpsAdAgent', 'NetOpsAdWatchdog')) { throw "只處理 NetOps AD 服務,拒絕:$Name" }
}

# 登錄檔 FailureActions(SERVICE_FAILURE_ACTIONS 32 位元格式:重設秒數、兩個指標、動作數、指標,之後每個動作 8 bytes)。
# 沒有值、0 個動作或全部 SC_ACTION_NONE 才算已關閉;格式不對一律視為未關閉
function Test-FailureActionsNone {
    param([AllowNull()][byte[]]$Blob)
    if ($null -eq $Blob -or $Blob.Length -eq 0) { return $true }
    if ($Blob.Length -lt 20) { return $false }
    $count = [BitConverter]::ToUInt32($Blob, 12)
    if ($count -eq 0) { return $true }
    if ($count -gt 64 -or $Blob.Length -lt (20 + 8 * $count)) { return $false }
    for ($i = 0; $i -lt $count; $i++) {
        if ([BitConverter]::ToUInt32($Blob, 20 + 8 * $i) -ne 0) { return $false }
    }
    return $true
}

# sc.exe 一律用完整路徑(不從目前目錄找執行檔;資安審查 M-1)
function Get-ScExePath { Join-Path $env:SystemRoot 'System32\sc.exe' }

# actions= "" 清除失敗復原動作。以 Start-Process 傳整段參數字串:PowerShell 5.1 呼叫外部程式時會丟掉空字串參數
function Get-RecoveryNoneArguments {
    param([Parameter(Mandatory = $true)][string]$Name)
    Assert-AdServiceName $Name
    "failure $Name reset= 0 actions= `"`""
}

function Disable-AdServiceRecovery {
    param([Parameter(Mandatory = $true)][string]$Name)
    Assert-AdServiceName $Name
    $sc = Get-ScExePath
    $p = Start-Process -FilePath $sc -ArgumentList (Get-RecoveryNoneArguments -Name $Name) -WorkingDirectory (Split-Path -Parent $sc) -NoNewWindow -PassThru
    $null = $p.Handle
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "關閉 $Name 的失敗復原動作失敗($($p.ExitCode))" }
    $out = & $sc failureflag $Name 0 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sc.exe failureflag $Name 0 失敗($LASTEXITCODE):$out" }
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
    $blob = (Get-ItemProperty -LiteralPath $key -Name FailureActions -ErrorAction SilentlyContinue).FailureActions
    if (-not (Test-FailureActionsNone $blob)) { throw "$Name 的失敗復原動作仍在,不結束行程(避免 SCM 重新拉起)" }
    Write-Host "  $Name 失敗復原動作已關閉"
}

function Test-OwnServiceProcess {
    param([AllowNull()][AllowEmptyString()][string]$ProcessPath, [Parameter(Mandatory = $true)][string]$ExpectedExe)
    if (-not $ProcessPath) { return $false }
    try { return ([IO.Path]::GetFullPath($ProcessPath) -ieq [IO.Path]::GetFullPath($ExpectedExe)) } catch { return $false }
}

# 先正常停止;$TimeoutSec 內沒停(或停止要求失敗)→ 關閉失敗復原 → 結束該服務的行程 → 等 SCM 顯示 Stopped。
# 結束行程時先取得行程物件並保住 handle(PID 不會被重用),在同一個物件上比對路徑、再確認服務的 PID 沒變才結束(資安審查 L-1)
function Stop-AdServiceSafely {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$ExpectedExe, [int]$TimeoutSec = 30)
    Assert-AdServiceName $Name
    $ctl = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $ctl -or $ctl.Status -eq 'Stopped') { return }
    $wait = [TimeSpan]::FromSeconds($TimeoutSec)
    try {
        if ($ctl.Status -ne 'StopPending') { $ctl.Stop() }
        $ctl.WaitForStatus('Stopped', $wait)
        return
    } catch {
        $msg = $_.Exception.Message.Split("`n")[0]
        $ctl.Refresh()
        # 停止要求送出前服務剛好自己停了:不必結束行程(審查 6)
        if ($ctl.Status -eq 'Stopped') { return }
        Write-Warning "$Name 未在 $TimeoutSec 秒內停止($msg),改為結束該服務的行程"
    }
    Disable-AdServiceRecovery -Name $Name
    $procId = [int](Get-CimInstance -ClassName Win32_Service -Filter "Name='$Name'" -ErrorAction Stop).ProcessId
    $proc = if ($procId -gt 0) { Get-Process -Id $procId -ErrorAction SilentlyContinue } else { $null }
    if ($proc) {
        # LocalSystem 服務的行程:取得 handle 需要 SeDebugPrivilege(系統管理員有但預設未啟用;資安複審 3)
        $debug = $false
        try { [Diagnostics.Process]::EnterDebugMode(); $debug = $true } catch { Write-Verbose "無法啟用 SeDebugPrivilege:$_" }
        try { $null = $proc.Handle } finally { if ($debug) { [Diagnostics.Process]::LeaveDebugMode() } }
        # handle 保住後 PID 不會被重用;Path(MainModule)讀不到時改用 CIM 的 ExecutablePath
        $path = $proc.Path
        if (-not $path) { $path = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).ExecutablePath }
        if (-not (Test-OwnServiceProcess -ProcessPath $path -ExpectedExe $ExpectedExe)) {
            throw "$Name 的行程 $procId($path)不是 $ExpectedExe,不結束"
        }
        $again = [int](Get-CimInstance -ClassName Win32_Service -Filter "Name='$Name'" -ErrorAction Stop).ProcessId
        if ($again -ne $procId) { throw "$Name 的行程已改變($procId → $again),不結束,請重新執行" }
        $proc.Kill()
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) { throw "$Name 的行程 $procId 沒有結束" }
    }
    $ctl.Refresh()
    $ctl.WaitForStatus('Stopped', $wait)
    if ($proc) { Write-Host "  $Name 已結束行程 $procId 並停止" -ForegroundColor Yellow }
    else { Write-Host "  $Name 已停止" }
}
# ===== 安全停止服務(共用)結束 =====

# 移除順序(純資料,方便測試):Watchdog 先停,Agent 才不會被拉起來
function Get-UninstallOrder {
    @($WatchdogService, $AgentService)
}

function Remove-AdAgentService {
    param([Parameter(Mandatory = $true)][string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { Write-Host "  $Name 不存在,略過"; return }
    Set-Service -Name $Name -StartupType Manual
    # 先關閉失敗復原:停不下來而結束行程時,SCM 不會在刪除前把它拉起來
    Disable-AdServiceRecovery -Name $Name
    Stop-AdServiceSafely -Name $Name -ExpectedExe (Join-Path $InstallDir $ExeName)
    $out = & (Get-ScExePath) delete $Name 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete $Name 失敗($LASTEXITCODE):$out" }
    Write-Host "  $Name 已移除"
}

function Uninstall-NetOpsAdAgent {
    Assert-Administrator
    Write-Host '移除 AD Agent 服務:'
    foreach ($n in Get-UninstallOrder) {
        try { Remove-AdAgentService -Name $n } catch {
            Write-Warning "移除 $n 未完成(失敗復原可能已關閉):排除錯誤後重新執行本腳本。"
            throw
        }
    }
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
