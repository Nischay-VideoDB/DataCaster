# Stop everything DataCaster spawned on Windows: ffmpeg loop, mediamtx,
# ws_listener, uvicorn, vite. Idempotent - missing pids/processes don't fail.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\kill_all.ps1

$ErrorActionPreference = 'SilentlyContinue'

function Stop-MatchingProcess {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Pattern
    )
    Get-CimInstance Win32_Process -Filter "Name LIKE '$Name%'" |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match $Pattern) } |
        ForEach-Object {
            try {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
                Write-Host "  killed $($_.Name) pid=$($_.ProcessId)"
            } catch { }
        }
}

function Stop-PidFile {
    param([Parameter(Mandatory)] [string] $Path)
    if (Test-Path $Path) {
        $procId = Get-Content $Path -ErrorAction SilentlyContinue
        if ($procId) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $Path -Force -ErrorAction SilentlyContinue
    }
}

function Stop-PortOwners {
    param([Parameter(Mandatory)] [int] $Port)
    # Kill whatever's listening on $Port — catches uvicorn.exe, python.exe -m uvicorn, etc.
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            try {
                $proc = Get-Process -Id $_ -ErrorAction Stop
                Stop-Process -Id $_ -Force -ErrorAction Stop
                Write-Host "  killed $($proc.ProcessName) pid=$_ (port $Port)"
            } catch { }
        }
}

Write-Host "stopping ffmpeg (RTMP publishers)..."
Stop-MatchingProcess -Name 'ffmpeg' -Pattern 'rtmp://localhost:1935'

Write-Host "stopping ws_listener.py..."
Stop-PidFile (Join-Path $env:TEMP 'videodb_ws_pid')
Stop-MatchingProcess -Name 'python' -Pattern 'ws_listener\.py'

Write-Host "stopping uvicorn (FastAPI)..."
Stop-MatchingProcess -Name 'python' -Pattern 'uvicorn backend\.main'
Stop-MatchingProcess -Name 'uvicorn' -Pattern '.*'   # uvicorn.exe (venv shim)
Stop-PortOwners -Port 8000                            # belt-and-suspenders

Write-Host "stopping vite..."
# Vite runs as node.exe under npm; match the script name.
Stop-MatchingProcess -Name 'node' -Pattern 'vite'
Stop-PortOwners -Port 3000

Write-Host "stopping mediamtx..."
Stop-PidFile (Join-Path $env:TEMP 'datacaster_mediamtx_pid')
Get-Process -Name 'mediamtx' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1
Write-Host "done."
exit 0
