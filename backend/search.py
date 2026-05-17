"""Multimodal search + LLM-driven Ask.

Three index types are surfaced through the `kind` parameter:

- **visual**   → scene index. VOD reads `state.vod_scene_index_id` directly;
                  RTStream reads the rtstream namespace.
- **transcript** → spoken-word index. VOD calls
                  `video.search(index_type=spoken_word, search_type=semantic)`;
                  RTStream reads the rtstream `spoken_word` namespace.
- **audio**     → only meaningful for RTStream (`rt.index_audio`). The VOD
                  path does NOT have a separate audio index in the SDK; the
                  route layer rejects `kind=audio` for VOD with HTTP 400.

The Ask path (`synthesize_answer`) is end-to-end LLM-driven:

1. **Query rewrite** — `coll.generate_text` rewrites the question into 3
   concrete search phrases.
2. **Multi-rail search** — every phrase runs against scene + spoken_word in
   parallel; results merged by ``(start, end)`` keeping the highest score.
3. **LLM compose** — a single `coll.generate_text` call composes the
   scout-grade answer over the deduped evidence.

There are **no static synonym tables, plural-form overrides, or heuristic
answer composers** in this module. The fallback when the LLM is unavailable
is plain evidence formatting — `[MM:SS] · raw summary` bullets — which is
not a "rule" but a presentation of raw model output.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from videodb import IndexType, SearchType
from videodb.exceptions import InvalidRequestError

from . import pipeline

log = logging.getLogger("search")

SUPPORTED_KINDS = ("visual", "audio", "transcript")


# ──────────────────────────────────────────────────────────────────────────
# Routing helpers
# ──────────────────────────────────────────────────────────────────────────

_RTSTREAM_NAMESPACE_FOR = {
    "visual": "scene",
    "audio": "audio",
    "transcript": "spoken_word",
}


def _vod_kwargs(kind: str, state: Any) -> dict[str, Any]:
    """video.search() kwargs by kind. Raises ValueError on unsupported → route returns 400."""
    if kind == "visual":
        kwargs: dict[str, Any] = {
            "search_type": SearchType.semantic,
            "index_type": IndexType.scene,
            "score_threshold": 0.2,
        }
        if state.vod_scene_index_id:
            kwargs["scene_index_id"] = state.vod_scene_index_id
        return kwargs
    if kind == "transcript":
        # spoken_word supports semantic OR keyword; semantic + LLM rewrite gives best NL recall.
        return {
            "search_type": SearchType.semantic,
            "index_type": IndexType.spoken_word,
        }
    raise ValueError(
        f"VOD does not support search kind={kind!r}; "
        "use 'visual' or 'transcript'."
    )


def _rtstream_kwargs(kind: str, *, threshold: int) -> dict[str, Any]:
    namespace = _RTSTREAM_NAMESPACE_FOR.get(kind)
    if namespace is None:
        raise ValueError(f"unsupported RTStream search kind={kind!r}")
    return {
        "namespace": "rtstream",
        "index_type": namespace,
        "result_threshold": threshold,
    }


def _shot_to_dict(shot: Any) -> dict[str, Any]:
    try:
        stream_url = shot.generate_stream()
    except Exception:  # noqa: BLE001
        stream_url = None
    return {
        "rtstream_id": getattr(shot, "rtstream_id", None),
        "rtstream_name": getattr(shot, "rtstream_name", None),
        "start": getattr(shot, "start", None),
        "end": getattr(shot, "end", None),
        "text": getattr(shot, "text", None),
        "score": getattr(shot, "search_score", None),
        "stream_url": stream_url,
    }


def _search_sync(query: str, kind: str, threshold: int) -> list[dict[str, Any]]:
    state = pipeline.state
    if state.video_id is None and state.rtstream_id is None:
        return []
    coll = state.coll
    if coll is None:
        return []

    # ---- VOD path ----
    if state.video_id is not None and state.video is not None:
        kwargs = _vod_kwargs(kind, state)
        kwargs["query"] = query
        try:
            result = state.video.search(**kwargs)
        except InvalidRequestError as e:
            if "No results found" in str(e):
                return []
            raise
        return [_shot_to_dict(s) for s in result.get_shots()]

    # ---- Live RTStream path ----
    kwargs = _rtstream_kwargs(kind, threshold=threshold)
    kwargs["query"] = query
    try:
        result = coll.search(**kwargs)
    except InvalidRequestError as e:
        if "No results found" in str(e):
            return []
        raise

    out: list[dict[str, Any]] = []
    active_rtstream = state.rtstream_id
    for shot in result.get_shots():
        shot_rtstream_id = getattr(shot, "rtstream_id", None)
        if active_rtstream and shot_rtstream_id and shot_rtstream_id != active_rtstream:
            continue
        out.append(_shot_to_dict(shot))
    return out


async def search(
    *, query: str, kind: str = "visual", threshold: int = 10,
) -> list[dict[str, Any]]:
    """Public Search API. Validates kind + per-source-mode availability."""
    if kind not in SUPPORTED_KINDS:
        raise ValueError(f"unknown search kind: {kind}")
    state = pipeline.state
    if state.video_id is not None and state.video is not None and kind == "audio":
        raise ValueError(
            "audio search not supported for VOD; use 'visual' or 'transcript'"
        )
    return await asyncio.to_thread(_search_sync, query, kind, threshold)


# ──────────────────────────────────────────────────────────────────────────
# LLM-driven Ask
# ──────────────────────────────────────────────────────────────────────────

def _generate_text_kwargs(prompt: str) -> dict[str, Any]:
    """coll.generate_text kwargs. SDK only accepts model_name ∈ {basic, pro, ultra}."""
    state = pipeline.state
    return {
        "prompt": prompt,
        "model_name": "ultra" if state.sandbox_id else "basic",
    }


def _unwrap_generate_text(result: Any) -> str | None:
    """Normalise generate_text response. Hackathon SDK returns {"output": "..."} not bare str."""
    if isinstance(result, str):
        s = result.strip()
        return s or None
    if isinstance(result, dict):
        for key in ("output", "text", "response"):
            v = result.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


async def _llm_call(prompt: str, *, timeout: float) -> str | None:
    """coll.generate_text with wall-clock timeout. None on timeout/error/empty."""
    coll = pipeline.state.coll
    if coll is None:
        return None
    kwargs = _generate_text_kwargs(prompt)

    def _call():
        return coll.generate_text(**kwargs)

    try:
        result = await asyncio.wait_for(asyncio.to_thread(_call), timeout=timeout)
    except asyncio.TimeoutError:
        log.warning("generate_text timed out (%.1fs)", timeout)
        return None
    except Exception as e:  # noqa: BLE001
        log.warning("generate_text error %s", type(e).__name__)
        return None
    return _unwrap_generate_text(result)


async def _rewrite_query(query: str) -> list[str]:
    """LLM rewrites the question into 3 concrete search phrases. Falls back to raw query."""
    prompt = (
        "You are a search-query rewriter for a football-match scene index. "
        "Rewrite the user's question into exactly three short concrete search "
        "phrases (one per line, no numbering, no preamble) that would match "
        "indexed scene descriptions. Use precise football vocabulary. If the "
        "question is already a concrete cue, repeat it as the first line and "
        "supply two close variants for the next two.\n\n"
        f"Question: {query}\n\n"
        "Three phrases:"
    )
    raw = await _llm_call(prompt, timeout=8.0)
    if not raw:
        return [query]
    lines = [
        ln.strip().lstrip("-•0123456789. )")
        for ln in raw.splitlines()
        if ln.strip()
    ]
    # Always include the raw query so we don't lose recall. Cap at 4.
    out: list[str] = [query]
    for ln in lines:
        if ln and ln.lower() != query.lower() and ln not in out:
            out.append(ln)
        if len(out) >= 4:
            break
    return out


def _fmt_ts(seconds: float | int | None) -> str:
    if not seconds:
        return "0:00"
    s = int(seconds)
    return f"{s // 60}:{s % 60:02d}"


def _parse_shot(shot: dict[str, Any]) -> dict[str, Any]:
    """Parse a scene's JSON-shaped `text`. Strips ```json fences the model adds despite prompt."""
    text = (shot.get("text") or "").strip()
    if not text:
        return {}
    candidate = text
    import re as _re
    fence = _re.match(r"^```(?:json)?\s*(.*?)\s*```$", candidate, flags=_re.DOTALL)
    if fence:
        candidate = fence.group(1)
    if candidate.startswith("`") and candidate.endswith("`") and len(candidate) > 2:
        candidate = candidate[1:-1].strip()
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, ValueError):
        pass
    first = candidate.find("{")
    last = candidate.rfind("}")
    if first != -1 and last > first:
        try:
            parsed = json.loads(candidate[first : last + 1])
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
    return {"summary": text[:240]}


def _is_meaningful_evidence(s: dict[str, Any]) -> bool:
    """Drop event_type=none/scene placeholders, raw-JSON parse-fails, and empty rows.
    Transcript rows (no event_type) pass when they have text."""
    raw = (s.get("text") or "").strip()
    if not raw:
        return False
    parsed = _parse_shot(s)
    et = (parsed.get("event_type") or "").strip().lower()
    summary = (parsed.get("summary") or "").strip()
    if not et and summary:
        return True
    if not et and not summary:
        return not raw.startswith("{")
    if et in ("none", "scene"):
        return False
    return True


def _build_evidence_body(evidence: list[dict[str, Any]]) -> str:
    """Format up-to-8 evidence rows into a `[MM:SS] · summary` block."""
    snippets: list[str] = []
    for i, s in enumerate(evidence[:8]):
        parsed = _parse_shot(s)
        ts = _fmt_ts(s.get("start"))
        et = parsed.get("event_type") or "scene"
        team = parsed.get("team") or "unknown"
        team_str = f" · {team}" if team and team != "unknown" else ""
        summary = (parsed.get("summary") or "").strip()
        if not summary:
            summary = ((s.get("text") or "").replace("\n", " ").strip())[:200]
        snippets.append(f"[{i+1}] {ts} · {et}{team_str} — {summary}")
    return "\n".join(snippets) or "(no evidence available)"


def _evidence_only_fallback(evidence: list[dict[str, Any]]) -> str:
    """Plain timestamp listing for when the LLM is unavailable. Score-sorted, top 5."""
    if not evidence:
        return ""
    cleaned = [s for s in evidence if _is_meaningful_evidence(s)]
    sorted_shots = sorted(
        cleaned,
        key=lambda s: float(s.get("score") or 0.0),
        reverse=True,
    )[:5]
    bullets: list[str] = []
    for s in sorted_shots:
        parsed = _parse_shot(s)
        ts = _fmt_ts(s.get("start"))
        et = (parsed.get("event_type") or "").strip().replace("_", " ")
        team = (parsed.get("team") or "").strip()
        team_str = f" · {team}" if team and team != "unknown" else ""
        summary = (parsed.get("summary") or "").strip()
        if not summary:
            summary = ((s.get("text") or "").replace("\n", " ").strip())[:200]
        # Skip if the summary still looks like a JSON envelope.
        if summary.startswith("{") or '"event_type"' in summary:
            continue
        head = f"[{ts}]"
        if et and et != "none":
            head += f" · {et}"
        head += team_str
        bullets.append(f"{head} — {summary}")
    if not bullets:
        return ""
    return "\n• ".join([""] + bullets).lstrip()


class LLMComposeFailed(Exception):
    """Raised when both compose attempts time out/error → route layer → HTTP 503.
    Ask must come from an LLM grounded on the indexes; never substitute evidence."""


async def _llm_compose(query: str, evidence: list[dict[str, Any]]) -> str:
    """Compose the scout-grade answer. Two attempts: 12s tight, then 25s slack for cold sandbox."""
    if not evidence:
        return ""
    prompt = (
        "You are DataCaster, an AI football analyst writing for a "
        "professional scout at a sportsbook / data-collection company "
        "(Sportradar, Stats Perform). Reader is technical and time-poor.\n\n"
        "How to answer:\n"
        "1. Lead with the direct answer (yes/no, or specific count) in the "
        "first sentence.\n"
        "2. Quote in-video timestamps as [MM:SS] for every claim. Multiple "
        "timestamps per claim are fine.\n"
        "3. If the question is open-ended, structure the reply as 2-4 "
        "bullets, each leading with [MM:SS] and a one-line takeaway.\n"
        "4. Note the team when known. When unknown, say 'team unidentified'.\n"
        "5. Do NOT speculate beyond the evidence. If evidence doesn't support "
        "a confident answer, say so plainly.\n"
        "6. Use precise football vocabulary, not commentary fluff.\n\n"
        "Output: 2-5 sentences OR a 2-4 bullet list. No preamble. No 'based "
        "on the evidence' filler. Plain prose with inline [MM:SS] citations.\n\n"
        f"Scout's question: {query}\n\n"
        "Evidence (timestamp · event-type · description):\n"
        f"{_build_evidence_body(evidence)}\n\n"
        "Scout-grade answer:"
    )
    out = await _llm_call(prompt, timeout=12.0)
    if out:
        return out[:1200]
    log.info("compose attempt 1 failed; retrying with 25s timeout")
    out = await _llm_call(prompt, timeout=25.0)
    if out:
        return out[:1200]
    raise LLMComposeFailed("compose call timed out / errored on both tries")


async def synthesize_answer(
    *, query: str, threshold: int = 6,
) -> dict[str, Any]:
    """Ask flow: LLM rewrite → parallel multi-rail search → merge by (start,end) → LLM compose."""
    rewritten = await _rewrite_query(query)
    log.info("synthesize_answer: query=%r rewrote=%r", query, rewritten)

    state = pipeline.state
    rails: list[str]
    if state.video_id is not None and state.video is not None:
        # VOD: scene + spoken_word.
        rails = ["visual"]
        if state.transcript_index_id:
            rails.append("transcript")
    elif state.rtstream_id is not None:
        # RTStream: scene + spoken_word + audio.
        rails = ["visual", "transcript", "audio"]
    else:
        return {"query": query, "answer": "", "evidence": []}

    async def _bounded_one(q: str, kind: str) -> list[dict[str, Any]]:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_search_sync, q, kind, threshold),
                timeout=10.0,
            )
        except asyncio.TimeoutError:
            log.warning("ask rail %s for %r timed out", kind, q)
            return []
        except Exception as e:  # noqa: BLE001
            log.warning("ask rail %s for %r failed: %s", kind, q, e)
            return []

    async def _bounded(kind: str) -> list[dict[str, Any]]:
        per_query = await asyncio.gather(*[_bounded_one(q, kind) for q in rewritten])
        merged: dict[tuple[float | None, float | None], dict[str, Any]] = {}
        for hits in per_query:
            for s in hits:
                key = (s.get("start"), s.get("end"))
                prior = merged.get(key)
                if (prior is None or float(s.get("score") or 0.0)
                        > float(prior.get("score") or 0.0)):
                    merged[key] = s
        return list(merged.values())

    rail_results = await asyncio.gather(*[_bounded(r) for r in rails])
    flat: list[dict[str, Any]] = []
    for rail, hits in zip(rails, rail_results):
        for s in hits:
            s["kind"] = rail
        flat.extend(hits)
    # Drop none/scene placeholders — semantic similarity is broad and they hallucinate the LLM.
    flat = [s for s in flat if _is_meaningful_evidence(s)]
    flat.sort(key=lambda s: float(s.get("score") or 0.0), reverse=True)
    answer = await _llm_compose(query, flat)
    return {
        "query": query,
        "answer": answer,
        "evidence": flat[: threshold * 2],
    }
