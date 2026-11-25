<#
.SYNOPSIS
  安裝 / 移除腳本的單元測試(AD-2 完成標準;不安裝服務、不需要系統管理員)。CI 與開發機都用這一支:
    powershell -NoProfile -ExecutionPolicy Bypass -File ad-agent\scripts\tests\Test-AgentScripts.ps1
  以 AST 只載入函式與頂層變數,不執行腳本主程式。失敗時結束代碼 1。
#>
$ErrorActionPreference = 'Stop'
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) ''
$install = Join-Path $scripts 'Install-NetOpsAdAgent.ps1'
$uninstall = Join-Path $scripts 'Uninstall-NetOpsAdAgent.ps1'
$script:failed = 0
$script:passed = 0

function Assert-True {
    param([bool]$Condition, [string]$Name)
    if ($Condition) { $script:passed++; Write-Host "  ok   $Name" }
    else { $script:failed++; Write-Host "  FAIL $Name" -ForegroundColor Red }
}

function Assert-Throws {
    param([scriptblock]$Block, [string]$Name, [string]$Like = '*')
    try { & $Block | Out-Null; Assert-True $false "$Name(應拋出例外)" }
    catch { Assert-True ($_.Exception.Message -like $Like) "$Name($($_.Exception.Message.Split("`n")[0]))" }
}

function Import-ScriptParts {
    param([string]$Path)
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    Assert-True ($errors.Count -eq 0) "$(Split-Path -Leaf $Path) 語法正確"
    foreach ($s in $ast.EndBlock.Statements) {
        $isVar = $s -is [Management.Automation.Language.AssignmentStatementAst] -and $s.Left.Extent.Text -ne '$ErrorActionPreference'
        if ($isVar -or $s -is [Management.Automation.Language.FunctionDefinitionAst]) {
            . ([scriptblock]::Create($s.Extent.Text))
        }
    }
    # 把函式與變數帶回呼叫端範圍
    foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        Set-Item -Path "function:global:$($f.Name)" -Value (Get-Item "function:$($f.Name)").ScriptBlock
    }
    foreach ($v in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ne '$ErrorActionPreference' }) {
        $name = $v.Left.Extent.Text.TrimStart('$')
        Set-Variable -Scope Global -Name $name -Value (Get-Variable -Name $name -ValueOnly)
    }
    $ast
}

Write-Host '== 檔案格式'
foreach ($p in @($install, $uninstall, (Join-Path $scripts 'build-release.ps1'), $PSCommandPath)) {
    $b = [IO.File]::ReadAllBytes($p)
    Assert-True ($b.Length -gt 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) "$(Split-Path -Leaf $p) 是 UTF-8 BOM"
}

Write-Host '== 函式名稱不與內建別名 / 指令衝突'
$astInstall = Import-ScriptParts $install
$astUninstall = Import-ScriptParts $uninstall
$aliases = @(Get-Alias | ForEach-Object Name)
$builtins = @(Get-Command -CommandType Cmdlet | ForEach-Object Name)
foreach ($a in @($astInstall, $astUninstall)) {
    foreach ($f in $a.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        Assert-True (($aliases -notcontains $f.Name) -and ($builtins -notcontains $f.Name)) "函式 $($f.Name) 沒有衝突"
    }
}
# sc 在 PowerShell 是 Set-Content 的別名:腳本一律寫 sc.exe
foreach ($p in @($install, $uninstall, (Join-Path $scripts 'build-release.ps1'))) {
    $raw = Get-Content -LiteralPath $p -Raw
    Assert-True (-not ($raw -match '(?m)(^|[\s(&|;])sc\s')) "$(Split-Path -Leaf $p) 沒有裸用 sc 別名"
}

Write-Host '== SHA-256 驗證(M6)'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("netops-ad-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $f = Join-Path $tmp 'netops-ad-agent.exe'
    [IO.File]::WriteAllBytes($f, [byte[]](1, 2, 3, 4))
    $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
    Assert-True ((Test-FileSha256 -Path $f -Expected $h.ToLowerInvariant()) -eq $h) '雜湊相同(小寫也可)通過'
    Assert-Throws { Test-FileSha256 -Path $f -Expected ('0' * 64) } '雜湊不同中止' '*SHA-256 不符*'
    Assert-Throws { Test-FileSha256 -Path (Join-Path $tmp 'none.exe') -Expected $h } '找不到檔案中止' '*找不到*'
    $sums = Join-Path $tmp 'SHA256SUMS.txt'
    Assert-True (-not (Test-ReleaseSums -SumsPath $sums -FileName 'netops-ad-agent.exe' -Expected $h)) '沒有 SHA256SUMS.txt 時略過'
    Set-Content -LiteralPath $sums -Value "$($h.ToLowerInvariant())  netops-ad-agent-0.1.0/netops-ad-agent.exe" -Encoding ASCII
    Assert-True (Test-ReleaseSums -SumsPath $sums -FileName 'netops-ad-agent.exe' -Expected $h) 'SHA256SUMS.txt 一致'
    Set-Content -LiteralPath $sums -Value "$('a' * 64)  netops-ad-agent.exe" -Encoding ASCII
    Assert-Throws { Test-ReleaseSums -SumsPath $sums -FileName 'netops-ad-agent.exe' -Expected $h } 'SHA256SUMS.txt 不一致中止' '*不同*'
    Set-Content -LiteralPath $sums -Value "$('a' * 64)  other.exe" -Encoding ASCII
    Assert-Throws { Test-ReleaseSums -SumsPath $sums -FileName 'netops-ad-agent.exe' -Expected $h } 'SHA256SUMS.txt 沒列執行檔中止' '*沒有*'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force
}

Write-Host '== 既有目錄的擁有者與 junction(資安審查 M-1)、SHA256SUMS 位置(L-3)'
Assert-True (Test-TrustedOwnerSid 'S-1-5-18') 'SYSTEM 是可信擁有者'
Assert-True (Test-TrustedOwnerSid 'S-1-5-32-544') 'Administrators 是可信擁有者'
Assert-True (-not (Test-TrustedOwnerSid 'S-1-5-32-545')) 'Users 不是可信擁有者'
Assert-True (-not (Test-TrustedOwnerSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value))) '一般帳號不是可信擁有者'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("netops-ad-test-" + [guid]::NewGuid())
$fakeData = Join-Path $tmp 'GigaNexus\NetOpsAdAgent'
New-Item -ItemType Directory -Path $fakeData | Out-Null
try {
    # 測試目錄的擁有者是目前帳號(模擬一般使用者預先建立)→ 中止
    Assert-Throws { Assert-TrustedTree $fakeData } '一般使用者建立的目錄中止安裝' '*中止安裝*'
    Assert-True ($null -eq (Find-ReleaseSums -Dir $fakeData)) '沒有 SHA256SUMS.txt 回 null'
    Set-Content -LiteralPath (Join-Path $tmp 'GigaNexus\SHA256SUMS.txt') -Value 'x' -Encoding ASCII
    Assert-True ((Find-ReleaseSums -Dir $fakeData) -like '*GigaNexus\SHA256SUMS.txt') '上一層的 SHA256SUMS.txt 也找得到'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force
}
$installText = Get-Content -LiteralPath $install -Raw
Assert-True (($installText -match '& \$staged --version') -and ($installText -match '& \$Staged --check-config')) '執行檔驗證後只從受保護的暫存目錄執行(M-2)'
Assert-True ($installText -match 'installed\.sha256') '-Resume 前核對安裝時的雜湊(M-2)'

Write-Host '== Token 與設定'
Assert-True (Test-AgentToken ('a' * 64)) '64 字十六進位 Token 合法'
Assert-True (-not (Test-AgentToken 'change-me')) '太短的 Token 不合法'
Assert-True (-not (Test-AgentToken (('a' * 40) + ' x'))) '含空白的 Token 不合法'
$t = New-AgentConfigText -Url 'http://10.10.130.124:51295/' -ComputerName 'GSMC-DC1' -DomainName 'GSMC.com.tw'
Assert-True ($t -match '(?m)^server_url = "http://10\.10\.130\.124:51295"\r?$') 'server_url 去掉結尾斜線'
Assert-True ($t -match '(?m)^domain = "gsmc\.com\.tw"\r?$') 'domain 轉小寫'
Assert-True ($t -match '(?m)^include_user_logon_4624 = false\r?$') '4624 預設關閉'
Assert-True ($t -match '(?m)^include_kerberos_weak_tgs = false\r?$') '4769 弱加密 TGS 預設關閉(AD-6 §9.3)'
Assert-True ($t -match '(?m)^include_dcsync_4662 = false\r?$') '4662 DCSync 預設關閉(AD-6 §9.3)'
Assert-True ($t -match '(?m)^include_gpo_change_5136 = false\r?$') '5136 GPO 變更預設關閉(AD-6 §9.3)'
Assert-True ($t -match '高事件量開關') '設定檔含量大先實測註解(AD-6 §9.3)'
Assert-True (-not ($t -match 'token\s*=')) '設定檔不含 Token 值'
$t2 = New-AgentConfigText -Url 'http://h:1' -ComputerName 'DC2' -DomainName 'x.local' -Include4624 $true -IncludeKerberosWeakTgs $true -IncludeDcsync4662 $true -IncludeGpoChange5136 $true
Assert-True ($t2 -match '(?m)^include_user_logon_4624 = true\r?$') '-IncludeUserLogon4624 開啟'
Assert-True ($t2 -match '(?m)^include_kerberos_weak_tgs = true\r?$') '-IncludeKerberosWeakTgs 開啟'
Assert-True ($t2 -match '(?m)^include_dcsync_4662 = true\r?$') '-IncludeDcsync4662 開啟'
Assert-True ($t2 -match '(?m)^include_gpo_change_5136 = true\r?$') '-IncludeGpoChange5136 開啟'
Assert-Throws { New-AgentConfigText -Url 'https://h:1' -ComputerName 'DC' -DomainName 'x' } '拒絕 https(需求方決定明文 HTTP)' '*http://*'
Assert-Throws { New-AgentConfigText -Url 'http://u:p@h:1' -ComputerName 'DC' -DomainName 'x' } '拒絕帳密' '*http://*'
Assert-Throws { New-AgentConfigText -Url 'http://h:1' -ComputerName 'DC 1' -DomainName 'x' } '拒絕錯誤的 computer' '*Computer*'

Write-Host '== -Pause / -Resume 順序(M5)'
$p = @(Get-PauseSteps | ForEach-Object { "$($_.Service):$($_.Action)" })
Assert-True (($p -join ',') -eq 'NetOpsAdWatchdog:Manual,NetOpsAdWatchdog:NoRecovery,NetOpsAdWatchdog:Stop,NetOpsAdAgent:Manual,NetOpsAdAgent:NoRecovery,NetOpsAdAgent:Stop') "暫停先處理 Watchdog,停止前關閉失敗復原($($p -join ','))"
$r = @(Get-ResumeSteps | ForEach-Object { "$($_.Service):$($_.Action)" })
Assert-True (($r -join ',') -eq 'NetOpsAdAgent:Recovery,NetOpsAdAgent:Automatic,NetOpsAdAgent:Start,NetOpsAdWatchdog:Recovery,NetOpsAdWatchdog:Automatic,NetOpsAdWatchdog:Start') "恢復先啟動 Agent,啟動前設回失敗復原($($r -join ','))"
Assert-True ((@(Get-UninstallOrder) -join ',') -eq 'NetOpsAdWatchdog,NetOpsAdAgent') '移除先停 Watchdog'
Assert-Throws { Invoke-ServiceStep @{ Service = 'NetOpsAdAgent-不存在'; Action = 'Stop' } } '服務不存在時明確失敗' '*不存在*'

Write-Host '== 服務與目錄 ACL'
Assert-True ($ServiceSddl -match '\(A;;CCLCSWLOCRRC;;;AU\)' -and $ServiceSddl -notmatch 'RPWP[^;]*;;;AU') '一般使用者只能查詢服務'
Assert-True ($SidSystem -eq '*S-1-5-18' -and $SidAdmins -eq '*S-1-5-32-544') '目錄 ACL 用 SYSTEM / Administrators 的 SID'

Write-Host '== 服務升級設定(含空白路徑不遺失雙引號,審查 M1)'
$spaceExe = 'C:\Program Files\GigaNexus\NetOpsAdAgent\netops-ad-agent.exe'
$spaceCfg = 'C:\Program Data\GigaNexus\NetOpsAdAgent\agent.toml'
$binPath = New-ServiceBinaryPath -Exe $spaceExe -Mode 'agent' -Config $spaceCfg
Assert-True ($binPath -eq "`"$spaceExe`" --mode agent --config `"$spaceCfg`"") '含空白路徑的 binPath 雙引號完整'
$chg = New-ServiceChangeArguments -BinPath $binPath
Assert-True ($chg.PathName -eq $binPath -and $chg.StartMode -eq 'Automatic' -and $chg.StartName -eq 'LocalSystem') 'CIM Win32_Service.Change 參數正確保留路徑雙引號與啟動模式'
Assert-True (-not ($installText -match "Invoke-ScExe\s+@\('config'")) '升級服務不再經由 sc.exe config 傳遞內嵌雙引號 binPath'
Assert-True (-not ($installText -match 'Stop-Service\s+-') -and -not ((Get-Content -LiteralPath $uninstall -Raw) -match 'Stop-Service\s+-')) '停止服務一律經 Stop-AdServiceSafely(不直接 Stop-Service)'
Assert-True ($installText -match 'Invoke-CimMethod\s+-InputObject\s+\$svc\s+-MethodName\s+Change' -and $installText -match '\$r\.ReturnValue\s+-ne\s+0') '升級服務改用 CIM Change 並驗證 ReturnValue == 0'
Assert-Throws { Set-ExistingServiceConfig -Name 'bad name' -BinPath $binPath } '拒絕非法服務名稱' '*格式錯誤*'

Write-Host '== 停不下來時安全收尾(0.1.1,DC1 實測 0.1.0 Stop-Service 失敗)'
# 兩支腳本的共用區塊必須相同
$blockRe = '(?s)# ===== 安全停止服務\(Install / Uninstall 兩支腳本共用.*?# ===== 安全停止服務\(共用\)結束 ====='
$bi = [regex]::Match($installText, $blockRe).Value
$bu = [regex]::Match((Get-Content -LiteralPath $uninstall -Raw), $blockRe).Value
Assert-True ($bi.Length -gt 0 -and $bi -ceq $bu) 'Install / Uninstall 的安全停止區塊內容相同'
Assert-Throws { Assert-AdServiceName 'Spooler' } '只處理 NetOps AD 服務' '*拒絕*'
Assert-Throws { Assert-AdServiceName 'netopsadagent' } '服務名稱大小寫也要相符' '*拒絕*'
Assert-Throws { Disable-AdServiceRecovery -Name 'W32Time' } '關閉失敗復原拒絕其他服務' '*拒絕*'
Assert-Throws { Stop-AdServiceSafely -Name 'W32Time' -ExpectedExe 'C:\x.exe' } '安全停止拒絕其他服務' '*拒絕*'
Assert-True ((Get-RecoveryNoneArguments -Name 'NetOpsAdAgent') -ceq 'failure NetOpsAdAgent reset= 0 actions= ""') '關閉失敗復原用 actions= ""(Start-Process 整段參數傳空字串)'
Assert-True ((Get-ScExePath) -ieq (Join-Path $env:SystemRoot 'System32\sc.exe')) 'sc.exe 用完整路徑(資安 M-1)'
foreach ($p2 in @($install, $uninstall)) {
    $raw2 = Get-Content -LiteralPath $p2 -Raw
    Assert-True (-not ($raw2 -match '&\s+sc\.exe') -and -not ($raw2 -match 'cmd\.exe')) "$(Split-Path -Leaf $p2) 不經 cmd.exe、不以相對名稱呼叫 sc.exe"
}
$ra = @(Get-RecoveryArguments -Name 'NetOpsAdWatchdog')
Assert-True ($ra.Count -eq 2 -and ($ra[0] -join ' ') -eq 'failure NetOpsAdWatchdog reset= 86400 actions= restart/10000/restart/30000/restart/60000' -and ($ra[1] -join ' ') -eq 'failureflag NetOpsAdWatchdog 1') '恢復失敗復原:10 / 30 / 60 秒與 failureflag 1'

function New-FailureBlob {
    param([int[]]$Types)
    $b = New-Object byte[] (20 + 8 * $Types.Count)
    [BitConverter]::GetBytes([uint32]86400).CopyTo($b, 0)
    [BitConverter]::GetBytes([uint32]$Types.Count).CopyTo($b, 12)
    for ($i = 0; $i -lt $Types.Count; $i++) {
        [BitConverter]::GetBytes([uint32]$Types[$i]).CopyTo($b, 20 + 8 * $i)
        [BitConverter]::GetBytes([uint32]10000).CopyTo($b, 24 + 8 * $i)
    }
    , $b
}
Assert-True (Test-FailureActionsNone $null) '沒有 FailureActions 值 = 已關閉'
Assert-True (Test-FailureActionsNone (New-FailureBlob @())) '0 個動作 = 已關閉'
Assert-True (Test-FailureActionsNone (New-FailureBlob @(0, 0, 0))) '全部 SC_ACTION_NONE = 已關閉'
Assert-True (-not (Test-FailureActionsNone (New-FailureBlob @(1, 1, 1)))) '安裝時的 restart × 3 = 未關閉'
Assert-True (-not (Test-FailureActionsNone (New-FailureBlob @(0, 1)))) '只要有一個 restart 就未關閉'
Assert-True (-not (Test-FailureActionsNone ([byte[]](1, 2, 3)))) '格式不對視為未關閉'
$bad = New-FailureBlob @(0); [BitConverter]::GetBytes([uint32]5).CopyTo($bad, 12)
Assert-True (-not (Test-FailureActionsNone $bad)) '動作數超過資料長度視為未關閉'

$exe = 'C:\Program Files\GigaNexus\NetOpsAdAgent\netops-ad-agent.exe'
Assert-True (Test-OwnServiceProcess -ProcessPath 'c:\program files\GigaNexus\NetOpsAdAgent\NETOPS-AD-AGENT.EXE' -ExpectedExe $exe) '行程路徑相同(不分大小寫)才結束'
Assert-True (-not (Test-OwnServiceProcess -ProcessPath 'C:\Windows\System32\svchost.exe' -ExpectedExe $exe)) '其他行程不結束'
Assert-True (-not (Test-OwnServiceProcess -ProcessPath '' -ExpectedExe $exe)) '取不到路徑不結束'

# 以假的 Get-Service / CIM / Get-Process 驗證流程順序(不碰真的服務與行程)
$script:calls = New-Object System.Collections.ArrayList
function New-FakeController {
    param([bool]$GracefulOk, [string]$Status = 'Running', [bool]$StopsBySelf = $false)
    $o = [pscustomobject]@{ Status = $Status; GracefulOk = $GracefulOk; Killed = $false; StopsBySelf = $StopsBySelf }
    $o | Add-Member ScriptMethod Stop {
        [void]$script:calls.Add('Stop')
        if ($this.StopsBySelf) { $this.Status = 'Stopped'; throw 'Cannot stop: service not started' }
    }
    $o | Add-Member ScriptMethod Refresh { if ($this.Killed) { $this.Status = 'Stopped' } }
    $o | Add-Member ScriptMethod WaitForStatus {
        param($s, $t)
        [void]$script:calls.Add('Wait')
        if (-not $this.GracefulOk -and -not $this.Killed) { throw 'Time out has expired' }
    }
    $o
}
function New-FakeProcess {
    param([string]$Path)
    $o = [pscustomobject]@{ Id = 4242; Path = $Path; Handle = 1 }
    $o | Add-Member ScriptMethod Kill { [void]$script:calls.Add("Kill:$($this.Id)"); $script:fake.Killed = $true }
    $o | Add-Member ScriptMethod WaitForExit { param($ms) $true }
    $o
}
function global:Get-Service { param($Name, $ErrorAction) $script:fake }
function global:Disable-AdServiceRecovery { param($Name) [void]$script:calls.Add("NoRecovery:$Name") }
function global:Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($ClassName -eq 'Win32_Service') { $script:pids.Dequeue() } else { [pscustomobject]@{ ExecutablePath = $script:cimPath } }
}
function global:Get-Process { param($Id, $ErrorAction) [void]$script:calls.Add("Open:$Id"); New-FakeProcess -Path $script:fakePath }
function Reset-Fake {
    param([int[]]$Pids = @(4242, 4242))
    $script:calls.Clear()
    $script:pids = New-Object System.Collections.Queue
    foreach ($x in $Pids) { $script:pids.Enqueue([pscustomobject]@{ ProcessId = $x }) }
}
try {
    Reset-Fake
    $script:fake = New-FakeController -GracefulOk $true
    Stop-AdServiceSafely -Name 'NetOpsAdAgent' -ExpectedExe $exe -TimeoutSec 1
    Assert-True (($script:calls -join ',') -eq 'Stop,Wait') "正常停止不結束行程($($script:calls -join ','))"

    Reset-Fake; $script:fakePath = $exe
    $script:fake = New-FakeController -GracefulOk $false
    Stop-AdServiceSafely -Name 'NetOpsAdAgent' -ExpectedExe $exe -TimeoutSec 1 3>$null 6>$null
    Assert-True (($script:calls -join ',') -eq 'Stop,Wait,NoRecovery:NetOpsAdAgent,Open:4242,Kill:4242,Wait') "停不下來:先關閉失敗復原再結束行程並等待停止($($script:calls -join ','))"

    Reset-Fake; $script:fakePath = $null; $script:cimPath = $exe
    $script:fake = New-FakeController -GracefulOk $false
    Stop-AdServiceSafely -Name 'NetOpsAdAgent' -ExpectedExe $exe -TimeoutSec 1 3>$null 6>$null
    Assert-True ($script:calls -contains 'Kill:4242') '行程 Path 讀不到時改用 CIM 路徑比對'

    Reset-Fake; $script:fakePath = 'C:\Windows\System32\svchost.exe'
    $script:fake = New-FakeController -GracefulOk $false
    Assert-Throws { Stop-AdServiceSafely -Name 'NetOpsAdAgent' -ExpectedExe $exe -TimeoutSec 1 3>$null } '行程不是安裝目錄的 exe 時不結束' '*不結束*'
    Assert-True (-not ($script:calls -match '^Kill')) '路徑不符時沒有結束任何行程'

    Reset-Fake -Pids @(4242, 5555); $script:fakePath = $exe
    $script:fake = New-FakeController -GracefulOk $false
    Assert-Throws { Stop-AdServiceSafely -Name 'NetOpsAdAgent' -ExpectedExe $exe -TimeoutSec 1 3>$null } '服務的 PID 在比對期間改變時不結束(PID 重用)' '*已改變*'
    Assert-True (-not ($script:calls -match '^Kill')) 'PID 改變時沒有結束任何行程'

    Reset-Fake
    $script:fake = New-FakeController -GracefulOk $false -StopsBySelf $true
    Stop-AdServiceSafely -Name 'NetOpsAdAgent' -ExpectedExe $exe -TimeoutSec 1 3>$null
    Assert-True (($script:calls -join ',') -eq 'Stop') "送出停止前服務已自己停下:不關閉失敗復原、不結束行程($($script:calls -join ','))"

    Reset-Fake
    $script:fake = New-FakeController -GracefulOk $true -Status 'Stopped'
    Stop-AdServiceSafely -Name 'NetOpsAdWatchdog' -ExpectedExe $exe -TimeoutSec 1
    Assert-True ($script:calls.Count -eq 0) '已停止的服務不動作'

    # -Pause 失敗:還在執行的服務設回失敗復原後再拋出(審查 5、資安 L-2)
    Reset-Fake
    $script:fake = New-FakeController -GracefulOk $true
    function global:Invoke-ServiceStep { param($Step) if ($Step.Action -eq 'Stop' -and $Step.Service -eq 'NetOpsAdAgent') { throw '模擬停止失敗' } }
    function global:Set-AdServiceRecovery { param($Name) [void]$script:calls.Add("Recovery:$Name") }
    Assert-Throws { Suspend-NetOpsAdAgent 3>$null 6>$null } '-Pause 停止失敗時拋出錯誤' '*模擬停止失敗*'
    Assert-True (($script:calls -join ',') -eq 'Recovery:NetOpsAdWatchdog,Recovery:NetOpsAdAgent') "-Pause 失敗時還在執行的服務設回失敗復原($($script:calls -join ','))"
} finally {
    foreach ($f in 'Get-Service', 'Disable-AdServiceRecovery', 'Get-CimInstance', 'Get-Process', 'Invoke-ServiceStep', 'Set-AdServiceRecovery') {
        Remove-Item -Path "function:global:$f" -ErrorAction SilentlyContinue
    }
    # 測試替換了腳本的函式:重新載入
    $null = Import-ScriptParts $install
}

Write-Host ''
Write-Host "通過 $script:passed、失敗 $script:failed"
if ($script:failed -gt 0) { exit 1 }
