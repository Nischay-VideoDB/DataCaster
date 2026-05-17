"""Tail the VideoDB events JSONL, classify each line, persist + publish.

The JSONL file is appended by .claude/skills/videodb/scripts/ws_listener.py.
We tail forward-only, with a byte offset checkpoint so the worker can restart
without losing or replaying lines.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

import aiofiles

from . import db
from .config import CLASSIFIER_OFFSET_FILE, EVENTS_FILE, EVENT_VOCAB
from .events_bus import bus

log = logging.getLogger("classifier")

OFFSET_FILE = CLASSIFIER_OFFSET_FILE

# Allow {"foo": ...}, ```json {...}```, or freeform text containing the JSON.
_JSON_BLOCK = re.compile(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", re.DOTALL)
_FOOTBALL_TYPES = set(EVENT_VOCAB.keys()) | {"none"}


def _valid_types() -> set[str]:
    """Football-only vocabulary."""
    return set(EVENT_VOCAB.keys()) | {"none"}


def _extract_json_dict(text: str) -> dict[str, Any] | None:
    """Best-effort parse of a JSON object from text. Tries direct json.loads, then first {...} block."""
    text = text.strip()
    if not text:
        return None

    # strip ```json ... ``` fences (with or without language tag)
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass

    m = _JSON_BLOCK.search(text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _classify_scene(payload: dict[str, Any], unix_ts: float) -> dict[str, Any] | None:
    """`scene_index`/`visual_index` payload → DataCasterEvent (football schema: event_type + team)."""
    text = payload.get("data", {}).get("text") or payload.get("text")
    if not isinstance(text, str):
        return None
    parsed = _extract_json_dict(text)
    if not parsed:
        return None

    et = parsed.get("event_type")
    if not isinstance(et, str) or et not in _FOOTBALL_TYPES or et == "none":
        return None
    confidence = float(parsed.get("confidence", 0.0))
    if confidence < 0.4:
        return None
    return {
        "unix_ts": unix_ts,
        "event_type": et,
        "confidence": confidence,
        "team": parsed.get("team", "unknown"),
        "summary": (parsed.get("summary") or "").strip()[:240],
        "raw_json": parsed,
        "source": "visual",
    }


def _classify_alert(payload: dict[str, Any], unix_ts: float) -> dict[str, Any] | None:
    """High-precision rail: alerts produced by create_event/create_alert."""
    data = payload.get("data") or {}
    label = data.get("event_label") or data.get("label")
    if not isinstance(label, str) or label not in EVENT_VOCAB:
        return None
    return {
        "unix_ts": unix_ts,
        "event_type": label,
        "confidence": float(data.get("confidence", 0.95)),
        "team": "unknown",
        "summary": data.get("text") or data.get("explanation") or label.replace("_", " "),
        "raw_json": data,
        "source": "alert",
    }


def _classify_audio(payload: dict[str, Any], unix_ts: float) -> dict[str, Any] | None:
    """Audio rail (football): surfaces crowd-intensity moments."""
    text = payload.get("data", {}).get("text") or payload.get("text")
    if not isinstance(text, str):
        return None
    parsed = _extract_json_dict(text)
    if not parsed:
        return None

    intensity = float(parsed.get("crowd_intensity", 0.0))
    excitement = parsed.get("commentator_excitement", "calm")
    if intensity < 0.6 and excitement == "calm":
        return None  # uneventful, skip
    hint = parsed.get("likely_event_hint", "none")
    return {
        "unix_ts": unix_ts,
        "event_type": "audio_signal",
        "confidence": intensity,
        "team": "unknown",
        "summary": f"Crowd {excitement} (hint: {hint})",
        "raw_json": parsed,
        "source": "audio",
    }


async def _persist_and_publish(evt: dict[str, Any]) -> None:
    event_id = await db.insert_event(**evt)
    payload = {**evt, "id": event_id}
    bus.publish({"type": "event", "event": payload})


async def _process_line(raw: str) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return
    channel = msg.get("channel", "")
    unix_ts = float(msg.get("unix_ts") or 0.0)

    evt: dict[str, Any] | None = None
    # Live channels are named visual_index / audio_index (not scene_index).
    if channel in ("visual_index", "scene_index"):
        evt = _classify_scene(msg, unix_ts)
    elif channel == "alert":
        evt = _classify_alert(msg, unix_ts)
    elif channel == "audio_index":
        evt = _classify_audio(msg, unix_ts)
    # transcript is forwarded to the bus directly (not stored as DC events)
    elif channel == "transcript":
        text = msg.get("data", {}).get("text", "")
        if text:
            bus.publish({"type": "transcript", "ts": unix_ts, "text": text})
        return

    if evt:
        await _persist_and_publish(evt)


async def tail_jsonl_forever(stop: asyncio.Event) -> None:
    """Tail the WS-listener JSONL forward, restart-safe; handles truncation + inode change."""
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    offset = 0
    inode: int | None = None

    # Recover prior offset only if the same inode + larger file exists.
    if OFFSET_FILE.exists() and EVENTS_FILE.exists():
        try:
            offset = int(OFFSET_FILE.read_text().strip() or "0")
            st = EVENTS_FILE.stat()
            inode = st.st_ino
            if offset > st.st_size:
                offset = 0  # truncation since last run
        except (OSError, ValueError):
            offset = 0

    while not stop.is_set():
        if not EVENTS_FILE.exists():
            await asyncio.sleep(0.5)
            continue
        try:
            # Detect inode change (file was rotated/recreated)
            cur_inode = EVENTS_FILE.stat().st_ino
            cur_size = EVENTS_FILE.stat().st_size
            if inode is not None and cur_inode != inode:
                log.info("jsonl inode changed; resetting offset")
                offset = 0
            elif offset > cur_size:
                log.info("jsonl shrank (truncate); resetting offset")
                offset = 0
            inode = cur_inode

            async with aiofiles.open(EVENTS_FILE, "r") as f:
                await f.seek(offset)
                # Read until current EOF, then close+reopen on next pass
                while not stop.is_set():
                    line = await f.readline()
                    if not line:
                        offset = await f.tell()
                        OFFSET_FILE.write_text(str(offset))
                        break  # close handle; next loop iteration reopens
                    await _process_line(line)
            await asyncio.sleep(0.25)
        except FileNotFoundError:
            await asyncio.sleep(0.5)
        except Exception as e:  # noqa: BLE001
            log.exception("tail_jsonl_forever recovered: %s", e)
            await asyncio.sleep(1.0)
