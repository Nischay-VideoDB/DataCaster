# Loop a local match.mp4 into mediamtx as RTMP, suitable for VideoDB's
# coll.connect_rtstream(url="rtmp://localhost:1935/live/match", ...)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\stream_match.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\stream_match.ps1 C:\path\match.mp4
#
# Pair with scripts\start_pipeline.ps1; stop with scripts\kill_all.ps1.

param(
    [Parameter(Position=0)] [string] $Input
)

$ErrorActionPreference = 'Stop'

if (-not $Input) {
    $Input = Join-Path $env:USERPROFILE 'Videos\match.mp4'
}
$RtmpUrl = if ($env:RTMP_URL) { $env:RTMP_URL } else { 'rtmp://localhost:1935/live/match' }

if (-not (Test-Path $Input)) {
    Write-Error "ERROR: match file not found: $Input. Pass a path: scripts\stream_match.ps1 C:\path\to\match.mp4"
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

if (-not (Test-PortInUse 1935)) {
    Write-Error "ERROR: nothing listening on :1935. Start mediamtx first: scripts\start_mediamtx.ps1"
    exit 1
}

Write-Host "publishing  $Input"
Write-Host "        ->  $RtmpUrl  (looping)"
Write-Host "ctrl-c to stop"

# Transcode to H.264 + AAC — RTMP/FLV doesn't carry AV1 (YouTube test source is AV1).
& ffmpeg -hide_banner -loglevel warning `
    -re -stream_loop -1 -i $Input `
    -c:v libx264 -preset veryfast -tune zerolatency -g 60 -pix_fmt yuv420p `
    -c:a aac -ar 48000 -ac 2 -b:a 128k `
    -f flv $RtmpUrl
