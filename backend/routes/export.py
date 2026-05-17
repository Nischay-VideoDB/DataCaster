"""Download endpoints: events / commentary / highlights as JSON or JSONL."""

from __future__ import annotations

import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import db

router = APIRouter()


def _ts_suffix() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


@router.get("/api/export/events")
async def export_events():
    """Download events as a single JSON array."""
    rows = await db.list_events(limit=100000)
    return JSONResponse(
        content={"events": rows},
        headers={
            "Content-Disposition": f'attachment; filename="datacaster-events-{_ts_suffix()}.json"',
        },
    )


@router.get("/api/export/commentary")
async def export_commentary():
    items = await db.list_commentary(limit=10000)
    return JSONResponse(
        content={"items": items},
        headers={
            "Content-Disposition": f'attachment; filename="datacaster-commentary-{_ts_suffix()}.json"',
        },
    )


@router.get("/api/export/highlights")
async def export_highlights():
    items = await db.list_highlights(limit=1000)
    return JSONResponse(
        content={"items": items},
        headers={
            "Content-Disposition": f'attachment; filename="datacaster-highlights-{_ts_suffix()}.json"',
        },
    )
