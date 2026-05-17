"""Orchestrator for the live ingestion pipeline.

Owns: VideoDB connection, optional sandbox, RTStream, visual+audio indexes,
12 alerts, and the WS-listener subprocess. All idempotent — calling
start_pipeline() twice is fine.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import videodb

from . import db
from . import sandbox as sandbox_mod
from . import source as src
from . import vod as vod_module
from .config import (
    AUDIO_BATCH_SEC, AUDIO_MODEL, DEFAULT_CONTENT_TYPE, EVENT_VOCAB, EVENTS_DIR,
    EVENTS_FILE, SANDBOX_TIER, SUPPORTED_CONTENT_TYPES, USE_SANDBOX, VISUAL_BATCH_SEC,
    VISUAL_FRAME_COUNT, VISUAL_MODEL, WS_ID_FILE, WS_LISTENER_LOG, WS_PID_FILE,
)
from .prompts import VISUAL_PROMPTS

IS_WINDOWS = sys.platform == "win32"


def _pid_alive(pid: int) -> bool:
    """Cross-platform liveness check (avoids POSIX-only os.kill(pid, 0))."""
    if IS_WINDOWS:
        # tasklist returns the header only when pid is gone.
        try:
            out = subprocess.check_output(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stderr=subprocess.DEVNULL, text=True,
            )
            return str(pid) in out
        except (OSError, subprocess.SubprocessError):
            return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, OSError):
        return False


def _terminate_pid(pid: int) -> None:
    """Cross-platform best-effort SIGTERM."""
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
        else:
            os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError):
        pass

# Index names are content_type-scoped so a describe run on a podcast doesn't
# reuse the football index. Reuse keys on these names.
def visual_index_name(content_type: str) -> str:
    return f"datacaster_visual_{content_type}"


def audio_index_name(content_type: str) -> str:
    return f"datacaster_audio_{content_type}"

log = logging.getLogger("pipeline")

REPO_ROOT = Path(__file__).resolve().parent.parent
WS_LISTENER = REPO_ROOT / "scripts/ws_listener_launcher.py"


@dataclass
class PipelineState:
    started_at: float | None = None
    starting_at: float | None = None   # set at top of /api/start, cleared once started_at is pinned
    source_type: str | None = None
    source: str | None = None
    # Classifier mode → prompt + vocab. See config.SUPPORTED_CONTENT_TYPES.
    content_type: str = "football"
    rtstream_url: str | None = None
    rtstream_id: str | None = None
    sandbox_id: str | None = None
    ws_id: str | None = None
    visual_index_id: str | None = None
    audio_index_id: str | None = None
    live_stream_url: str | None = None
    live_player_url: str | None = None
    # VOD path. Mutually exclusive with rtstream_id.
    video_id: str | None = None
    vod_scene_index_id: str | None = None        # primary JSON-schema pass
    vod_prose_index_id: str | None = None        # stock free-form prose pass
    vod_total_scenes: int | None = None
    vod_indexed_scenes: int | None = None
    # video.length seconds. Frontend uses for ETA: total windows = ceil(length/6).
    video_length_s: float | None = None
    # "spoken_word" sentinel once index_spoken_words(force=True) ran; null disables transcript tab.
    transcript_index_id: str | None = None

    # live SDK objects (not serialised)
    conn: Any = None
    coll: Any = None
    rtstream: Any = None
    sandbox: Any = None
    visual_idx: Any = None
    audio_idx: Any = None
    video: Any = None  # for VOD path

    def public(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "starting_at": self.starting_at,
            "source_type": self.source_type,
            "source": self.source,
            "content_type": self.content_type,
            "rtstream_url": self.rtstream_url,
            "rtstream_id": self.rtstream_id,
            "sandbox_id": self.sandbox_id,
            "ws_id": self.ws_id,
            "visual_index_id": self.visual_index_id,
            "audio_index_id": self.audio_index_id,
            "live_stream_url": self.live_stream_url,
            "live_player_url": self.live_player_url,
            "video_id": self.video_id,
            "vod_scene_index_id": self.vod_scene_index_id,
            "vod_prose_index_id": self.vod_prose_index_id,
            "vod_total_scenes": self.vod_total_scenes,
            "vod_indexed_scenes": self.vod_indexed_scenes,
            "video_length_s": self.video_length_s,
            "transcript_index_id": self.transcript_index_id,
            # Back-compat for older clients that read prompt_mode.
            "prompt_mode": self.content_type,
        }


state = PipelineState()


# ---------- ws_listener subprocess ----------

async def _ensure_ws_listener() -> str:
    """Spawn ws_listener.py if not running; block until WS_ID_FILE exists.

    Must delete WS_ID_FILE before spawning — a stale ws_id silently wires
    indexes to a closed websocket (symptom: timeline empty, indexes "running").
    """
    if WS_PID_FILE.exists():
        try:
            pid = int(WS_PID_FILE.read_text().strip())
            if _pid_alive(pid):
                log.info("ws_listener already running pid=%s", pid)
                ws_id = WS_ID_FILE.read_text().strip()
                return ws_id
        except (OSError, ValueError):
            pass
        WS_PID_FILE.unlink(missing_ok=True)

    # No live listener — clear stale ws_id.
    WS_ID_FILE.unlink(missing_ok=True)

    # Do NOT pass --clear: it would truncate the JSONL the classifier is tailing.
    py = sys.executable
    args = [py, str(WS_LISTENER), f"--cwd={REPO_ROOT}"]
    # Forward EVENTS_DIR so the listener writes ws_id/pid/events where we read them.
    child_env = os.environ.copy()
    child_env["VIDEODB_EVENTS_DIR"] = str(EVENTS_DIR)
    # Detach: stdout/stderr go to log file, process survives parent
    log_file = open(WS_LISTENER_LOG, "ab")
    popen_kwargs: dict = {
        "stdout": log_file, "stderr": subprocess.STDOUT, "env": child_env,
    }
    if IS_WINDOWS:
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        popen_kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        popen_kwargs["start_new_session"] = True
    p = subprocess.Popen(args, **popen_kwargs)  # noqa: S603
    log.info("spawned ws_listener pid=%s", p.pid)

    # Wait for WS_ID_FILE; fast-fail if the listener exits early.
    for _ in range(60):  # up to 30s
        await asyncio.sleep(0.5)
        if WS_ID_FILE.exists():
            ws_id = WS_ID_FILE.read_text().strip()
            if ws_id:
                return ws_id
        if p.poll() is not None:
            # Surface tail-of-log into the error so we can debug from uvicorn output.
            log_file.flush()
            try:
                tail = WS_LISTENER_LOG.read_text(errors="replace").splitlines()[-15:]
                tail_text = "\n  ".join(tail) or "(empty log)"
            except OSError:
                tail_text = "(could not read log)"
            raise RuntimeError(
                f"ws_listener exited (code={p.returncode}) before producing ws_id. "
                f"Tail of {WS_LISTENER_LOG}:\n  {tail_text}"
            )
    raise RuntimeError("ws_listener did not produce a ws_id within 30s")


async def _stop_ws_listener() -> None:
    if WS_PID_FILE.exists():
        try:
            pid = int(WS_PID_FILE.read_text().strip())
            _terminate_pid(pid)
        except ValueError:
            pass
        WS_PID_FILE.unlink(missing_ok=True)
    WS_ID_FILE.unlink(missing_ok=True)


# ---------- main lifecycle ----------

async def _resolve_source(source_type: str, source: str) -> str:
    """Return the URL to hand to coll.connect_rtstream.

    file    → ffmpeg loop into mediamtx → rtmp://localhost
    url     → identity
    youtube → identity (caller will fall back via _retry_youtube_via_ffmpeg)
    """
    if source_type == "file":
        return await src.start_file_loop(source)
    if source_type == "url":
        return source
    if source_type == "youtube":
        return source
    raise ValueError(f"unknown source_type: {source_type}")


def _connect_rtstream_with_youtube_fallback(coll: Any, *, rtstream_url: str,
                                            source_type: str, source: str,
                                            ws_id: str) -> tuple[Any, str]:
    """Try direct connect first; for YouTube, fall back to local republish."""
    try:
        rt = coll.connect_rtstream(
            url=rtstream_url, name=f"datacaster_{int(time.time())}",
            media_types=["audio", "video"], store=True,
            ws_connection_id=ws_id,
        )
        return rt, rtstream_url
    except Exception as e:  # noqa: BLE001
        if source_type != "youtube":
            raise
        log.warning("direct YouTube connect failed (%s); falling back to ffmpeg republish", e)

    # async fallback isn't easy from sync here; run it via the event loop
    loop = asyncio.get_event_loop()
    new_url = loop.run_until_complete(src.start_youtube_fallback(source))
    rt = coll.connect_rtstream(
        url=new_url, name=f"datacaster_{int(time.time())}",
        media_types=["audio", "video"], store=True,
        ws_connection_id=ws_id,
    )
    return rt, new_url


_vod_worker_task: asyncio.Task | None = None
_vod_stop: asyncio.Event | None = None


async def _start_vod_pipeline(
    *, source: str, content_type: str = DEFAULT_CONTENT_TYPE,
) -> dict[str, Any]:
    """VOD branch: upload, kick scene indexing, spawn poll worker, return state.
    Reuses backend.vod.poll_scene_index_forever → same bus as live path."""
    global _vod_worker_task, _vod_stop
    visual_prompt = VISUAL_PROMPTS[content_type]

    coll = state.coll
    if coll is None:
        raise RuntimeError("coll not initialised before _start_vod_pipeline()")

    # Events persist per-video_id across restarts; force-fresh path = /api/events/resync.

    # 1. Upload + wait until transcoding finishes (video.length > 0).
    log.info("VOD upload starting source=%s", source)
    video = await src.upload_vod(coll, source, timeout_s=300, poll_interval_s=3)
    # Refuse a non-Video so /api/start fails clean instead of every later call breaking.
    if not hasattr(video, "search") or not hasattr(video, "index_scenes"):
        raise RuntimeError(
            f"VOD upload returned a non-Video object "
            f"(type={type(video).__name__}, id={getattr(video, 'id', '?')}). "
            f"This breaks search/highlights/commentary. Check upload_vod logic."
        )
    state.video = video
    state.video_id = video.id
    state.source = source
    state.source_type = "video"
    state.video_length_s = float(video.length or 0) or None
    log.info("VOD ready id=%s length=%.1fs", video.id, float(video.length or 0))

    # 2. Kick HLS so the StreamPanel can play while indexing runs.
    try:
        stream_url = await asyncio.to_thread(video.generate_stream)
        state.live_stream_url = stream_url
        state.live_player_url = getattr(video, "player_url", None) or stream_url
    except Exception as e:  # noqa: BLE001
        log.warning("video.generate_stream failed: %s — UI may not show preview", e)

    # 2.5 Re-hydrate gate.
    #   (a) fully indexed → skip indexing, hydrate from disk.
    #   (b) partial → resume from last scene-end offset, no re-billing.
    cached_event_count = await db.events_exist_for_video(video.id)
    cached_offset_str = await db.get_state(f"vod_offset:{video.id}")
    cached_offset = float(cached_offset_str) if cached_offset_str else 0.0
    video_len = float(video.length or 0)
    # "Fully indexed" = within 12s (1-2 scene windows) of the end.
    fully_indexed = video_len > 0 and cached_offset >= max(0.0, video_len - 12.0)

    if cached_event_count > 0 and fully_indexed:
        log.info(
            "VOD video_id=%s fully indexed previously (%d events, offset=%.1fs)"
            " — instant rehydrate.",
            video.id, cached_event_count, cached_offset,
        )
        state.vod_scene_index_id = None
        state.vod_prose_index_id = None
        state.visual_index_id = None
        state.vod_total_scenes = cached_event_count
        state.vod_indexed_scenes = cached_event_count
        state.transcript_index_id = "spoken_word"
        async def _ensure_transcript_bg():
            try:
                await asyncio.to_thread(video.index_spoken_words, force=True)
            except Exception as e:  # noqa: BLE001
                log.warning("rehydrate index_spoken_words(force=True) failed: %s", e)
        asyncio.create_task(_ensure_transcript_bg())
        # CRITICAL: reuse the same wall-clock anchor as the cached events.
        # The frontend computes `unix_ts - started_at = video_offset`; a fresh
        # anchor would render every row as --:--. Stored at vod_anchor:<id>.
        prior_anchor_str = await db.get_state(f"vod_anchor:{video.id}")
        if prior_anchor_str:
            state.started_at = float(prior_anchor_str)
        else:
            # Pre-v5 DBs lack the per-video anchor. Fall back to oldest event ts.
            oldest_ts_str = await db.get_state(f"vod_first_ts:{video.id}")
            if oldest_ts_str:
                state.started_at = float(oldest_ts_str)
            else:
                rows = await db.list_events_for_video(video.id, limit=1)
                if rows:
                    state.started_at = float(rows[0]["unix_ts"])
                    await db.set_state(
                        f"vod_first_ts:{video.id}", str(state.started_at),
                    )
                else:
                    state.started_at = time.time()
            await db.set_state(f"vod_anchor:{video.id}", str(state.started_at))
        state.starting_at = None
        await db.set_state("started_at", str(state.started_at))
        return state.public()

    if cached_event_count > 0:
        log.info(
            "VOD video_id=%s partial cache: %d events, offset=%.1fs/%.1fs — resuming.",
            video.id, cached_event_count, cached_offset, video_len,
        )
    state._resume_from_offset_s = cached_offset  # type: ignore[attr-defined]

    # 3. ONE pass against the per-mode JSON prompt.
    # The earlier second prose-keyword pass doubled time + credits and produced
    # phantom goals; loosened confidence floors made it redundant.
    import re as _re
    from videodb import SceneExtractionType

    extraction_kwargs: dict[str, Any] = {
        "extraction_type": SceneExtractionType.time_based,
        "extraction_config": {"time": 6, "select_frames": ["first", "middle", "last"]},
    }
    # Don't route VISUAL_MODEL/sandbox_id through video.index_scenes — the
    # 31B Gemma path sticks the server queue (10+ min "Stuck on processing").
    # Default-model classifier completes in 3-6 min; validator handles FPs.

    async def _start_index(prompt: str, label: str) -> str | None:
        """video.index_scenes with reuse-or-rebuild handling.
        Existing index with scenes → reuse. Stuck/empty → delete+rebuild,
        or fresh-name fallback when delete itself fails server-side."""
        try:
            return await asyncio.to_thread(video.index_scenes, prompt=prompt, **extraction_kwargs)
        except Exception as e:  # noqa: BLE001
            m = _re.search(r"id\s+([a-f0-9]+)", str(e))
            if not m:
                raise
            existing_id = m.group(1)

            # Probe: is the existing index actually populated?
            def _probe() -> int:
                try:
                    res = video.get_scene_index(existing_id)
                    if res is None:
                        return 0
                    return len(list(res))
                except Exception:  # noqa: BLE001
                    return -1
            try:
                scene_count = await asyncio.wait_for(
                    asyncio.to_thread(_probe), timeout=15.0,
                )
            except asyncio.TimeoutError:
                scene_count = -1

            if scene_count > 0:
                log.info(
                    "VOD %s index %s exists with %d scenes — reusing.",
                    label, existing_id, scene_count,
                )
                return existing_id

            log.warning(
                "VOD %s index %s exists but probe returned %s — deleting + rebuilding.",
                label, existing_id, scene_count,
            )
            try:
                await asyncio.to_thread(video.delete_scene_index, existing_id)
            except Exception as del_err:  # noqa: BLE001
                log.warning(
                    "delete_scene_index(%s) failed: %s — creating fresh "
                    "index with unique name instead",
                    existing_id, del_err,
                )
                fresh_name = f"datacaster_{label}_{int(time.time())}"
                try:
                    return await asyncio.to_thread(
                        video.index_scenes,
                        prompt=prompt,
                        name=fresh_name,
                        **extraction_kwargs,
                    )
                except Exception as e2:  # noqa: BLE001
                    log.error(
                        "fresh-name index_scenes failed: %s — reusing %s",
                        e2, existing_id,
                    )
                    return existing_id
            return await asyncio.to_thread(video.index_scenes, prompt=prompt, **extraction_kwargs)

    # Pin state.started_at BEFORE indexers fire — the poll worker reads it as
    # `unix_ts = anchor + scene.start`. Setting after create_task drifts every ts.
    # On resume, reuse the prior anchor or new events split the timeline.
    resume_offset = getattr(state, "_resume_from_offset_s", 0.0)
    if resume_offset > 0:
        prior_anchor_str = await db.get_state(f"vod_anchor:{video.id}")
        state.started_at = float(prior_anchor_str) if prior_anchor_str else time.time()
    else:
        state.started_at = time.time()
    state.starting_at = None
    await db.set_state("started_at", str(state.started_at))
    # Persist per-video anchor so Stop+Start can resume.
    await db.set_state(f"vod_anchor:{video.id}", str(state.started_at))

    # 3. Scene indexing + spoken-word transcription in parallel.
    # force=True makes index_spoken_words idempotent.
    async def _ensure_transcript() -> str | None:
        try:
            await asyncio.to_thread(video.index_spoken_words, force=True)
            return "spoken_word"
        except Exception as e:  # noqa: BLE001
            # Audio-less or rate-limited; transcript tab will be empty.
            log.warning("index_spoken_words(force=True) failed: %s", e)
            return None

    json_index_id, transcript_sentinel = await asyncio.gather(
        _start_index(visual_prompt, "json"),
        _ensure_transcript(),
    )
    state.vod_scene_index_id = json_index_id
    state.vod_prose_index_id = None
    state.visual_index_id = json_index_id
    state.transcript_index_id = transcript_sentinel
    log.info(
        "VOD indexes ready scene=%s transcript=%s",
        json_index_id, transcript_sentinel,
    )

    # 5. Poll worker. Writes events to bus + DB; exits on stable scene count or /api/stop.
    _vod_stop = asyncio.Event()
    _vod_worker_task = asyncio.create_task(
        vod_module.poll_scene_index_forever(
            state=state,
            stop=_vod_stop,
            poll_interval_s=5,
            resume_from_offset_s=resume_offset,
        ),
        name="vod_poller",
    )

    return state.public()


async def start_pipeline(
    *, source_type: str, source: str,
    content_type: str = DEFAULT_CONTENT_TYPE,
) -> dict[str, Any]:
    """Idempotent. Two flows:
      - source_type in {"url", "file"} → live RTStream (WS-driven).
      - source_type == "video"         → VOD (upload + poll scene index).
    """
    if content_type not in SUPPORTED_CONTENT_TYPES:
        raise ValueError(
            f"unsupported content_type {content_type!r}; "
            f"expected one of {SUPPORTED_CONTENT_TYPES}"
        )
    if state.started_at is not None and (state.rtstream is not None or state.video is not None):
        log.info("pipeline already running; returning state")
        return state.public()

    state.starting_at = time.time()
    state.content_type = content_type
    try:
        return await _start_pipeline_inner(
            source_type=source_type, source=source, content_type=content_type,
        )
    except Exception:
        state.starting_at = None
        # Release any allocated sandbox so medium-tier compute stops billing.
        if state.sandbox is not None:
            log.warning("start_pipeline failed mid-init; releasing sandbox %s",
                        state.sandbox_id)
            try:
                await _stop_sandbox_only()
            except Exception as e:  # noqa: BLE001
                log.warning("_stop_sandbox_only after failure: %s", e)
        raise


async def _stop_sandbox_only() -> None:
    """Release sandbox + clear its state fields (error paths in start_pipeline)."""
    sb = state.sandbox
    sandbox_id = state.sandbox_id
    if sb is None:
        return
    try:
        await asyncio.to_thread(sb.stop)
        await asyncio.to_thread(sb.wait_for_stop, timeout=120, interval=5)
    except Exception as e:  # noqa: BLE001
        log.warning("sandbox.stop failed (may already be stopped): %s", e)
    finally:
        if sandbox_id:
            sandbox_mod.unregister(sandbox_id)
        state.sandbox = None
        state.sandbox_id = None


async def _start_pipeline_inner(
    *, source_type: str, source: str, content_type: str = DEFAULT_CONTENT_TYPE,
) -> dict[str, Any]:
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    await db.init()

    # Names + prompt scoped to content_type to avoid cross-mode index reuse.
    visual_name = visual_index_name(content_type)
    audio_name = audio_index_name(content_type)
    visual_prompt = VISUAL_PROMPTS[content_type]

    # 1. ws_listener must be up before any indexing call.
    ws_id = await _ensure_ws_listener()
    state.ws_id = ws_id

    # 2. VideoDB connection
    conn = videodb.connect()
    coll = conn.get_collection()
    state.conn = conn
    state.coll = coll

    # 3. Optional sandbox
    if USE_SANDBOX:
        log.info("creating sandbox tier=%s", SANDBOX_TIER)
        # Register id BEFORE wait_for_ready so SIGKILL leaves a sweepable trail.
        sb = await asyncio.to_thread(conn.create_sandbox, tier=SANDBOX_TIER)
        sandbox_mod.register(sb.id)
        await asyncio.to_thread(sb.wait_for_ready, timeout=300, interval=5)
        state.sandbox = sb
        state.sandbox_id = sb.id
    else:
        log.info("USE_SANDBOX=false — using default VideoDB models")
        state.sandbox = None
        state.sandbox_id = None

    # 3b. VOD branch — no RTStream, no ws_listener; reuses the live bus path.
    if source_type == "video":
        return await _start_vod_pipeline(source=source, content_type=content_type)

    # 4. Resolve the source URL (may start ffmpeg+mediamtx)
    rtstream_url = await _resolve_source(source_type, source)
    state.source_type = source_type
    state.source = source
    state.rtstream_url = rtstream_url

    # 5. Connect rtstream (with YouTube fallback)
    def _connect():
        return _connect_rtstream_with_youtube_fallback(
            coll, rtstream_url=rtstream_url, source_type=source_type,
            source=source, ws_id=ws_id,
        )
    rt, final_url = await asyncio.to_thread(_connect)
    state.rtstream = rt
    state.rtstream_id = rt.id
    state.rtstream_url = final_url
    # Tag with rtstream id so the per-video_id persistence path applies to live too.
    state.video_id = rt.id

    # Pin started_at BEFORE any indexer fires; see VOD branch for reason.
    state.started_at = time.time()
    await db.set_state("started_at", str(state.started_at))

    try:
        await asyncio.to_thread(rt.start)
    except Exception as e:  # noqa: BLE001
        # "already connected" can leak from a partial prior failure — tolerate it.
        if "already connected" in str(e).lower() or "already started" in str(e).lower():
            log.info("rtstream already started; continuing")
        else:
            raise

    # Do NOT call rt.generate_stream(start, end) here — end=future packages a
    # VOD manifest with ENDLIST, freezing ingestion. UI fetches via /api/live_stream.
    state.live_stream_url = None
    state.live_player_url = None
    log.info(
        "rtstream connected id=%s url=%s",
        rt.id, final_url,
    )

    # 6. Visual index — structured JSON via the per-content_type prompt
    from .prompts import AUDIO as AUDIO_PROMPT

    def _start_visual():
        kwargs: dict[str, Any] = {
            "prompt": visual_prompt,
            "batch_config": {"type": "time", "value": VISUAL_BATCH_SEC,
                             "frame_count": VISUAL_FRAME_COUNT},
            "name": visual_name,
            "ws_connection_id": ws_id,
        }
        if USE_SANDBOX:
            # rtstream.index_visuals() doesn't accept sandbox_id top-level — the
            # SDK forwards it via model_config. Without this, GPU model never runs.
            kwargs["model_name"] = VISUAL_MODEL
            if state.sandbox_id:
                kwargs["model_config"] = {"sandbox_id": state.sandbox_id}
        return rt.index_visuals(**kwargs)

    try:
        visual_idx = await asyncio.to_thread(_start_visual)
        state.visual_idx = visual_idx
        state.visual_index_id = getattr(visual_idx, "rtstream_index_id", None) or getattr(
            visual_idx, "id", None
        )
        log.info("visual index started id=%s", state.visual_index_id)
    except Exception as e:  # noqa: BLE001
        # Reuse if an index is already running on this rtstream.
        if "already" in str(e).lower():
            indexes = await asyncio.to_thread(rt.list_scene_indexes)
            for idx in indexes:
                if getattr(idx, "name", "") == visual_name:
                    visual_idx = idx
                    state.visual_idx = idx
                    state.visual_index_id = getattr(idx, "rtstream_index_id", None) or getattr(
                        idx, "id", None
                    )
                    log.info("reusing existing visual index id=%s", state.visual_index_id)
                    break
            else:
                raise
        else:
            raise

    # 7. Audio index
    def _start_audio():
        kwargs: dict[str, Any] = {
            "prompt": AUDIO_PROMPT,
            "batch_config": {"type": "time", "value": AUDIO_BATCH_SEC},
            "name": audio_name,
            "ws_connection_id": ws_id,
        }
        if USE_SANDBOX:
            kwargs["model_name"] = AUDIO_MODEL
            if state.sandbox_id:
                kwargs["model_config"] = {"sandbox_id": state.sandbox_id}
        return rt.index_audio(**kwargs)

    try:
        audio_idx = await asyncio.to_thread(_start_audio)
        state.audio_idx = audio_idx
        state.audio_index_id = getattr(audio_idx, "rtstream_index_id", None) or getattr(
            audio_idx, "id", None
        )
        log.info("audio index started id=%s", state.audio_index_id)
    except Exception as e:  # noqa: BLE001
        log.warning("audio index failed (continuing without): %s", e)

    # 8. Transcript
    try:
        await asyncio.to_thread(rt.start_transcript, ws_connection_id=ws_id)
        log.info("transcript started")
    except Exception as e:  # noqa: BLE001
        log.warning("transcript failed (continuing without): %s", e)

    # 9. Alerts — register 12 events and wire each to the visual index
    async def _register_alerts():
        existing = {}
        try:
            existing = {e.get("label"): e.get("event_id") for e in
                        await asyncio.to_thread(conn.list_events)}
        except Exception:
            pass

        for label, prompt in EVENT_VOCAB.items():
            try:
                if label in existing and existing[label]:
                    event_id = existing[label]
                else:
                    event_id = await asyncio.to_thread(
                        conn.create_event, event_prompt=prompt, label=label,
                    )
                # callback_url is REQUIRED; "" = WS-only delivery.
                await asyncio.to_thread(
                    visual_idx.create_alert,
                    event_id=event_id, callback_url="", ws_connection_id=ws_id,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("alert wire failed for %s: %s", label, e)

    asyncio.create_task(_register_alerts())  # don't block /api/start

    # started_at was pinned earlier; clear the in-flight marker.
    state.starting_at = None
    return state.public()


async def stop_pipeline() -> None:
    """Best-effort shutdown. finally always releases the sandbox."""
    global _vod_worker_task, _vod_stop
    try:
        if state.rtstream is not None:
            try:
                await asyncio.to_thread(state.rtstream.stop)
            except Exception as e:  # noqa: BLE001
                log.warning("rtstream.stop failed: %s", e)

        # Cancel the VOD poller so it stops issuing API calls.
        if _vod_stop is not None:
            _vod_stop.set()
        if _vod_worker_task is not None:
            _vod_worker_task.cancel()
            try:
                await _vod_worker_task
            except (asyncio.CancelledError, Exception):
                pass
        _vod_worker_task = None
        _vod_stop = None

        await src.shutdown_publisher()
        await _stop_ws_listener()
    finally:
        if state.sandbox is not None:
            sandbox_id = state.sandbox_id
            try:
                await asyncio.to_thread(state.sandbox.stop)
                await asyncio.to_thread(state.sandbox.wait_for_stop, timeout=120, interval=5)
            except Exception as e:  # noqa: BLE001
                log.warning("sandbox.stop failed: %s", e)
            # Drop sidecar entry regardless; /api/sandbox/sweep retries unstopped.
            if sandbox_id:
                sandbox_mod.unregister(sandbox_id)
        # mediamtx stays up (kill_all.sh handles it).
        state.starting_at = None

    state.__init__()  # type: ignore[misc]
