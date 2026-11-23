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

Write-Host '== Token 與設定'
Assert-True (Test-AgentToken ('a' * 64)) '64 字十六進位 Token 合法'
Assert-True (-not (Test-AgentToken 'change-me')) '太短的 Token 不合法'
Assert-True (-not (Test-AgentToken (('a' * 40) + ' x'))) '含空白的 Token 不合法'
$t = New-AgentConfigText -Url 'http://10.10.130.124:51295/' -ComputerName 'GSMC-DC1' -DomainName 'GSMC.com.tw'
Assert-True ($t -match '(?m)^server_url = "http://10\.10\.130\.124:51295"\r?$') 'server_url 去掉結尾斜線'
Assert-True ($t -match '(?m)^domain = "gsmc\.com\.tw"\r?$') 'domain 轉小寫'
Assert-True ($t -match '(?m)^include_user_logon_4624 = false\r?$') '4624 預設關閉'
Assert-True (-not ($t -match 'token\s*=')) '設定檔不含 Token 值'
$t2 = New-AgentConfigText -Url 'http://h:1' -ComputerName 'DC2' -DomainName 'x.local' -Include4624 $true
Assert-True ($t2 -match '(?m)^include_user_logon_4624 = true\r?$') '-IncludeUserLogon4624 開啟'
Assert-Throws { New-AgentConfigText -Url 'https://h:1' -ComputerName 'DC' -DomainName 'x' } '拒絕 https(需求方決定明文 HTTP)' '*http://*'
Assert-Throws { New-AgentConfigText -Url 'http://u:p@h:1' -ComputerName 'DC' -DomainName 'x' } '拒絕帳密' '*http://*'
Assert-Throws { New-AgentConfigText -Url 'http://h:1' -ComputerName 'DC 1' -DomainName 'x' } '拒絕錯誤的 computer' '*Computer*'

Write-Host '== -Pause / -Resume 順序(M5)'
$p = @(Get-PauseSteps | ForEach-Object { "$($_.Service):$($_.Action)" })
Assert-True (($p -join ',') -eq 'NetOpsAdWatchdog:Manual,NetOpsAdWatchdog:Stop,NetOpsAdAgent:Manual,NetOpsAdAgent:Stop') "暫停先處理 Watchdog($($p -join ','))"
$r = @(Get-ResumeSteps | ForEach-Object { "$($_.Service):$($_.Action)" })
Assert-True (($r -join ',') -eq 'NetOpsAdAgent:Automatic,NetOpsAdAgent:Start,NetOpsAdWatchdog:Automatic,NetOpsAdWatchdog:Start') "恢復先啟動 Agent($($r -join ','))"
Assert-True ((@(Get-UninstallOrder) -join ',') -eq 'NetOpsAdWatchdog,NetOpsAdAgent') '移除先停 Watchdog'
Assert-Throws { Invoke-ServiceStep @{ Service = 'NetOpsAdAgent-不存在'; Action = 'Stop' } } '服務不存在時明確失敗' '*不存在*'

Write-Host '== 服務與目錄 ACL'
Assert-True ($ServiceSddl -match '\(A;;CCLCSWLOCRRC;;;AU\)' -and $ServiceSddl -notmatch 'RPWP[^;]*;;;AU') '一般使用者只能查詢服務'
Assert-True ($SidSystem -eq '*S-1-5-18' -and $SidAdmins -eq '*S-1-5-32-544') '目錄 ACL 用 SYSTEM / Administrators 的 SID'

Write-Host ''
Write-Host "通過 $script:passed、失敗 $script:failed"
if ($script:failed -gt 0) { exit 1 }
