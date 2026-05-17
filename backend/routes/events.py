"""SSE event stream + REST history.

Events are scoped per video_id (set on insert by the VOD pipeline). The
GET endpoints accept an optional `video_id` query param so the UI can pull
just the events for the currently-loaded video; without it they fall back
to "events for the active pipeline's video, if any" so older clients keep
working.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException

from sse_starlette.sse import EventSourceResponse

from .. import db, pipeline
from ..events_bus import bus

router = APIRouter()
log = logging.getLogger("routes.events")


def _active_video_id() -> str | None:
    """video_id of the currently-loaded pipeline, if any."""
    return pipeline.state.video_id


@router.get("/api/events")
async def events_sse():
    """SSE stream of new events, with a replay of the active video's recent events on connect."""
    active_video = _active_video_id()

    async def gen():
        if active_video:
            recent = await db.list_events(limit=200, video_id=active_video)
            for evt in reversed(recent):
                yield {"event": "event", "data": json.dumps({"type": "event", "event": evt})}
        # Idle pipeline → no replay, otherwise the prior run's events would re-render after End-session.

        q = bus.subscribe(maxsize=400)
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": msg.get("type", "message"), "data": json.dumps(msg)}
                except asyncio.TimeoutError:
                    # heartbeat keeps the connection alive through proxies
                    yield {"event": "ping", "data": "{}"}
        finally:
            bus.unsubscribe(q)

    return EventSourceResponse(gen())


@router.get("/api/events/history")
async def events_history(limit: int = 200, video_id: str | None = None):
    """Most recent events for the given video, or for the active pipeline video when omitted."""
    target = video_id or _active_video_id()
    return {"events": await db.list_events(limit=limit, video_id=target)}


@router.get("/api/stats")
async def stats(video_id: str | None = None):
    """Per-event-type counts for the given video, or the active pipeline's video when omitted."""
    target = video_id or _active_video_id()
    counts = await db.event_counts(video_id=target)
    return {"counts": counts, "total": sum(counts.values())}


@router.post("/api/events/resync")
async def events_resync():
    """Wipe events for the active video_id and re-trigger indexing under the current prompt + floors."""
    active = pipeline.state.video_id
    source = pipeline.state.source
    source_type = pipeline.state.source_type
    content_type = pipeline.state.content_type
    if not active or not source:
        raise HTTPException(
            status_code=400,
            detail="no active pipeline; nothing to resync. Start a pipeline first.",
        )
    cleared = await db.clear_events_for_video(active)
    # Wipe per-video resume markers so the worker re-indexes from 0 instead of resuming.
    await db.set_state(f"vod_offset:{active}", "0")
    await db.set_state(f"vod_anchor:{active}", "")
    log.info("resync: cleared %d events for video_id=%s", cleared, active)

    # Capture scene index id before stop_pipeline wipes state, so we can delete it on the SDK side.
    stale_scene_index_id = pipeline.state.vod_scene_index_id
    video = pipeline.state.video

    try:
        await pipeline.stop_pipeline()
    except Exception:  # noqa: BLE001
        log.exception("resync: stop_pipeline raised — continuing")

    # Delete the scene index outside the stop_pipeline finally so a transient SDK error doesn't block the wipe.
    if stale_scene_index_id and video is not None:
        try:
            import asyncio as _asyncio
            await _asyncio.to_thread(video.delete_scene_index, stale_scene_index_id)
            log.info("resync: deleted scene index %s", stale_scene_index_id)
        except Exception as e:  # noqa: BLE001
            log.warning("resync: delete_scene_index(%s) failed (continuing): %s",
                        stale_scene_index_id, e)
    try:
        result = await pipeline.start_pipeline(
            source_type=source_type or "video",
            source=source,
            content_type=content_type or "football",
        )
    except Exception as e:  # noqa: BLE001
        log.exception("resync: start_pipeline raised")
        raise HTTPException(status_code=500, detail=f"resync restart failed: {e}") from e
    bus.publish({"type": "resync", "video_id": active, "cleared": cleared})
    return {"status": "resyncing", "video_id": active, "cleared": cleared, "pipeline": result}
