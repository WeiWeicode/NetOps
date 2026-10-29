
#requires -Version 5.1

# ============================================================
# Windows AD Log -> CSV -> NAS FTP   (v3, based on ADLog-FtpBackup-2.ps1)
# Export previous day's events
# Retention: 30 days
# Windows PowerShell 5.1
#
# Changes from v2:
#   - Security: export only the audit events NetOps analyzes (logon failures,
#     lockouts, account / group changes). A DC writes millions of 4624 / 4634 /
#     4769 per day; exporting them all makes huge CSVs and slow runs.
#   - Security: log the log size and the oldest event. If the Security log no
#     longer covers the whole day (it wrapped), write a WARN so the empty
#     Security.csv is explained instead of silent.
#   - File names include the DC name (Security_GSMC-DC1.csv), so several DCs
#     can upload to the same date folder without overwriting each other.
#     Account lockouts (4740) are logged only on the PDC emulator, and failed
#     logons only on the DC that handled them, so run this on every DC.
#   - -Date yyyyMMdd re-exports a specific day (if the events are still in the log).
#
# Usage:
#   .\ADLog-FtpBackup-3.ps1 -SetupCredential      (once, as the scheduled-task account)
#   .\ADLog-FtpBackup-3.ps1                       (daily scheduled task: previous day)
#   .\ADLog-FtpBackup-3.ps1 -Date 20261019        (re-export one day)
# ============================================================

param(
    [switch]$SetupCredential,
    [string]$Date
)

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------
# 1. CONFIGURATION
# ------------------------------------------------------------

$FtpServer = "10.10.130.66"
$FtpPort   = 21
$FtpUser   = "benson3"
$FtpRoot   = "/AD_Log_Backup"

$LocalRoot = "C:\ADLogBackup"
$RetentionDays = 30
$FtpTimeout = 60000

$CredentialFile = Join-Path $LocalRoot "ftp-credential.xml"
$RunLog = Join-Path $LocalRoot "Backup-Execution.log"

$RequiredLogs = @(
    "Security",
    "System",
    "Directory Service"
)

$OptionalLogs = @(
    "DNS Server"
)

# Security events exported (others are skipped to keep the CSV small).
# Get-WinEvent accepts at most ~22 IDs per query, so they are queried in groups.
$SecurityEventIds = @(
    4625,  # logon failed
    4771,  # Kerberos pre-authentication failed (wrong password)
    4740,  # account locked out (PDC emulator only)
    4767,  # account unlocked
    4720,  # user account created
    4722,  # account enabled
    4725,  # account disabled
    4726,  # account deleted
    4724,  # password reset
    4738,  # account changed
    4781,  # account renamed
    4728, 4729,  # member added / removed: global security group
    4732, 4733,  # member added / removed: local (builtin) security group
    4756, 4757,  # member added / removed: universal security group
    4727, 4731, 4754,  # security group created
    4704,  # user right assigned
    4794,  # DSRM administrator password set
    1102   # audit log cleared
)

# Add the DC name to the CSV file names (Security_GSMC-DC1.csv).
$IncludeComputerName = $true

# ------------------------------------------------------------
# 2. CREATE LOCAL DIRECTORY
# ------------------------------------------------------------

New-Item -Path $LocalRoot -ItemType Directory -Force |
    Out-Null

function Write-RunLog {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )

    $Line = "{0} [{1}] {2}" -f `
        (Get-Date -Format "yyyy-MM-dd HH:mm:ss"),
        $Level,
        $Message

    Add-Content -LiteralPath $RunLog `
        -Value $Line -Encoding UTF8

    Write-Host $Line
}

# ------------------------------------------------------------
# 3. FTP CREDENTIAL INITIALIZATION
# Usage:
# .\ADLog-FtpBackup-3.ps1 -SetupCredential
# ------------------------------------------------------------

if ($SetupCredential) {
    $Credential = Get-Credential `
        -UserName $FtpUser `
        -Message "Enter NAS FTP password"

    if (-not $Credential) {
        Write-RunLog "Credential setup cancelled." "ERROR"
        exit 1
    }

    $Credential |
        Export-Clixml -LiteralPath $CredentialFile

    Write-RunLog "FTP credential saved: $CredentialFile"
    Write-RunLog "Use the same Windows account for scheduled execution."
    exit 0
}

if (-not (Test-Path -LiteralPath $CredentialFile)) {
    Write-RunLog "FTP credential file missing." "ERROR"
    Write-RunLog "Run with -SetupCredential first." "ERROR"
    exit 1
}

try {
    $Credential = Import-Clixml -LiteralPath $CredentialFile

    if ($Credential -isnot [System.Management.Automation.PSCredential]) {
        throw "Invalid credential file format."
    }

    $NetworkCredential = $Credential.GetNetworkCredential()
}
catch {
    Write-RunLog "Cannot load FTP credential: $($_.Exception.Message)" "ERROR"
    exit 1
}

# ------------------------------------------------------------
# 4. FTP REQUEST FUNCTION
# ------------------------------------------------------------

$FtpBase = "ftp://${FtpServer}:$FtpPort"

function New-FtpRequest {
    param(
        [string]$Url,
        [string]$Method
    )

    $Request = [System.Net.FtpWebRequest]::Create($Url)
    $Request.Method = $Method
    $Request.Credentials = $NetworkCredential
    $Request.UseBinary = $true
    $Request.UsePassive = $true
    $Request.KeepAlive = $false
    $Request.Timeout = $FtpTimeout
    $Request.ReadWriteTimeout = $FtpTimeout

    return $Request
}

function Get-FtpNames {
    param([string]$Url)

    $Request = New-FtpRequest `
        -Url $Url `
        -Method ([System.Net.WebRequestMethods+Ftp]::ListDirectory)

    $Response = $Request.GetResponse()

    try {
        $Reader = New-Object System.IO.StreamReader(
            $Response.GetResponseStream()
        )

        try {
            $Names = @()

            while (-not $Reader.EndOfStream) {
                $Name = $Reader.ReadLine()

                if ($Name -and $Name -ne "." -and $Name -ne "..") {
                    $Names += $Name
                }
            }

            return $Names
        }
        finally {
            $Reader.Close()
        }
    }
    finally {
        $Response.Close()
    }
}

function Ensure-FtpDirectory {
    param([string]$Url)

    try {
        $Request = New-FtpRequest `
            -Url $Url `
            -Method ([System.Net.WebRequestMethods+Ftp]::MakeDirectory)

        $Response = $Request.GetResponse()
        $Response.Close()

        Write-RunLog "Created FTP directory: $Url"
    }
    catch {
        # Verify the directory exists before treating the error
        # as an already-existing directory.
        $ParentUrl = $Url.Substring(0, $Url.LastIndexOf("/"))
        $DirectoryName = $Url.Substring($Url.LastIndexOf("/") + 1)

        $Names = @(Get-FtpNames -Url $ParentUrl)

        if ($Names -notcontains $DirectoryName) {
            throw "Cannot create or verify FTP directory: $Url. $($_.Exception.Message)"
        }
    }
}

function Upload-AndVerify {
    param(
        [System.IO.FileInfo]$File,
        [string]$RemoteUrl
    )

    # Upload file
    $Request = New-FtpRequest `
        -Url $RemoteUrl `
        -Method ([System.Net.WebRequestMethods+Ftp]::UploadFile)

    $Request.ContentLength = $File.Length

    $InputStream = [System.IO.File]::OpenRead($File.FullName)

    try {
        $OutputStream = $Request.GetRequestStream()

        try {
            $InputStream.CopyTo($OutputStream)
        }
        finally {
            $OutputStream.Close()
        }
    }
    finally {
        $InputStream.Close()
    }

    $Response = $Request.GetResponse()
    $Response.Close()

    # Verify remote file size
    $VerifyRequest = New-FtpRequest `
        -Url $RemoteUrl `
        -Method ([System.Net.WebRequestMethods+Ftp]::GetFileSize)

    $VerifyResponse = $VerifyRequest.GetResponse()

    try {
        $RemoteSize = $VerifyResponse.ContentLength
    }
    finally {
        $VerifyResponse.Close()
    }

    if ($RemoteSize -ne $File.Length) {
        throw "Size mismatch: $($File.Name), local=$($File.Length), remote=$RemoteSize"
    }

    Write-RunLog "UPLOAD VERIFIED: $($File.Name), bytes=$RemoteSize"
}

# ------------------------------------------------------------
# 5. RETENTION CLEANUP
# Only dated folders matching yyyyMMdd are processed.
# ------------------------------------------------------------

function Remove-ExpiredBackup {
    param(
        [string]$RemoteRootUrl,
        [datetime]$CutoffDate
    )

    $Names = @(Get-FtpNames -Url $RemoteRootUrl)

    foreach ($Name in $Names) {

        if ($Name -notmatch '^\d{8}$') {
            continue
        }

        $FolderDate = [datetime]::MinValue

        $ValidDate = [datetime]::TryParseExact(
            $Name,
            "yyyyMMdd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$FolderDate
        )

        if (-not $ValidDate -or $FolderDate -ge $CutoffDate) {
            continue
        }

        $OldFolderUrl = "$RemoteRootUrl/$Name"

        Write-RunLog "Expired backup found: $Name"

        $OldFiles = @(Get-FtpNames -Url $OldFolderUrl)

        foreach ($OldFile in $OldFiles) {

            if ($OldFile.Contains("/") -or $OldFile.Contains("\")) {
                throw "Unexpected nested content in $Name. Refusing deletion."
            }

            $OldFileUrl = "$OldFolderUrl/$OldFile"

            $DeleteRequest = New-FtpRequest `
                -Url $OldFileUrl `
                -Method ([System.Net.WebRequestMethods+Ftp]::DeleteFile)

            $DeleteResponse = $DeleteRequest.GetResponse()
            $DeleteResponse.Close()

            Write-RunLog "Deleted expired file: $Name/$OldFile"
        }

        $RemoveRequest = New-FtpRequest `
            -Url $OldFolderUrl `
            -Method ([System.Net.WebRequestMethods+Ftp]::RemoveDirectory)

        $RemoveResponse = $RemoveRequest.GetResponse()
        $RemoveResponse.Close()

        Write-RunLog "Deleted expired folder: $Name"
    }
}

# ------------------------------------------------------------
# 6. TIME WINDOW
# Previous day (or -Date yyyyMMdd), local Windows Server time
# Start inclusive, end exclusive
# ------------------------------------------------------------

$Today = (Get-Date).Date

if ($Date) {
    $Parsed = [datetime]::MinValue

    if (-not [datetime]::TryParseExact(
            $Date,
            "yyyyMMdd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$Parsed)) {
        Write-RunLog "Invalid -Date '$Date'. Use yyyyMMdd." "ERROR"
        exit 1
    }

    $StartTime = $Parsed
}
else {
    $StartTime = $Today.AddDays(-1)
}

$EndTime = $StartTime.AddDays(1)

$BackupDate = $StartTime.ToString("yyyyMMdd")

$LocalBackup = Join-Path $LocalRoot $BackupDate
$RemoteBackup = "$FtpRoot/$BackupDate"

$RemoteBackupUrl = "$FtpBase$RemoteBackup"
$RemoteRootUrl = "$FtpBase$FtpRoot"

Write-RunLog "=========================================="
Write-RunLog "Backup date: $BackupDate ($env:COMPUTERNAME)"
Write-RunLog "Start time: $StartTime"
Write-RunLog "End time (exclusive): $EndTime"

# ------------------------------------------------------------
# 7. EVENT QUERY
# ------------------------------------------------------------

function Get-DayEvents {
    param(
        [string]$LogName,
        [int[]]$Ids
    )

    $Filters = @()

    if ($Ids -and $Ids.Count -gt 0) {
        for ($i = 0; $i -lt $Ids.Count; $i += 20) {
            $Last = [Math]::Min($i + 19, $Ids.Count - 1)

            $Filters += @{
                LogName   = $LogName
                Id        = $Ids[$i..$Last]
                StartTime = $StartTime
                EndTime   = $EndTime
            }
        }
    }
    else {
        $Filters += @{
            LogName   = $LogName
            StartTime = $StartTime
            EndTime   = $EndTime
        }
    }

    $Result = @()

    foreach ($Filter in $Filters) {
        try {
            $Result += @(
                Get-WinEvent -FilterHashtable $Filter -ErrorAction Stop |
                Where-Object {
                    $_.TimeCreated -ge $StartTime -and
                    $_.TimeCreated -lt $EndTime
                }
            )
        }
        catch {
            if ($_.FullyQualifiedErrorId -notlike "*NoMatchingEventsFound*") {
                throw
            }
        }
    }

    return @($Result | Sort-Object TimeCreated -Descending)
}

# Security log health: size, record count, oldest event.
# If the oldest event is later than the start of the day, the log wrapped and
# the day's Security events are (partly) gone. Increase the Security log size
# (GPO: Event Log > Maximum security log size, e.g. 4 GB) or run more often.
function Test-SecurityCoverage {
    try {
        $Info = Get-WinEvent -ListLog "Security" -ErrorAction Stop
        $Oldest = Get-WinEvent -LogName "Security" -MaxEvents 1 -Oldest -ErrorAction Stop

        Write-RunLog ("Security log: mode={0}, size={1:N0} MB / max {2:N0} MB, records={3:N0}, oldest={4}" -f `
            $Info.LogMode,
            ($Info.FileSize / 1MB),
            ($Info.MaximumSizeInBytes / 1MB),
            $Info.RecordCount,
            $Oldest.TimeCreated)

        if ($Oldest.TimeCreated -gt $StartTime) {
            $Warn = "Security log does not cover the whole day: oldest event is {0}, day starts {1}. " +
                "Events before the oldest one were overwritten. Increase the Security log maximum size."
            Write-RunLog ($Warn -f $Oldest.TimeCreated, $StartTime) "WARN"
        }
    }
    catch {
        Write-RunLog "Cannot read Security log information: $($_.Exception.Message)" "WARN"
    }
}

# ------------------------------------------------------------
# 8. EXPORT LOGS
# ------------------------------------------------------------

$ExportErrors = 0
$Suffix = if ($IncludeComputerName) { "_$env:COMPUTERNAME" } else { "" }

try {
    New-Item -Path $LocalBackup -ItemType Directory -Force |
        Out-Null

    $LogsToExport = @($RequiredLogs)

    foreach ($OptionalLog in $OptionalLogs) {
        try {
            Get-WinEvent -ListLog $OptionalLog -ErrorAction Stop |
                Out-Null

            $LogsToExport += $OptionalLog
        }
        catch {
            Write-RunLog "Optional log unavailable: $OptionalLog" "WARN"
        }
    }

    Test-SecurityCoverage

    foreach ($LogName in $LogsToExport) {

        $SafeName = $LogName -replace '[\\/:*?"<>| ]', '_'
        $CsvPath = Join-Path $LocalBackup "$SafeName$Suffix.csv"

        try {
            Get-WinEvent -ListLog $LogName -ErrorAction Stop |
                Out-Null

            $Ids = if ($LogName -eq "Security") { $SecurityEventIds } else { @() }
            $Events = @(Get-DayEvents -LogName $LogName -Ids $Ids)

            if ($Events.Count -gt 0) {

                $Events |
                    Select-Object `
                        @{Name="TimeCreated"; Expression={
                            if ($_.TimeCreated) {
                                $_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")
                            }
                        }},
                        @{Name="EventID"; Expression={$_.Id}},
                        @{Name="Level"; Expression={$_.LevelDisplayName}},
                        @{Name="Provider"; Expression={$_.ProviderName}},
                        @{Name="Computer"; Expression={$_.MachineName}},
                        @{Name="RecordID"; Expression={$_.RecordId}},
                        @{Name="Message"; Expression={$_.Message}} |
                    Export-Csv -LiteralPath $CsvPath `
                        -NoTypeInformation -Encoding UTF8
            }
            else {
                # Header-only CSV if there were no events
                $Header = [pscustomobject]@{
                    TimeCreated = ""
                    EventID     = ""
                    Level       = ""
                    Provider    = ""
                    Computer    = ""
                    RecordID    = ""
                    Message     = ""
                }

                $Header |
                    ConvertTo-Csv -NoTypeInformation |
                    Select-Object -First 1 |
                    Set-Content -LiteralPath $CsvPath -Encoding UTF8
            }

            if (-not (Test-Path -LiteralPath $CsvPath)) {
                throw "CSV file was not created."
            }

            Write-RunLog "EXPORT OK: $LogName; events=$($Events.Count)"
        }
        catch {
            $ExportErrors++
            Write-RunLog "EXPORT FAILED: $LogName - $($_.Exception.Message)" "ERROR"
        }
    }

    if ($ExportErrors -gt 0) {
        throw "$ExportErrors log export(s) failed. Upload and cleanup cancelled."
    }

    # --------------------------------------------------------
    # 9. CREATE DAILY FTP DIRECTORY
    # --------------------------------------------------------

    Ensure-FtpDirectory -Url $RemoteBackupUrl

    # --------------------------------------------------------
    # 10. UPLOAD CSV AND VERIFY SIZE
    # --------------------------------------------------------

    $Files = @(Get-ChildItem -LiteralPath $LocalBackup -Filter "*$Suffix.csv" -File)

    if ($Files.Count -eq 0) {
        throw "No CSV files generated."
    }

    foreach ($File in $Files) {
        $RemoteUrl = "$RemoteBackupUrl/$($File.Name)"

        Upload-AndVerify -File $File -RemoteUrl $RemoteUrl
    }

    Write-RunLog "ALL CSV FILES UPLOADED AND VERIFIED."

    # --------------------------------------------------------
    # 11. KEEP ONLY THE LATEST 30 CALENDAR DATES
    # --------------------------------------------------------

    # Keep folders dated today-29 through today.
    $CutoffDate = $Today.AddDays(-($RetentionDays - 1))

    Remove-ExpiredBackup `
        -RemoteRootUrl $RemoteRootUrl `
        -CutoffDate $CutoffDate

    Write-RunLog "RETENTION CLEANUP COMPLETE: $RetentionDays days"
    Write-RunLog "BACKUP SUCCESS: $BackupDate"

    exit 0
}
catch {
    Write-RunLog "BACKUP FAILED: $($_.Exception.Message)" "ERROR"
    exit 1
}
