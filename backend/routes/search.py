"""GET /api/search?q=...&kind=visual|audio|transcript"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import search as search_module

router = APIRouter()


@router.get("/api/search")
async def search(
    q: str = Query(..., min_length=1),
    kind: str = Query("visual"),
    threshold: int = Query(10, ge=1, le=50),
):
    try:
        shots = await search_module.search(query=q, kind=kind, threshold=threshold)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"search failed: {e}") from e
    return {"q": q, "kind": kind, "shots": shots}
