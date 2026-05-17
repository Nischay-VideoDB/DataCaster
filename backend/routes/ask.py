"""AskBar / Q&A route:
    POST /api/ask  — synthesize an answer (with evidence shots) from indexed events.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from pydantic import BaseModel

from ..search import LLMComposeFailed, synthesize_answer

router = APIRouter()
log = logging.getLogger("routes.ask")


class AskPayload(BaseModel):
    q: str
    threshold: int = 6


@router.post("/api/ask")
async def ask(payload: AskPayload):
    try:
        return await synthesize_answer(query=payload.q, threshold=payload.threshold)
    except LLMComposeFailed as e:
        # Ask answers must come from the LLM grounded on the indexes; on failure return 503 so the UI can show a Retry.
        log.warning("/api/ask LLM compose failed: %s", e)
        raise HTTPException(
            status_code=503,
            detail=(
                "Ask is temporarily unavailable — the LLM didn't respond in "
                "time. Try again in a few seconds."
            ),
        ) from e
