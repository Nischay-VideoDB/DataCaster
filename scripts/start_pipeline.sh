#!/usr/bin/env bash
# Bring up the full DataCaster stack:
#   - FastAPI (uvicorn :8000)
#   - Vite (web UI, :3000)
# The pipeline itself (rtstream + indexes) is started via POST /api/start
# from the web UI. ws_listener is spawned by the pipeline on demand.
#
# Logs:
#   logs/mac/uvicorn.log
#   logs/mac/vite.log
#   logs/mac/ws_listener.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d .venv ]; then
  echo "ERROR: .venv missing. Run 'python3 -m venv .venv && pip install -r requirements.txt'" >&2
  exit 1
fi

# 1. Backend
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "uvicorn already on :8000 — skipping"
else
  mkdir -p logs/mac
  source .venv/bin/activate
  PROMPT_MODE="${PROMPT_MODE:-football}" \
  uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend \
    > logs/mac/uvicorn.log 2>&1 &
  echo "started uvicorn pid=$!"
fi

# 2. Frontend
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "vite already on :3000 — skipping"
else
  mkdir -p "$REPO_ROOT/logs/mac"
  (cd "$REPO_ROOT/frontend" && npm run dev > "$REPO_ROOT/logs/mac/vite.log" 2>&1 &)
  echo "started vite (see logs/mac/vite.log)"
fi

sleep 3

echo
echo "ready: http://localhost:3000"
echo "  api: http://127.0.0.1:8000/api/health"
echo "tail logs:  tail -f logs/mac/uvicorn.log logs/mac/vite.log"
echo "stop all:   ./scripts/kill_all.sh"
