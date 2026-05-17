"""Source dispatcher: turn a (source_type, source) pair into an RTMP/RTSP URL
that VideoDB's connect_rtstream can ingest.

Three modes:
  file    — ffmpeg loops the local MP4 → mediamtx → returns rtmp://localhost:...
  url     — pass through; assumed already RTSP/RTMP/HLS
  youtube — try connect_rtstream(url) directly first (caller's responsibility);
            this module exposes a fallback that uses yt-dlp to resolve a direct
            stream URL and ffmpeg-republishes into mediamtx.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
from pathlib import Path

from .config import LOCAL_RTMP_URL, MTX_LOG, MTX_PIDFILE, PUBLISHER_LOG, PUB_PIDFILE

log = logging.getLogger("source")

MTX_CONFIG = Path(__file__).resolve().parent.parent / "scripts" / "mediamtx.yml"
IS_WINDOWS = sys.platform == "win32"


def _port_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something accepts a TCP connection on host:port. Cross-platform."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            return s.connect_ex((host, port)) == 0
        except OSError:
            return False


def _terminate_pid(pid: int) -> None:
    """Best-effort cross-platform process kill."""
    try:
        os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError, ProcessLookupError):
        pass


def _which_or_die(binary: str) -> str:
    p = shutil.which(binary)
    if not p:
        raise RuntimeError(f"required binary not found on PATH: {binary}")
    return p


async def _ensure_mediamtx() -> None:
    """Idempotent: start mediamtx if not already listening on :1935."""
    if _port_listening(1935):
        log.info("mediamtx already running (port 1935 in use)")
        return

    binary = _which_or_die("mediamtx")
    if not MTX_CONFIG.exists():
        raise RuntimeError(f"mediamtx config missing: {MTX_CONFIG}")

    p = await asyncio.create_subprocess_exec(
        binary, str(MTX_CONFIG),
        stdout=open(MTX_LOG, "ab"),
        stderr=asyncio.subprocess.STDOUT,
    )
    MTX_PIDFILE.write_text(str(p.pid))
    log.info("started mediamtx pid=%s", p.pid)
    # give it a moment to bind
    await asyncio.sleep(1.0)


def _spawn_publisher(args: list[str]) -> int:
    """Spawn ffmpeg detached, return pid. Cross-platform (POSIX + Windows)."""
    log_fp = open(PUBLISHER_LOG, "ab")
    kwargs: dict = {
        "stdout": log_fp,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if IS_WINDOWS:
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — survives parent exit, blocks Ctrl-C propagation.
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True

    p = subprocess.Popen(args, **kwargs)  # noqa: S603
    PUB_PIDFILE.write_text(str(p.pid))
    return p.pid


async def _kill_publisher() -> None:
    if PUB_PIDFILE.exists():
        try:
            pid = int(PUB_PIDFILE.read_text().strip())
            _terminate_pid(pid)
        except ValueError:
            pass
        PUB_PIDFILE.unlink(missing_ok=True)


async def start_file_loop(input_path: str) -> str:
    """Start ffmpeg loop publishing the file as RTMP. Returns the publish URL."""
    if not Path(input_path).exists():
        raise FileNotFoundError(f"source file not found: {input_path}")

    await _ensure_mediamtx()
    await _kill_publisher()

    ffmpeg = _which_or_die("ffmpeg")
    args = [
        ffmpeg, "-hide_banner", "-loglevel", "warning",
        "-re", "-stream_loop", "-1", "-i", input_path,
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-g", "60", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k",
        "-f", "flv", LOCAL_RTMP_URL,
    ]
    pid = _spawn_publisher(args)
    log.info("started ffmpeg loop pid=%s -> %s", pid, LOCAL_RTMP_URL)
    # wait briefly for first frames to land
    await asyncio.sleep(2.0)
    return LOCAL_RTMP_URL


async def start_youtube_fallback(youtube_url: str) -> str:
    """yt-dlp resolves a direct media URL → ffmpeg republishes into mediamtx.

    Used when connect_rtstream rejects the YouTube URL directly.
    """
    await _ensure_mediamtx()
    await _kill_publisher()

    yt_dlp = _which_or_die("yt-dlp")
    ffmpeg = _which_or_die("ffmpeg")

    # Resolve a direct stream URL (best video+audio under 720p, mp4-friendly)
    proc = await asyncio.create_subprocess_exec(
        yt_dlp, "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
        "-g", "--no-warnings", youtube_url,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp resolve failed: {err.decode()[:200]}")
    urls = [u for u in out.decode().splitlines() if u.strip()]
    if not urls:
        raise RuntimeError("yt-dlp returned no URLs")

    # If two URLs (separate video + audio), pass both as -i; else single input.
    inputs: list[str] = []
    for u in urls:
        inputs += ["-i", u]

    args = [
        ffmpeg, "-hide_banner", "-loglevel", "warning",
        "-re",
        *inputs,
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-g", "60", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k",
        "-f", "flv", LOCAL_RTMP_URL,
    ]
    pid = _spawn_publisher(args)
    log.info("started YouTube republish pid=%s", pid)
    await asyncio.sleep(2.0)
    return LOCAL_RTMP_URL


async def shutdown_publisher() -> None:
    """Kill the active ffmpeg publisher (if any). Safe to call multiple times."""
    await _kill_publisher()


async def shutdown_mediamtx() -> None:
    """Kill mediamtx (only if we started it). Safe."""
    if MTX_PIDFILE.exists():
        try:
            pid = int(MTX_PIDFILE.read_text().strip())
            _terminate_pid(pid)
        except ValueError:
            pass
        MTX_PIDFILE.unlink(missing_ok=True)


# ---------- VOD (pre-recorded video) ingest ----------

async def upload_vod(coll: Any, url: str, *, timeout_s: float = 300.0,
                     poll_interval_s: float = 3.0) -> Any:
    """Upload a VOD and wait until transcoded (video.length > 0).

    `url` may be a video id (starts with `m-`) — in that case we skip upload
    and reuse the existing Video, saving ~90s ingest + the credit.

    Force `media_type="video"` so YouTube URLs don't come back as Audio
    objects (id prefix `a-`) which break .search / .index_scenes / .generate_stream.
    """
    # Fast path: URL is actually a video id from a previous upload.
    if url.startswith("m-"):
        log.info("VOD source looks like an existing video id (%s) — fetching", url)
        try:
            video = await asyncio.to_thread(coll.get_video, url)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"coll.get_video({url}) failed: {e}. The id may belong to a "
                "different collection or have been deleted."
            ) from e
        if video is None or not hasattr(video, "search"):
            raise RuntimeError(
                f"get_video({url}) returned {type(video).__name__}; expected Video"
            )
        log.info("reusing existing video id=%s length=%.1fs", video.id, float(video.length or 0))
        return video

    log.info("uploading VOD url=%s", url)
    try:
        video = await asyncio.to_thread(coll.upload, url=url, media_type="video")
    except TypeError as e:
        # Older SDKs without media_type kwarg.
        log.warning("coll.upload(media_type=video) rejected (%s); retrying without", e)
        video = await asyncio.to_thread(coll.upload, url=url)

    if video is None:
        raise RuntimeError("coll.upload() returned None — upload failed")

    # If SDK returned a non-Video (Audio/Image), recover via get_video by id.
    if not hasattr(video, "search") or not hasattr(video, "index_scenes"):
        obj_type = type(video).__name__
        obj_id = getattr(video, "id", "?")
        log.warning(
            "upload_vod returned %s (id=%s) instead of Video — falling back to coll.get_video",
            obj_type, obj_id,
        )
        try:
            video = await asyncio.to_thread(coll.get_video, obj_id)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"upload_vod got {obj_type} (id={obj_id}) instead of Video, "
                f"and get_video fallback failed: {e}"
            ) from e
        if not hasattr(video, "search"):
            raise RuntimeError(
                f"After fallback, video object still lacks .search "
                f"(type={type(video).__name__})"
            )

    # Poll readiness; each iteration re-fetches the Video record.
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        length = float(getattr(video, "length", 0) or 0)
        if length > 0:
            log.info("VOD ready id=%s length=%.1fs", video.id, length)
            return video
        try:
            video = await asyncio.to_thread(coll.get_video, video.id)
        except Exception as e:  # noqa: BLE001
            log.warning("VOD refresh failed (%s) — retrying", e)
        await asyncio.sleep(poll_interval_s)

    raise TimeoutError(
        f"VOD did not finish transcoding within {timeout_s:.0f}s "
        f"(video_id={getattr(video, 'id', '?')})"
    )
