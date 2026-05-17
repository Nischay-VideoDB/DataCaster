"""Pipeline lifecycle: /api/start /api/stop /api/health /api/live_stream."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db, pipeline
from .. import sandbox as sandbox_mod
from ..config import DEFAULT_SOURCE, DEFAULT_SOURCE_TYPE
from ..events_bus import bus

router = APIRouter()
log = logging.getLogger("routes.lifecycle")


class StartPayload(BaseModel):
    source_type: Literal["file", "url", "video"] = DEFAULT_SOURCE_TYPE  # type: ignore[arg-type]
    source: str = DEFAULT_SOURCE
    # Classifier mode. "football" runs the strict event vocab + prose
    # second-chance keyword matcher. "describe" runs only the JSON pass with
    # the generic scene-description prompt + vocab.
    content_type: Literal["football", "describe"] = "football"


@router.get("/api/health")
async def health():
    return {
        "status": "ok",
        "now": time.time(),
        "pipeline": pipeline.state.public(),
    }


@router.get("/api/videos")
async def list_videos():
    """List previously-uploaded VideoDB videos so the UI can offer them as
    presets and skip a fresh upload (saves the ~90s ingest + the credit).

    Uses the active pipeline's connection if a pipeline is running; otherwise
    creates a short-lived connection on the fly. The collection is whatever
    the SDK considers "default" for this API key (the user can switch the
    default in their VideoDB console).
    """
    import videodb

    def _fetch() -> list[dict]:
        if pipeline.state.coll is not None:
            coll = pipeline.state.coll
        else:
            coll = videodb.connect().get_collection()
        out: list[dict] = []
        for v in coll.get_videos():
            out.append({
                "id": getattr(v, "id", None),
                "name": getattr(v, "name", None) or "(unnamed)",
                "length": getattr(v, "length", None),
                "thumbnail_url": getattr(v, "thumbnail_url", None),
            })
        return out

    try:
        videos = await asyncio.to_thread(_fetch)
    except Exception as e:  # noqa: BLE001
        log.exception("/api/videos failed")
        raise HTTPException(status_code=500, detail=f"list_videos failed: {e}") from e
    return {"videos": videos}


@router.post("/api/start")
async def start(payload: StartPayload | None = None):
    p = payload or StartPayload()
    try:
        return await pipeline.start_pipeline(
            source_type=p.source_type,
            source=p.source,
            content_type=p.content_type,
        )
    except Exception as e:  # noqa: BLE001
        # Log full traceback before converting to HTTP 500 for post-mortems.
        log.exception(
            "/api/start failed (source_type=%s source=%s content_type=%s)",
            p.source_type, p.source, p.content_type,
        )
        raise HTTPException(status_code=500, detail=f"start failed: {e}") from e


@router.post("/api/stop")
async def stop():
    await pipeline.stop_pipeline()
    return {"status": "stopped"}


@router.post("/api/sandbox/sweep")
async def sandbox_sweep():
    """Manually stop any datacaster sandboxes still running on the account.

    Scoped to the sidecar-tracked id list so it cannot stop another team's
    sandbox. Safe to call any time — returns ``{"stopped": int}``.
    """
    try:
        stopped = await sandbox_mod.sweep_orphans()
    except Exception as e:  # noqa: BLE001
        log.exception("/api/sandbox/sweep failed")
        raise HTTPException(status_code=500, detail=f"sweep failed: {e}") from e
    return {"stopped": stopped}


@router.post("/api/end_session")
async def end_session():
    """Single-button reset — used by the UI's End-session control.

    Stops the pipeline (kills VOD poller / sandbox / WS listener) and clears
    the in-memory pipeline state. **Events are NOT wiped** — they persist in
    SQLite tagged by video_id so the next time the user picks the same video
    from the catalog the timeline re-hydrates instantly without re-running
    scene indexing. To force a re-classification, hit
    POST /api/events/resync (the UI's Resync button) which clears events
    for the current video_id only.

    Broadcasts a "session_ended" bus message so any open SSE listener can
    reset its in-memory state.
    """
    try:
        await pipeline.stop_pipeline()
    except Exception:  # noqa: BLE001
        log.exception("end_session: pipeline.stop_pipeline raised — continuing")
    bus.publish({"type": "session_ended"})
    return {"status": "ended"}


@router.post("/api/live_stream")
async def live_stream():
    """Lazily generate the HLS playback URL for the active rtstream.

    Calling rt.generate_stream(start, end) too early (before VideoDB has
    packaged segments from the source) freezes the stream into an empty VOD
    manifest and stops further indexing. We delay the call to this endpoint
    so the UI fetches it ~30s+ after /api/start, by which point segments
    exist and the manifest will contain real content.
    """
    rt = pipeline.state.rtstream
    if rt is None:
        raise HTTPException(status_code=400, detail="pipeline not started")
    if pipeline.state.live_player_url:
        return {
            "stream_url": pipeline.state.live_stream_url,
            "player_url": pipeline.state.live_player_url,
        }
    now_ts = int(time.time())
    started_at = pipeline.state.started_at or now_ts
    try:
        player_url = await asyncio.to_thread(
            rt.generate_stream,
            int(started_at) - 5,
            now_ts + 24 * 3600,
        )
        pipeline.state.live_stream_url = rt.stream_url
        pipeline.state.live_player_url = player_url or rt.player_url
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"generate_stream failed: {e}") from e
    return {
        "stream_url": pipeline.state.live_stream_url,
        "player_url": pipeline.state.live_player_url,
    }
