#!/usr/bin/env bash
# Start mediamtx with the repo-local config (custom HLS port to avoid conflicts).
# Logs to logs/mac/mediamtx.log. PID kept in /tmp/datacaster_mediamtx_pid.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO_ROOT/scripts/mediamtx.yml"
LOG_FILE="$REPO_ROOT/logs/mac/mediamtx.log"
mkdir -p "$REPO_ROOT/logs/mac"

if lsof -nP -iTCP:1935 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "mediamtx (or another RTMP server) already on :1935 — skipping start"
  exit 0
fi

mediamtx "$CONFIG" > "$LOG_FILE" 2>&1 &
echo $! > /tmp/datacaster_mediamtx_pid
sleep 1

if ! lsof -nP -iTCP:1935 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: mediamtx failed to bind :1935. Check $LOG_FILE:" >&2
  tail -10 "$LOG_FILE" >&2
  exit 1
fi

echo "mediamtx started, pid $(cat /tmp/datacaster_mediamtx_pid)"
echo "logs: tail -f $LOG_FILE"
