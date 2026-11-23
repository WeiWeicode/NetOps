<#
.SYNOPSIS
  建置 netops-ad-agent 發佈資料夾(AD-2;CI job build:ad-agent 與開發機共用)。

.DESCRIPTION
  1. cargo clippy --all-targets --locked -- -D warnings
  2. cargo test --locked
  3. 安裝腳本單元測試(scripts\tests\Test-AgentScripts.ps1)
  4. cargo build --release --locked;確認 --version 與 Cargo.toml 版本相同
  5. 輸出到 -OutDir:
        netops-ad-agent-<版本>\netops-ad-agent.exe
        netops-ad-agent-<版本>\Install-NetOpsAdAgent.ps1、Uninstall-NetOpsAdAgent.ps1、agent.toml.example
        SHA256SUMS.txt(`<雜湊>  <相對路徑>`,LF)、RELEASE-INFO.txt(commit、版本、建置時間、pipeline)
  執行檔**未簽章**:是否沿用 RustIt S1 簽章流程由需求方決定(AD-2 回報);安裝腳本以 -ExpectedSha256 驗證雜湊(M6)。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ad-agent\scripts\build-release.ps1 -OutDir release-out
#>
param([string]$OutDir = 'release-out')
$ErrorActionPreference = 'Stop'
$out = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path (Get-Location) $OutDir }
$crate = Split-Path -Parent $PSScriptRoot   # ad-agent\
Set-Location $crate

function Invoke-Cargo {
    param([Parameter(Mandatory = $true)][string[]]$CargoArgs)
    Write-Host "cargo $($CargoArgs -join ' ')"
    & cargo @CargoArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "cargo $($CargoArgs -join ' ') 失敗($LASTEXITCODE)" }
}

$m = Select-String -Path 'Cargo.toml' -Pattern '^version = "(.+)"' | Select-Object -First 1
if (-not $m) { throw '讀不到 Cargo.toml 的版本' }
$version = $m.Matches[0].Groups[1].Value
if ($version -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,4}$') { throw "版本格式不合法:$version" }
# tag netops-ad-v<版本> 要和 Cargo.toml 一致
if ($env:CI_COMMIT_TAG -and $env:CI_COMMIT_TAG -ne "netops-ad-v$version") { throw "tag $($env:CI_COMMIT_TAG) 與版本 $version 不一致(應為 netops-ad-v$version)" }
if ((Test-Path $out) -and (Get-ChildItem $out -Force | Select-Object -First 1)) { throw "輸出目錄不是空的:$out" }

Invoke-Cargo @('clippy', '--all-targets', '--locked', '--', '-D', 'warnings')
Invoke-Cargo @('test', '--locked')
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'tests\Test-AgentScripts.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) { throw '安裝腳本單元測試失敗' }
Invoke-Cargo @('build', '--release', '--locked')

$exe = Join-Path $crate 'target\release\netops-ad-agent.exe'
$v = (& $exe --version).Trim()
if ($v -ne $version) { throw "執行檔版本 $v 與 Cargo.toml $version 不符" }

$pkg = "netops-ad-agent-$version"
$dir = Join-Path $out $pkg
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item $exe, 'scripts\Install-NetOpsAdAgent.ps1', 'scripts\Uninstall-NetOpsAdAgent.ps1', 'agent.toml.example' -Destination $dir

$lines = Get-ChildItem $dir -File | Sort-Object Name | ForEach-Object {
    "{0}  {1}/{2}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $pkg, $_.Name
}
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
$commit = if ($env:CI_COMMIT_SHA) { $env:CI_COMMIT_SHA } else { (& git rev-parse HEAD).Trim() }
$info = @(
    "netops-ad-agent $version"
    "commit $commit"
    "built $((Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'))"
    "pipeline $($env:CI_PIPELINE_URL)"
    "size $((Get-Item $exe).Length) bytes"
    'unsigned(簽章流程待需求方決定;安裝時以 -ExpectedSha256 驗證)'
) -join "`n"
[IO.File]::WriteAllText((Join-Path $out 'RELEASE-INFO.txt'), $info + "`n", (New-Object Text.UTF8Encoding $false))

Write-Host ''
Write-Host "輸出:$out"
Get-Content (Join-Path $out 'SHA256SUMS.txt') | Out-Host
$exeHash = (Get-FileHash (Join-Path $dir 'netops-ad-agent.exe') -Algorithm SHA256).Hash
Write-Host "安裝指令的 -ExpectedSha256:$exeHash" -ForegroundColor Green
