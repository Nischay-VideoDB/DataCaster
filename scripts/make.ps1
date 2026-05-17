# Windows port of Makefile - mirrors every target from /Makefile.
# Invoked through make.cmd so users can type `make up`, `make down`, etc.
#
# Usage:
#   make.cmd <target>
#   powershell -ExecutionPolicy Bypass -File scripts\make.ps1 <target>

param(
    [Parameter(Position=0)] [string] $Target = 'help'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments)] $Args)
    Push-Location $RepoRoot
    try {
        & docker compose @Args
        if ($LASTEXITCODE -ne 0) { throw "docker compose exited with $LASTEXITCODE" }
    } finally { Pop-Location }
}

function Show-Help {
    @"
DataCaster - make targets (Windows)

  help              show this help
  datacaster        build + start + open browser (one-shot)
  build             docker compose build (both services)
  up                start both services in the background
  down              stop both services
  restart           stop + start
  rebuild           rebuild from scratch (no cache) and start
  logs              tail logs from both services
  logs-backend      tail backend logs only
  logs-frontend     tail frontend logs only
  ps                show service status
  status            alias for ps
  health            hit /api/health and pretty-print
  shell-backend     open a shell inside the backend container
  shell-frontend    open a shell inside the frontend container
  clean             stop services and remove built images
  nuke              clean + drop volumes + prune dangling images
  dev-backend       run uvicorn locally with reload (uses .venv)
  dev-frontend      run Vite locally (HMR)
  smoke             verify both services answer
  open              open the frontend in the default browser

Frontend -> http://localhost:3000   Backend -> http://localhost:8000
"@ | Write-Host
}

function Open-Frontend {
    Start-Process 'http://localhost:3000'
}

function Invoke-Smoke {
    function Hit($label, $url) {
        Write-Host -NoNewline "$label "
        try {
            $r = Invoke-WebRequest -Uri $url -Method GET -UseBasicParsing -TimeoutSec 5
            Write-Host $r.StatusCode
        } catch {
            if ($_.Exception.Response) {
                Write-Host ([int]$_.Exception.Response.StatusCode)
            } else {
                Write-Host "down"
            }
        }
    }
    Hit "frontend (:3000)  ->" "http://localhost:3000/"
    Hit "backend  (:8000)  ->" "http://localhost:8000/api/health"
    Hit "proxy    (:3000/api/health) ->" "http://localhost:3000/api/health"
}

switch ($Target.ToLower()) {
    'help'           { Show-Help }
    'datacaster'     {
        Invoke-Compose build
        Invoke-Compose up -d
        Write-Host ""
        Write-Host "ready  ->  http://localhost:3000  (frontend)"
        Write-Host "       ->  http://localhost:8000  (backend api)"
        Open-Frontend
    }
    'build'          { Invoke-Compose build }
    'up'             {
        Invoke-Compose up -d
        Write-Host ""
        Write-Host "ready  ->  http://localhost:3000  (frontend)"
        Write-Host "       ->  http://localhost:8000  (backend api)"
    }
    'down'           { Invoke-Compose down }
    'restart'        { Invoke-Compose down; Invoke-Compose up -d }
    'rebuild'        {
        Invoke-Compose build --no-cache
        Invoke-Compose up -d --force-recreate
        Write-Host ""
        Write-Host "rebuilt + restarted  ->  http://localhost:3000"
    }
    'logs'           { Invoke-Compose logs -f }
    'logs-backend'   { Invoke-Compose logs -f backend }
    'logs-frontend'  { Invoke-Compose logs -f frontend }
    { $_ -in 'ps','status' } { Invoke-Compose ps }
    'health'         {
        try {
            $r = Invoke-RestMethod -Uri 'http://localhost:8000/api/health' -TimeoutSec 5
            $r | ConvertTo-Json -Depth 8
        } catch {
            Write-Host "backend not reachable on :8000"
        }
    }
    'shell-backend'  { Invoke-Compose exec backend bash }
    'shell-frontend' { Invoke-Compose exec frontend sh }
    'clean'          {
        Invoke-Compose down
        docker image rm datacaster-backend:latest datacaster-frontend:latest 2>$null
        Write-Host ""
        Write-Host "removed containers + images for project datacaster"
    }
    'nuke'           {
        Invoke-Compose down -v
        docker image prune -f
        Write-Host ""
        Write-Host "full cleanup done"
    }
    'dev-backend'    {
        $venvPython = Join-Path $RepoRoot '.venv\Scripts\python.exe'
        if (-not (Test-Path $venvPython)) {
            Write-Error "ERROR: .venv missing. Run 'python -m venv .venv ; .\.venv\Scripts\Activate.ps1 ; pip install -r requirements.txt'"
            exit 1
        }
        Push-Location $RepoRoot
        try {
            & $venvPython -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
        } finally { Pop-Location }
    }
    'dev-frontend'   {
        Push-Location (Join-Path $RepoRoot 'frontend')
        try { & npm.cmd run dev } finally { Pop-Location }
    }
    'smoke'          { Invoke-Smoke }
    'open'           { Open-Frontend }
    default          {
        Write-Host "unknown target: $Target"
        Show-Help
        exit 2
    }
}
