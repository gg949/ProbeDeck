#Requires -Version 5.1
<#
.SYNOPSIS
    卸载 CF-Server-Monitor Windows PowerShell 探针。
.EXAMPLE
    .\uninstall.ps1
.EXAMPLE
    .\uninstall.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$TaskName = 'CFProbe'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Info([string]$Message) { Write-Host "[+] $Message" -ForegroundColor Green }
function Write-WarningText([string]$Message) { Write-Host "[!] $Message" -ForegroundColor Yellow }

function Get-AgentScriptFromTask {
    param($ScheduledTask)

    foreach ($action in @($ScheduledTask.Actions)) {
        $arguments = [string]$action.Arguments
        if ($arguments -match '(?i)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S*cf-server-monitor\.ps1))') {
            foreach ($match in $Matches[1..3]) {
                if (-not [string]::IsNullOrWhiteSpace($match) -and
                    (Split-Path -Leaf $match) -ieq 'cf-server-monitor.ps1') {
                    return $match
                }
            }
        }
    }
    return $null
}

if (-not (Test-Administrator)) {
    Write-WarningText 'Administrator rights are required; requesting elevation...'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($Force) { $arguments += ' -Force' }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
    exit 0
}

if (-not $Force) {
    $answer = Read-Host 'Remove the CFProbe scheduled task and stop probe processes? [y/N]'
    if ($answer -notmatch '(?i)^(y|yes)$') {
        Write-Info 'Cancelled.'
        exit 0
    }
}

# This task name is registered by cf-server-monitor.ps1 Install-Service.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$AgentScript = if ($task) { Get-AgentScriptFromTask -ScheduledTask $task } else { $null }
if (-not $AgentScript) {
    # Fallback for an installer and uninstaller placed in the same directory.
    $AgentScript = Join-Path (Split-Path -Parent $PSCommandPath) 'cf-server-monitor.ps1'
}
$ScriptDir = Split-Path -Parent $AgentScript
$DataFiles = @(
    (Join-Path $ScriptDir 'cf_probe_config.json'),
    (Join-Path $ScriptDir 'cf_probe_traffic.dat'),
    (Join-Path $ScriptDir 'cf_probe.log'),
    (Join-Path $ScriptDir 'auto_update.lock')
)

if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Info "Removed scheduled task: $TaskName"
} else {
    Write-Info "Scheduled task not found: $TaskName"
}

# Stop probe and pending auto-update runner processes before their files are removed.
$stopped = 0
try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
            $_.Name -in @('powershell.exe', 'pwsh.exe') -and
            (
                ($_.CommandLine -match '(?i)cf-server-monitor\.ps1' -and
                 $_.CommandLine -match '(?i)(\srun\b|\stray\b)') -or
                $_.CommandLine -match '(?i)cf-probe-auto-update-runner-[a-f0-9]+\.ps1'
            )
        }
    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped++
    }
} catch {
    Write-WarningText "Unable to enumerate probe processes: $($_.Exception.Message)"
}
Write-Info "Stopped probe processes: $stopped"

foreach ($file in $DataFiles + $AgentScript) {
    if (Test-Path -LiteralPath $file) {
        Remove-Item -LiteralPath $file -Force
        Write-Info "Removed: $file"
    }
}

# Auto-update runners normally self-delete. Remove any interrupted runner/download files too.
foreach ($directory in @($env:TEMP, $env:TMP, $ScriptDir) | Select-Object -Unique) {
    if (Test-Path -LiteralPath $directory) {
        Get-ChildItem -LiteralPath $directory -Filter 'cf-probe-auto-update-*.ps1' -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $directory -Filter 'cf-probe-auto-update-runner-*.ps1' -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

Write-Host 'CF-Server-Monitor Windows probe has been completely removed.' -ForegroundColor Green
