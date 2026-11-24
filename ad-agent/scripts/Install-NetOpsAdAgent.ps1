<#
.SYNOPSIS
  安裝 / 升級 NetOps AD Agent 與 Watchdog 兩個 Windows 服務,或維護時暫停 / 恢復(AD-2;docs/AD-AGENT-PLAN.md §3.4、AD10)。

.DESCRIPTION
  安裝 / 升級(預設):
    1. 驗證 netops-ad-agent.exe 的 SHA-256 與 -ExpectedSha256 相同(值從 CI job 記錄或 SHA256SUMS.txt 另外取得,不要只信同一個資料夾的檔案;M6)。
       發佈資料夾有 SHA256SUMS.txt 時也要一致。驗證失敗即中止,不複製、不註冊
    2. 建立 %ProgramFiles%\GigaNexus\NetOpsAdAgent(執行檔)與 %ProgramData%\GigaNexus\NetOpsAdAgent(agent.toml、secrets、state、logs),
       ACL 只允許 SYSTEM 與 Administrators(不繼承)
    3. 第一次安裝(或 -ReplaceToken)以隱藏輸入讀入該 DC 專屬 Token,寫進 secrets\ad_agent.token;不放環境變數、命令列參數或日誌
    4. 第一次安裝(或 -RewriteConfig)寫 agent.toml;以新執行檔 --check-config 檢查
    5. 升級時先停 Watchdog(改手動)再停 Agent,換執行檔後再驗一次雜湊
    6. 註冊兩個服務(LocalSystem、自動啟動)、SCM 失敗復原 10 / 30 / 60 秒、服務 ACL(一般使用者只能查詢)
    7. 依序啟動 Agent、Watchdog
  -Pause:DC 維護前執行。Watchdog 改手動並停止 → Agent 改手動並停止(維護中重開機也不會自己起來;M5)。
          暫停期間心跳中斷,超過 AD_HEARTBEAT_OFFLINE_SEC(180 秒)後畫面顯示離線
  -Resume:Agent 改自動並啟動 → Watchdog 改自動並啟動

  需要系統管理員 PowerShell(Windows PowerShell 5.1 以上)。

.EXAMPLE
  # 第一次安裝(會提示輸入 Token,輸入不顯示)
  .\Install-NetOpsAdAgent.ps1 -ExpectedSha256 <CI 顯示的雜湊> -ServerUrl http://10.10.130.124:51295 -Domain gsmc.com.tw
.EXAMPLE
  # 升級(沿用既有 agent.toml 與 Token)
  .\Install-NetOpsAdAgent.ps1 -ExpectedSha256 <新版雜湊>
.EXAMPLE
  .\Install-NetOpsAdAgent.ps1 -Pause
  .\Install-NetOpsAdAgent.ps1 -Resume
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install')][string]$SourceDir = $PSScriptRoot,
    [Parameter(ParameterSetName = 'Install', Mandatory = $true)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$ExpectedSha256,
    [Parameter(ParameterSetName = 'Install')][string]$ServerUrl,
    [Parameter(ParameterSetName = 'Install')][string]$Computer = $env:COMPUTERNAME,
    [Parameter(ParameterSetName = 'Install')][string]$Domain,
    [Parameter(ParameterSetName = 'Install')][switch]$IncludeUserLogon4624,
    [Parameter(ParameterSetName = 'Install')][switch]$ReplaceToken,
    [Parameter(ParameterSetName = 'Install')][switch]$RewriteConfig,
    [Parameter(ParameterSetName = 'Pause', Mandatory = $true)][switch]$Pause,
    [Parameter(ParameterSetName = 'Resume', Mandatory = $true)][switch]$Resume
)
$ErrorActionPreference = 'Stop'

$AgentService = 'NetOpsAdAgent'
$WatchdogService = 'NetOpsAdWatchdog'
$ExeName = 'netops-ad-agent.exe'
$InstallDir = Join-Path $env:ProgramFiles 'GigaNexus\NetOpsAdAgent'
$DataDir = Join-Path $env:ProgramData 'GigaNexus\NetOpsAdAgent'
# SYSTEM(S-1-5-18)與 Administrators(S-1-5-32-544):用 SID,不受中文 / 英文系統帳戶名稱影響
$SidSystem = '*S-1-5-18'
$SidAdmins = '*S-1-5-32-544'
# 服務 ACL:SYSTEM、Administrators 完整控制;互動 / 服務 / 已驗證使用者只能查詢(同 RustIt)
$ServiceSddl = 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWLOCRRC;;;AU)'

function Assert-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '請以系統管理員身分執行 PowerShell'
    }
}

# 檔案 SHA-256 必須等於預期值(不分大小寫);不符即中止(M6)
function Test-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Expected)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "找不到 $Path" }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $Expected.ToUpperInvariant()) {
        throw "SHA-256 不符,中止安裝:$Path`n  預期 $($Expected.ToUpperInvariant())`n  實際 $actual"
    }
    $actual
}

# 發佈資料夾的 SHA256SUMS.txt(`<雜湊>  <相對路徑>`)若列了執行檔,必須與預期值相同
function Test-ReleaseSums {
    param([Parameter(Mandatory = $true)][string]$SumsPath, [Parameter(Mandatory = $true)][string]$FileName, [Parameter(Mandatory = $true)][string]$Expected)
    if (-not (Test-Path -LiteralPath $SumsPath -PathType Leaf)) { return $false }
    foreach ($line in Get-Content -LiteralPath $SumsPath) {
        if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$' -and (Split-Path -Leaf $Matches[2].Trim()) -eq $FileName) {
            if ($Matches[1].ToUpperInvariant() -ne $Expected.ToUpperInvariant()) {
                throw "SHA256SUMS.txt 記錄的 $FileName 雜湊與 -ExpectedSha256 不同,中止安裝"
            }
            return $true
        }
    }
    throw "SHA256SUMS.txt 沒有 $FileName 這一行,中止安裝"
}

# Token 格式與接收端相同:32–128 個英數字、_ 或 -
function Test-AgentToken {
    param([string]$Token)
    return [bool]($Token -cmatch '^[0-9A-Za-z_-]{32,128}$')
}

function Test-ServerUrl {
    param([string]$Url)
    return [bool]($Url -match '^http://[A-Za-z0-9.-]+:\d{1,5}/?$')
}

# agent.toml 內容(UTF-8 無 BOM 由呼叫端寫入)
function New-AgentConfigText {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$ComputerName,
        [Parameter(Mandatory = $true)][string]$DomainName,
        [bool]$Include4624 = $false
    )
    if (-not (Test-ServerUrl $Url)) { throw "ServerUrl 必須是 http://主機:埠(明文 HTTP):$Url" }
    if ($ComputerName -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { throw "Computer 格式錯誤:$ComputerName" }
    if ($DomainName -notmatch '^[A-Za-z0-9.-]{1,253}$') { throw "Domain 格式錯誤:$DomainName" }
    $flag = if ($Include4624) { 'true' } else { 'false' }
    @(
        '# 由 Install-NetOpsAdAgent.ps1 產生;說明見 agent.toml.example'
        "server_url = `"$($Url.TrimEnd('/'))`""
        "computer = `"$ComputerName`""
        "domain = `"$($DomainName.ToLowerInvariant())`""
        'token_file = "secrets/ad_agent.token"'
        "include_user_logon_4624 = $flag"
        ''
    ) -join "`r`n"
}

# 擁有者只能是 SYSTEM 或 Administrators(資安審查 M-1)
function Test-TrustedOwnerSid {
    param([string]$Sid)
    return ($Sid -eq 'S-1-5-18' -or $Sid -eq 'S-1-5-32-544')
}

# 安裝前檢查既有目錄(資安審查 M-1):一般使用者可以在 %ProgramData% 先建立 GigaNexus\NetOpsAdAgent 並成為擁有者,
# 預先放 agent.toml(把 server_url 指到別處)或 junction(把 Token 寫到別處)。
# 上一層 GigaNexus、目錄本身與裡面所有項目:不可是 reparse point(junction / 符號連結),擁有者必須是 SYSTEM 或 Administrators;
# 不符就中止,請管理員檢查後移除
function Assert-TrustedTree {
    param([Parameter(Mandatory = $true)][string]$Path)
    $items = @()
    $parent = Split-Path -Parent $Path
    if (Test-Path -LiteralPath $parent) { $items += Get-Item -LiteralPath $parent -Force }
    if (Test-Path -LiteralPath $Path) {
        $items += Get-Item -LiteralPath $Path -Force
        # PowerShell 5.1 的 -Recurse 不進入 junction;junction 本身會列出,下面一律中止
        $items += @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop)
    }
    foreach ($i in $items) {
        if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "$($i.FullName) 是 junction / 符號連結,中止安裝(可能被預先放置;請管理員檢查後移除)"
        }
        $owner = (Get-Acl -LiteralPath $i.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not (Test-TrustedOwnerSid $owner)) {
            throw "$($i.FullName) 的擁有者是 $owner,不是 SYSTEM / Administrators,中止安裝(可能被一般使用者預先建立;請管理員檢查後移除)"
        }
    }
}

# 目錄 ACL:只允許 SYSTEM 與 Administrators,不繼承上層;子項目的明確 ACE 全部重設成只從本目錄繼承(資安審查 M-1)
function Set-PrivateAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    & icacls.exe $Path /inheritance:r /grant:r "$($SidSystem):(OI)(CI)F" "$($SidAdmins):(OI)(CI)F" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 設定 $Path 失敗($LASTEXITCODE)" }
    if (Get-ChildItem -LiteralPath $Path -Force) {
        & icacls.exe (Join-Path $Path '*') /reset /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls 重設 $Path 子項目失敗($LASTEXITCODE)" }
    }
}

function Read-AgentToken {
    param([string]$ForComputer)
    $secure = Read-Host -AsSecureString "貼上 $ForComputer 的 AD Agent Token(輸入不顯示)"
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if (-not (Test-AgentToken $plain)) { throw 'Token 格式錯誤(32–128 個英數字、_ 或 -);內容不顯示' }
    $plain
}

function Write-Utf8NoBom {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# 暫停 / 恢復的步驟順序(純資料,方便測試):先處理 Watchdog,Agent 才不會被拉起來
function Get-PauseSteps {
    @(
        @{ Service = $WatchdogService; Action = 'Manual' }
        @{ Service = $WatchdogService; Action = 'Stop' }
        @{ Service = $AgentService; Action = 'Manual' }
        @{ Service = $AgentService; Action = 'Stop' }
    )
}

function Get-ResumeSteps {
    @(
        @{ Service = $AgentService; Action = 'Automatic' }
        @{ Service = $AgentService; Action = 'Start' }
        @{ Service = $WatchdogService; Action = 'Automatic' }
        @{ Service = $WatchdogService; Action = 'Start' }
    )
}

function Invoke-ServiceStep {
    param([Parameter(Mandatory = $true)][hashtable]$Step)
    if (-not (Get-Service -Name $Step.Service -ErrorAction SilentlyContinue)) { throw "服務 $($Step.Service) 不存在(尚未安裝?)" }
    switch ($Step.Action) {
        'Manual' { Set-Service -Name $Step.Service -StartupType Manual }
        'Automatic' { Set-Service -Name $Step.Service -StartupType Automatic }
        'Stop' { Stop-Service -Name $Step.Service -Force -ErrorAction Stop }
        'Start' { Start-Service -Name $Step.Service -ErrorAction Stop }
        default { throw "未知的步驟 $($Step.Action)" }
    }
    Write-Host ("  {0,-17} {1}" -f $Step.Service, $Step.Action)
}

function Suspend-NetOpsAdAgent {
    Write-Host '暫停 AD Agent(維護模式):'
    foreach ($s in Get-PauseSteps) { Invoke-ServiceStep $s }
    Write-Host '已暫停。心跳中斷超過 180 秒畫面會顯示離線;維護完成後執行 -Resume。' -ForegroundColor Yellow
}

function Resume-NetOpsAdAgent {
    # 安裝時記下的雜湊:執行檔被換掉就不啟動(資安審查 M-2)
    $recorded = Join-Path $DataDir 'installed.sha256'
    if (Test-Path -LiteralPath $recorded) {
        Test-FileSha256 -Path (Join-Path $InstallDir $ExeName) -Expected ((Get-Content -LiteralPath $recorded -TotalCount 1).Trim()) | Out-Null
    }
    Write-Host '恢復 AD Agent:'
    foreach ($s in Get-ResumeSteps) { Invoke-ServiceStep $s }
    Write-Host '已恢復。Agent 會從 bookmarks.json 的水位接著讀,暫停期間的事件會補送。' -ForegroundColor Green
}

function Invoke-ScExe {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $out = & sc.exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sc.exe $($Arguments -join ' ') 失敗($LASTEXITCODE):$out" }
}

function New-ServiceBinaryPath {
    param([Parameter(Mandatory = $true)][string]$Exe, [Parameter(Mandatory = $true)][string]$Mode, [Parameter(Mandatory = $true)][string]$Config)
    "`"$Exe`" --mode $Mode --config `"$Config`""
}

# 升級既有服務用 CIM Win32_Service.Change 的參數:避免 PowerShell 5.1 傳給 sc.exe config 時吞掉路徑內嵌雙引號(審查 M1)
function New-ServiceChangeArguments {
    param([Parameter(Mandatory = $true)][string]$BinPath)
    @{
        PathName  = $BinPath
        StartMode = 'Automatic'
        StartName = 'LocalSystem'
    }
}

function Set-ExistingServiceConfig {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$BinPath)
    if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw "服務名稱格式錯誤:$Name" }
    $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    if (-not $svc) { throw "找不到服務 $Name 的 CIM 物件" }
    $r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments (New-ServiceChangeArguments -BinPath $BinPath)
    if ($r.ReturnValue -ne 0) { throw "更新服務 $Name 設定失敗(Win32_Service.Change ReturnValue=$($r.ReturnValue))" }
}

function Register-AdAgentService {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Mode, [Parameter(Mandatory = $true)][string]$Exe, [Parameter(Mandatory = $true)][string]$Config, [Parameter(Mandatory = $true)][string]$Display, [Parameter(Mandatory = $true)][string]$Description)
    $bin = New-ServiceBinaryPath -Exe $Exe -Mode $Mode -Config $Config
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        Set-ExistingServiceConfig -Name $Name -BinPath $bin
    } else {
        New-Service -Name $Name -BinaryPathName $bin -DisplayName $Display -Description $Description -StartupType Automatic | Out-Null
    }
    # 失敗復原:10 / 30 / 60 秒、1 天後重設;非當機的失敗結束也套用(AD3 防護 1)
    Invoke-ScExe @('failure', $Name, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000')
    Invoke-ScExe @('failureflag', $Name, '1')
    Invoke-ScExe @('sdset', $Name, $ServiceSddl)
}

function Stop-AdAgentForUpgrade {
    foreach ($s in Get-PauseSteps) {
        if (Get-Service -Name $s.Service -ErrorAction SilentlyContinue) { Invoke-ServiceStep $s }
    }
}

# 發佈資料夾的 SHA256SUMS.txt 在 exe 所在資料夾或上一層(build-release.ps1 放在上一層);都沒有時回 $null(資安審查 L-3)
function Find-ReleaseSums {
    param([Parameter(Mandatory = $true)][string]$Dir)
    foreach ($d in @($Dir, (Split-Path -Parent $Dir))) {
        if ($d -and (Test-Path -LiteralPath (Join-Path $d 'SHA256SUMS.txt') -PathType Leaf)) { return (Join-Path $d 'SHA256SUMS.txt') }
    }
    return $null
}

function Install-NetOpsAdAgent {
    Assert-Administrator
    $src = Join-Path $SourceDir $ExeName
    Test-FileSha256 -Path $src -Expected $ExpectedSha256 | Out-Null
    $sums = Find-ReleaseSums -Dir $SourceDir
    if ($sums -and (Test-ReleaseSums -SumsPath $sums -FileName $ExeName -Expected $ExpectedSha256)) {
        Write-Host "SHA256SUMS.txt 一致($sums)"
    } else {
        Write-Warning '找不到 SHA256SUMS.txt,只核對 -ExpectedSha256'
    }

    foreach ($d in @($InstallDir, $DataDir)) { Assert-TrustedTree $d }
    foreach ($d in @($InstallDir, $DataDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-PrivateAcl $d }
    foreach ($d in @('secrets', 'state', 'logs')) { New-Item -ItemType Directory -Force -Path (Join-Path $DataDir $d) | Out-Null }

    # 先複製到只有 SYSTEM / Administrators 可存取的暫存目錄,驗證與執行都用暫存檔(資安審查 M-2:來源資料夾可能被他人改寫)
    $staging = Join-Path $InstallDir 'staging'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging | Out-Null
    $staged = Join-Path $staging $ExeName
    try {
        Copy-Item -LiteralPath $src -Destination $staged -Force
        $hash = Test-FileSha256 -Path $staged -Expected $ExpectedSha256
        $version = (& $staged --version).Trim()
        Write-Host "執行檔驗證通過:$ExeName $version(SHA-256 $hash)" -ForegroundColor Green
        Install-FromStaged -Staged $staged -Hash $hash
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }
}

function Install-FromStaged {
    param([Parameter(Mandatory = $true)][string]$Staged, [Parameter(Mandatory = $true)][string]$Hash)

    $tokenFile = Join-Path $DataDir 'secrets\ad_agent.token'
    if ($ReplaceToken -or -not (Test-Path -LiteralPath $tokenFile)) {
        $token = Read-AgentToken -ForComputer $Computer
        Write-Utf8NoBom -Path $tokenFile -Text $token
        Remove-Variable token
        Write-Host 'Token 已寫入 secrets\ad_agent.token(只有 SYSTEM 與 Administrators 可讀)'
    }

    $config = Join-Path $DataDir 'agent.toml'
    if ($RewriteConfig -or -not (Test-Path -LiteralPath $config)) {
        if (-not $ServerUrl) { throw '第一次安裝(或 -RewriteConfig)需要 -ServerUrl,例:http://10.10.130.124:51295' }
        if (-not $Domain) { $Domain = (Get-CimInstance Win32_ComputerSystem).Domain }
        Write-Utf8NoBom -Path $config -Text (New-AgentConfigText -Url $ServerUrl -ComputerName $Computer -DomainName $Domain -Include4624 $IncludeUserLogon4624.IsPresent)
        Write-Host "已寫入 $config"
    }
    $check = & $Staged --check-config --config $config 2>&1
    if ($LASTEXITCODE -ne 0) { throw "設定檢查失敗:$check" }
    Write-Host $check

    $wasInstalled = [bool](Get-Service -Name $AgentService -ErrorAction SilentlyContinue)
    $dst = Join-Path $InstallDir $ExeName
    try {
        Stop-AdAgentForUpgrade
        Copy-Item -LiteralPath $Staged -Destination $dst -Force
        Test-FileSha256 -Path $dst -Expected $Hash | Out-Null
    } catch {
        # 停服務或換檔失敗:雜湊不符的檔案不留在服務路徑上(資安審查 M-2);舊版還在就恢復監控(審查 L13)
        $err = $_
        if (Test-Path -LiteralPath $dst) {
            $now = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
            $recorded = Join-Path $DataDir 'installed.sha256'
            $old = if (Test-Path -LiteralPath $recorded) { (Get-Content -LiteralPath $recorded -TotalCount 1).Trim() } else { '' }
            if ($now -ne $Hash -and $now -ne $old) { Remove-Item -LiteralPath $dst -Force }
        }
        if ($wasInstalled -and (Test-Path -LiteralPath $dst)) {
            try { Resume-NetOpsAdAgent } catch { Write-Warning "恢復舊版失敗:$_" }
        }
        throw $err
    }
    Write-Utf8NoBom -Path (Join-Path $DataDir 'installed.sha256') -Text $Hash

    Register-AdAgentService -Name $AgentService -Mode 'agent' -Exe $dst -Config $config -Display 'NetOps AD Agent' -Description 'GigaNexus NetOps:讀取 AD Event Log 並送到 netops-ad-receiver(AD-2)'
    Register-AdAgentService -Name $WatchdogService -Mode 'watchdog' -Exe $dst -Config $config -Display 'NetOps AD Watchdog' -Description 'GigaNexus NetOps:看守 NetOpsAdAgent(停止回應時重啟並上報)'
    Resume-NetOpsAdAgent
    Get-Service $AgentService, $WatchdogService | Format-Table Name, Status, StartType -AutoSize
    Write-Host "日誌:$DataDir\logs\agent.log、watchdog.log"
}

# 被測試腳本以 AST 載入函式時不執行主程式
if ($MyInvocation.InvocationName -ne '.') {
    switch ($PSCmdlet.ParameterSetName) {
        'Pause' { Assert-Administrator; Suspend-NetOpsAdAgent }
        'Resume' { Assert-Administrator; Resume-NetOpsAdAgent }
        default { Install-NetOpsAdAgent }
    }
}
