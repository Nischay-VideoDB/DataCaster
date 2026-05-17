# Bring up the full DataCaster stack on Windows:
#   - FastAPI (uvicorn :8000)
#   - Vite (web UI, :3000)
# The pipeline itself (rtstream + indexes) is started via POST /api/start
# from the web UI. ws_listener is spawned by the pipeline on demand.
#
# Logs land in logs\windows\:
#   logs\windows\uvicorn.log     (+ uvicorn.err.log)
#   logs\windows\vite.log        (+ vite.err.log)
#   logs\windows\ws_listener.log (written by the backend on /api/start)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start_pipeline.ps1

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot 'logs\windows'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

if (-not (Test-Path (Join-Path $RepoRoot '.venv'))) {
    Write-Error "ERROR: .venv missing. Run 'python -m venv .venv ; .\.venv\Scripts\Activate.ps1 ; pip install -r requirements.txt'"
    exit 1
}

function Test-PortInUse($port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        return $null -ne $conn
    } catch {
        return $false
    }
}

# 1. Backend
if (Test-PortInUse 8000) {
    Write-Host "uvicorn already on :8000 - skipping"
} else {
    $venvPython = Join-Path $RepoRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPython)) {
        Write-Error "ERROR: $venvPython not found. Did 'python -m venv .venv' succeed?"
        exit 1
    }
    if (-not $env:PROMPT_MODE) { $env:PROMPT_MODE = 'football' }

    $uvicornLog = Join-Path $LogDir 'uvicorn.log'
    # --reload-dir backend: scope reloader to app code, otherwise log writes trigger a 1-Hz reload storm.
    $proc = Start-Process -FilePath $venvPython `
        -ArgumentList '-m','uvicorn','backend.main:app','--host','127.0.0.1','--port','8000','--reload','--reload-dir','backend' `
        -RedirectStandardOutput $uvicornLog `
        -RedirectStandardError (Join-Path $LogDir 'uvicorn.err.log') `
        -WindowStyle Hidden -PassThru
    Write-Host "started uvicorn pid=$($proc.Id) (log: $uvicornLog)"
}

# 2. Frontend
if (Test-PortInUse 3000) {
    Write-Host "vite already on :3000 - skipping"
} else {
    $frontendDir = Join-Path $RepoRoot 'frontend'
    $viteLog = Join-Path $LogDir 'vite.log'
    # npm.cmd is the Windows shim; needed because Start-Process won't resolve plain "npm".
    $proc = Start-Process -FilePath 'npm.cmd' `
        -ArgumentList 'run','dev' `
        -WorkingDirectory $frontendDir `
        -RedirectStandardOutput $viteLog `
        -RedirectStandardError (Join-Path $LogDir 'vite.err.log') `
        -WindowStyle Hidden -PassThru
    Write-Host "started vite pid=$($proc.Id) (log: $viteLog)"
}

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "ready: http://localhost:3000"
Write-Host "  api: http://127.0.0.1:8000/api/health"
Write-Host "tail logs:  Get-Content -Wait $LogDir\uvicorn.log,$LogDir\vite.log"
Write-Host "stop all:   powershell -ExecutionPolicy Bypass -File scripts\kill_all.ps1"
