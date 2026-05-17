"""Generate broadcast-style commentary (script + voice) for high-impact events.

Cost note
---------
Each high-impact event now costs TWO model calls:
  1. ``coll.generate_text`` (model_name="basic") — turns a single classified
     event + recent context into a 60-100 word broadcast script.
  2. ``coll.generate_voice`` (OmniVoice in sandbox, default provider otherwise)
     — synthesises that script into ~30 seconds of audio.

With ``COMMENTARY_MIN_CONFIDENCE = 0.5`` and a 30-min match running, this can
add up. Watch sandbox credit burn during demos. The fallback template gives
us a graceful degradation path when ``generate_text`` rate-limits or fails.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from . import db, pipeline
from .config import (
    COMMENTARY_EVENT_TYPES, COMMENTARY_MIN_CONFIDENCE, USE_SANDBOX, VOICE_MODEL,
)
from .events_bus import bus
from .prompts import (
    COMMENTARY_FALLBACK_TEMPLATE,
    COMMENTARY_SCRIPT_TEMPLATE,
    COMMENTARY_STYLES,
)

log = logging.getLogger("commentary")

# In-flight idempotency: never generate two voice clips for the same event id.
_in_flight: set[int] = set()

# Hard cap on TTS input length — OmniVoice gets unhappy past ~600 chars.
_SCRIPT_MAX_CHARS = 600

# Voice generation is per-account quota-gated. On trip, every event fails identically.
# Throttle: warn once/min, enter 5-min backoff after 3 consecutive failures (script-only
# rows during backoff, auto-retry after). Counters reset on stop().
_last_voice_warning_ts: float = 0.0
_voice_consecutive_failures: int = 0
_voice_backoff_until: float = 0.0  # 0 = not in backoff
_VOICE_BACKOFF_S: float = 300.0


def reset_voice_state() -> None:
    """Clear voice throttle/backoff. Safe to call from pipeline.stop."""
    global _last_voice_warning_ts, _voice_consecutive_failures, _voice_backoff_until
    _last_voice_warning_ts = 0.0
    _voice_consecutive_failures = 0
    _voice_backoff_until = 0.0


def voice_status() -> dict[str, Any]:
    """Snapshot of the voice gate. Read by /api/commentary/track."""
    now = time.time()
    in_backoff = _voice_backoff_until > now
    return {
        "available": not in_backoff,
        "consecutive_failures": _voice_consecutive_failures,
        "backoff_remaining_s": max(0.0, _voice_backoff_until - now) if in_backoff else 0.0,
    }


def _humanise(event_type: str | None) -> str:
    return (event_type or "moment").replace("_", " ").strip() or "moment"


def _format_recent_context(recent: list[dict[str, Any]]) -> str:
    if not recent:
        return "(no prior events)"
    lines = []
    for r in recent:
        et = r.get("event_type") or "event"
        summ = (r.get("summary") or "").strip() or "(no summary)"
        lines.append(f"- {et}: {summ}")
    return "\n".join(lines)


def _fallback_script(evt: dict[str, Any]) -> str:
    event_type_human = _humanise(evt.get("event_type"))
    team = (evt.get("team") or "home").strip() or "home"
    summary = (evt.get("summary") or "").strip() or f"A {event_type_human} unfolds on the pitch."
    return COMMENTARY_FALLBACK_TEMPLATE.format(
        event_type_human=event_type_human,
        team=team,
        team_capitalised=team.capitalize(),
        summary=summary,
    )


def _generate_text_sync(prompt: str) -> str:
    """coll.generate_text wrapper. SDK only accepts model_name ∈ {basic, pro, ultra}."""
    coll = pipeline.state.coll
    if coll is None:
        raise RuntimeError("pipeline not started")
    model = "ultra" if pipeline.state.sandbox_id else "basic"
    out = coll.generate_text(prompt=prompt, model_name=model)
    if isinstance(out, dict):
        # SDK returns {"output": "..."} for basic/ultra; older endpoints used "text"/"response".
        for key in ("output", "text", "response"):
            v = out.get(key)
            if isinstance(v, str) and v.strip():
                return v
        return ""
    return out or ""


async def _build_script(evt: dict[str, Any], recent_events: list[dict[str, Any]]) -> str:
    """Produce the broadcast text. Always returns a non-empty string."""
    prompt = COMMENTARY_SCRIPT_TEMPLATE.format(
        event_type=evt.get("event_type") or "unknown",
        team=evt.get("team") or "unknown",
        summary=evt.get("summary") or "(no summary)",
        confidence=evt.get("confidence") if evt.get("confidence") is not None else "n/a",
        recent_context=_format_recent_context(recent_events),
    )
    script: str = ""
    try:
        script = await asyncio.to_thread(_generate_text_sync, prompt)
        script = (script or "").strip()
    except Exception as e:  # noqa: BLE001
        log.warning("generate_text failed, using fallback: %s", e)
        script = ""

    if not script:
        script = _fallback_script(evt)

    if len(script) > _SCRIPT_MAX_CHARS:
        # Truncate at a sentence boundary so OmniVoice doesn't cut mid-word.
        cut = script[:_SCRIPT_MAX_CHARS]
        for sep in (". ", "! ", "? "):
            idx = cut.rfind(sep)
            if idx > _SCRIPT_MAX_CHARS - 200:
                cut = cut[: idx + 1]
                break
        script = cut.rstrip()

    return script


def _generate_voice_sync(text: str, style: str) -> dict[str, Any]:
    coll = pipeline.state.coll
    if coll is None:
        raise RuntimeError("pipeline not started")

    instructions = COMMENTARY_STYLES.get(style, COMMENTARY_STYLES["excited"])
    kwargs: dict[str, Any] = {"text": text, "wait": True}
    if USE_SANDBOX:
        kwargs["model_name"] = VOICE_MODEL
        kwargs["sandbox_id"] = pipeline.state.sandbox_id
        kwargs["config"] = {"instructions": instructions}
    # else: rely on the default voice provider (elevenlabs) — no instructions param
    audio = coll.generate_voice(**kwargs)

    # Audio object: try generate_url(), fall back to common attrs.
    url = None
    for attr in ("generate_url", "stream_url", "url"):
        v = getattr(audio, attr, None)
        if callable(v):
            try:
                url = v()
                break
            except Exception:  # noqa: BLE001
                continue
        elif isinstance(v, str):
            url = v
            break
    return {"id": getattr(audio, "id", None), "url": url, "length": getattr(audio, "length", None)}


async def generate_for_event(event_id: int, *, style: str = "excited") -> dict[str, Any]:
    if event_id in _in_flight:
        return {"status": "already_running"}
    evt = await db.get_event(event_id)
    if not evt:
        return {"status": "not_found"}

    _in_flight.add(event_id)
    try:
        # Last 4 events minus the current; cap at 3 for the prompt.
        try:
            recent = await db.list_events(limit=4)
        except Exception as e:  # noqa: BLE001
            log.warning("list_events failed, proceeding without context: %s", e)
            recent = []
        recent = [r for r in recent if r.get("id") != event_id][:3]

        # 1. Build the script — text-only rows are better than silence when voice is capped.
        script = await _build_script(evt, recent)

        # 2. Try voice synthesis with backoff after repeated failures.
        global _last_voice_warning_ts, _voice_consecutive_failures, _voice_backoff_until
        result: dict[str, Any] = {"id": None, "url": None, "length": None}
        audio_url = ""
        now = time.time()
        in_backoff = _voice_backoff_until > now
        if not in_backoff:
            try:
                result = await asyncio.to_thread(_generate_voice_sync, script, style)
                audio_url = result.get("url") or ""
                _voice_consecutive_failures = 0
                _voice_backoff_until = 0.0
            except Exception as e:  # noqa: BLE001
                _voice_consecutive_failures += 1
                now = time.time()
                if now - _last_voice_warning_ts >= 60:
                    log.warning(
                        "generate_voice failed (%s) — saving script-only commentary; consecutive=%d",
                        type(e).__name__, _voice_consecutive_failures,
                    )
                    _last_voice_warning_ts = now
                if _voice_consecutive_failures >= 3:
                    _voice_backoff_until = now + _VOICE_BACKOFF_S
                    log.warning(
                        "voice generation entering %.0fs backoff after %d consecutive failures",
                        _VOICE_BACKOFF_S, _voice_consecutive_failures,
                    )

        # 3. Persist unconditionally — text-only rows still populate the panel.
        commentary_id = 0
        try:
            commentary_id = await db.insert_commentary(
                event_id=event_id, text=script, audio_url=audio_url,
                voice_style=style, created_at=time.time(),
            )
            log.info(
                "commentary stored id=%d event_id=%d audio=%s len=%d",
                commentary_id, event_id, "yes" if audio_url else "script-only",
                len(script),
            )
        except Exception as e:  # noqa: BLE001
            log.error("insert_commentary failed for event_id=%d: %s", event_id, e)

        # 4. Bus-publish so SSE notifies the frontend.
        bus.publish({
            "type": "commentary",
            "event_id": event_id,
            "commentary_id": commentary_id,
            "text": script,
            "audio_url": audio_url or None,
            "style": style,
        })
        return {"status": "ok", "commentary_id": commentary_id, "text": script, **result}
    finally:
        _in_flight.discard(event_id)


async def commentary_worker(stop: asyncio.Event) -> None:
    """Subscribe to the bus; fire generate_for_event for high-impact football events.
    Skipped in describe mode — generic events don't warrant broadcast narration."""
    q = bus.subscribe(maxsize=400)
    try:
        while not stop.is_set():
            try:
                msg = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            if msg.get("type") != "event":
                continue
            # Live-read content_type so a restart in describe mode disables this without bouncing the worker.
            if pipeline.state.content_type != "football":
                continue
            evt = msg.get("event", {})
            if (evt.get("event_type") in COMMENTARY_EVENT_TYPES
                    and (evt.get("confidence") or 0) >= COMMENTARY_MIN_CONFIDENCE):
                event_id = evt.get("id")
                if not event_id:
                    continue
                # spawn in background so the worker keeps draining
                asyncio.create_task(generate_for_event(event_id))
    finally:
        bus.unsubscribe(q)
