"""GET /api/highlights/stream  /api/highlights  ;  POST /api/highlights/reel"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db, pipeline
from .. import highlights as highlights_module
from .. import telegram as telegram_client
from ..config import TELEGRAM_ENABLED

router = APIRouter()
log = logging.getLogger("routes.highlights")


@router.get("/api/highlights/stream")
async def stream():
    return await highlights_module.get_highlights_stream()


@router.get("/api/highlights")
async def list_highlights(limit: int = 25):
    return {"items": await db.list_highlights(limit=limit)}


@router.post("/api/highlights/refresh")
async def refresh():
    n = await highlights_module.refresh_highlights()
    return {"stored": n}


class ReelPayload(BaseModel):
    """Request body for POST /api/highlights/reel.

    `n` controls how many of the most-recent events drive the reel
    (default 3 → ~30s). `aspect` picks the Timeline output resolution
    (vertical 9:16 by default for TikTok/Reels). `deliver="telegram"`
    posts the composed reel + caption to the configured chat; "none"
    skips delivery entirely (UI gets the reel + caption either way).
    """
    n: int = Field(3, ge=1, le=10)
    aspect: Literal["vertical", "square", "landscape"] = "vertical"
    deliver: Literal["telegram", "none"] = "telegram"


@router.post("/api/highlights/reel")
async def make_reel(payload: ReelPayload | None = None):
    p = payload or ReelPayload()
    state = pipeline.state
    if not state.video_id or not state.started_at:
        raise HTTPException(
            status_code=400,
            detail="no active pipeline — start one before composing a reel",
        )

    # list_events returns DESC by id; reverse for chronological order.
    rows = await db.list_events(limit=p.n, video_id=state.video_id)
    if not rows:
        raise HTTPException(
            status_code=400,
            detail=(
                "no events on the active video — wait for the indexer to "
                "produce at least one moment, then try again"
            ),
        )
    events = list(reversed(rows))[: p.n]

    try:
        composed = await highlights_module.compose_reel_from_events(events, aspect=p.aspect)
    except Exception as e:  # noqa: BLE001
        log.exception("compose_reel_from_events failed")
        raise HTTPException(status_code=500, detail=f"reel compose failed: {e}") from e

    reel_url = composed.get("reel_url")
    caption = composed.get("caption") or ""

    # send_reel returns None when env vars are missing or both delivery attempts fail.
    delivered_to: str | None = None
    telegram_message_id: int | None = None
    if p.deliver == "telegram" and reel_url:
        result = await telegram_client.send_reel(reel_url, caption)
        if result and result.get("message_id"):
            delivered_to = "telegram"
            telegram_message_id = result["message_id"]

    return {
        "reel_url": reel_url,
        "caption": caption,
        "aspect": p.aspect,
        "n": p.n,
        "events_used": len(events),
        "delivered_to": delivered_to,
        "telegram_message_id": telegram_message_id,
        "telegram_configured": TELEGRAM_ENABLED,
    }
