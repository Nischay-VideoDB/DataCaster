#!/usr/bin/env bash
# Loop a local match.mp4 into mediamtx as RTMP, suitable for VideoDB's
# coll.connect_rtstream(url="rtmp://localhost:1935/live/match", ...)
#
# Usage:
#   scripts/stream_match.sh                # uses ~/Movies/match.mp4
#   scripts/stream_match.sh /path/match.mp4
#
# Pair with scripts/start_pipeline.sh; stop with scripts/kill_all.sh.

set -euo pipefail

INPUT="${1:-${HOME}/Movies/match.mp4}"
RTMP_URL="${RTMP_URL:-rtmp://localhost:1935/live/match}"

if [ ! -f "$INPUT" ]; then
  echo "ERROR: match file not found: $INPUT" >&2
  echo "Place a 90-min match MP4 there, or pass a path: $0 /path/to/match.mp4" >&2
  exit 1
fi

if ! lsof -nP -iTCP:1935 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: nothing listening on :1935." >&2
  echo "Start mediamtx first: mediamtx scripts/mediamtx.yml &" >&2
  exit 1
fi

echo "publishing  $INPUT"
echo "        ->  $RTMP_URL  (looping)"
echo "ctrl-c to stop"

# Transcode to H.264 + AAC — RTMP/FLV doesn't carry AV1 (YouTube test source is AV1).
exec ffmpeg -hide_banner -loglevel warning \
  -re -stream_loop -1 -i "$INPUT" \
  -c:v libx264 -preset veryfast -tune zerolatency -g 60 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -ac 2 -b:a 128k \
  -f flv "$RTMP_URL"
