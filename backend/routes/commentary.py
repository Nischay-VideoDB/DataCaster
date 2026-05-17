"""POST /api/commentary?event_id=…&style=…  ;  GET /api/commentary/track."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import commentary as commentary_module
from .. import db

router = APIRouter()


@router.post("/api/commentary")
async def generate(event_id: int = Query(..., ge=1), style: str = "excited"):
    try:
        result = await commentary_module.generate_for_event(event_id, style=style)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"commentary failed: {e}") from e
    return result


@router.get("/api/commentary/track")
async def track(limit: int = 50):
    return {
        "items": await db.list_commentary(limit=limit),
        "voice": commentary_module.voice_status(),
    }
