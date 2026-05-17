#!/usr/bin/env bash
# Stop everything DataCaster spawned: ffmpeg loop, mediamtx, ws_listener,
# uvicorn, vite. Idempotent — missing pids/processes don't fail the script.

set +e

echo "stopping ffmpeg (RTMP publishers)..."
pkill -f "ffmpeg.*rtmp://localhost:1935" 2>/dev/null

echo "stopping ws_listener.py..."
if [ -f /tmp/videodb_ws_pid ]; then
  kill "$(cat /tmp/videodb_ws_pid)" 2>/dev/null
  rm -f /tmp/videodb_ws_pid
fi
pkill -f "ws_listener.py" 2>/dev/null

echo "stopping uvicorn (FastAPI)..."
pkill -f "uvicorn backend.main" 2>/dev/null

echo "stopping vite..."
pkill -f "vite" 2>/dev/null

echo "stopping mediamtx..."
if [ -f /tmp/datacaster_mediamtx_pid ]; then
  kill "$(cat /tmp/datacaster_mediamtx_pid)" 2>/dev/null
  rm -f /tmp/datacaster_mediamtx_pid
fi
pkill -x mediamtx 2>/dev/null

# brief settle
sleep 1
echo "done."
exit 0
