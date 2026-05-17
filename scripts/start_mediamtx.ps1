# Start mediamtx with the repo-local config (custom HLS port to avoid conflicts).
# Logs to logs\windows\mediamtx.log. PID kept in $env:TEMP\datacaster_mediamtx_pid.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start_mediamtx.ps1

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$LogDir = Join-Path $RepoRoot 'logs\windows'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$Config = Join-Path $PSScriptRoot 'mediamtx.yml'
$LogFile = Join-Path $LogDir 'mediamtx.log'
$PidFile = Join-Path $env:TEMP 'datacaster_mediamtx_pid'

function Test-PortInUse($port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        return $null -ne $conn
    } catch {
        return $false
    }
}

if (Test-PortInUse 1935) {
    Write-Host "mediamtx (or another RTMP server) already on :1935 - skipping start"
    exit 0
}

# Locate mediamtx.exe — must be on PATH, or alongside this script.
$mediamtxCmd = Get-Command mediamtx.exe -ErrorAction SilentlyContinue
if (-not $mediamtxCmd) {
    $local = Join-Path $PSScriptRoot 'mediamtx.exe'
    if (Test-Path $local) { $mediamtxCmd = @{ Source = $local } }
}
if (-not $mediamtxCmd) {
    Write-Error "ERROR: mediamtx.exe not found on PATH or in $PSScriptRoot. Download from https://github.com/bluenviron/mediamtx/releases"
    exit 1
}

$proc = Start-Process -FilePath $mediamtxCmd.Source `
    -ArgumentList "`"$Config`"" `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError (Join-Path $LogDir 'mediamtx.err.log') `
    -WindowStyle Hidden -PassThru

$proc.Id | Out-File -FilePath $PidFile -Encoding ascii
Start-Sleep -Seconds 1

if (-not (Test-PortInUse 1935)) {
    Write-Error "ERROR: mediamtx failed to bind :1935. Check $LogFile"
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 10 | Write-Host }
    exit 1
}

Write-Host "mediamtx started, pid $($proc.Id)"
Write-Host "logs: Get-Content -Wait $LogFile"
