"""VOD (pre-recorded video) scene polling worker.

Polls `video.get_scene_index(scene_index_id)`, parses each newly-arrived
scene's JSON-shaped output, validates it through an LLM ("does the summary
name a specific cue?"), and publishes the survivor to the same bus + SQLite
the live RTStream path uses.

Design intent (DataCaster v5 — strict-purge LLM-driven):

- **No hardcoded confidence floors.** The vision model self-reports a
  confidence; any non-zero confidence with a vocab-valid event_type passes
  the structural filter.
- **No regex tuple of "generic summary tells".** A second LLM call asks
  whether the model's own summary names a concrete visible cue (player
  action, ball position, score graphic change). If the model says no, we
  drop the event.
- **One temporal dedupe window.** A simple 30s same-`event_type` guard
  keeps replay angles + score-graphic redraws from firing the same goal
  three times. This is structural (no replay double-fires), not a vocab-
  or threshold-tied rule.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from videodb.exceptions import InvalidRequestError

from . import db, pipeline
from .classifier import _extract_json_dict
from .config import VOCAB_BY_MODE
from .events_bus import bus

log = logging.getLogger("vod")

# Single dedupe window across all event types. Keyed by (event_type, team)
# so home and away events of the same type within the window survive.
_DEDUPE_WINDOW_S = 30.0


def _vocab_for(content_type: str) -> set[str]:
    return set(VOCAB_BY_MODE.get(content_type, {}).keys()) | {"none"}


def _generate_text_sync(prompt: str) -> str | None:
    """Sync coll.generate_text wrapper.

    The hackathon SDK only accepts `model_name` ∈ {basic, pro, ultra}; it
    does NOT route via `sandbox_id` for text generation. Use `ultra` when
    a sandbox is allocated, `basic` otherwise.
    """
    coll = pipeline.state.coll
    if coll is None:
        return None
    model = "ultra" if pipeline.state.sandbox_id else "basic"
    try:
        out = coll.generate_text(prompt=prompt, model_name=model)
    except Exception as e:  # noqa: BLE001
        log.warning("vod generate_text error %s", type(e).__name__)
        return None
    if isinstance(out, str):
        return out.strip() or None
    if isinstance(out, dict):
        # SDK returns {"output": "..."} for basic/ultra; older endpoints used "text"/"response".
        for key in ("output", "text", "response"):
            v = out.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


async def _llm_validates_summary(event_type: str, summary: str) -> bool:
    """LLM yes/no check: does the summary name a concrete visible cue?

    This replaces the v4 `_GENERIC_SUMMARY_TELLS` regex tuple. Timeout is
    12s — `coll.generate_text(model_name="ultra")` returns in ~6s on warm
    runs, but cold sandboxes plus medium-tier queueing can push it past
    4s on early calls. Default behaviour on timeout is DROP, not keep,
    so a wedged LLM doesn't silently flood the timeline with unvalidated
    "generic moment" events.
    """
    if not summary:
        return False
    prompt = (
        "You are a fact-checker for a football scene classifier. The "
        "vision model just emitted this:\n\n"
        f"  event_type: {event_type}\n"
        f"  summary: {summary}\n\n"
        "Does the summary cite a specific visible cue (player action, "
        "ball position, on-screen graphic change) that supports the "
        "event_type? Reply only one word: yes or no."
    )
    try:
        raw = await asyncio.wait_for(
            asyncio.to_thread(_generate_text_sync, prompt),
            timeout=12.0,
        )
    except asyncio.TimeoutError:
        log.info("vod validator timed out — dropping event")
        return False
    if raw is None:
        # LLM errored — drop event to avoid surfacing unvalidated classifications.
        log.info("vod validator returned None — dropping event")
        return False
    return raw.lower().lstrip().startswith("y")


def _structural_classify(
    text: str, unix_ts: float, content_type: str = "football",
) -> dict[str, Any] | None:
    """Structural filter only: vocab membership + non-"none" + non-zero confidence."""
    parsed = _extract_json_dict(text)
    if not parsed:
        return None
    et = parsed.get("event_type")
    valid = _vocab_for(content_type)
    if not isinstance(et, str) or et not in valid or et == "none":
        return None
    confidence = float(parsed.get("confidence", 0.0))
    if confidence <= 0.0:
        return None
    summary = (parsed.get("summary") or "").strip()[:240]
    return {
        "unix_ts": unix_ts,
        "event_type": et,
        "confidence": confidence,
        "team": parsed.get("team", "unknown"),
        "summary": summary,
        "raw_json": parsed,
        "source": "visual",
    }


class _Deduper:
    """Temporal guard: rejects same-(event_type, team) repeats within
    ``_DEDUPE_WINDOW_S``. Goals additionally cross-team-dedupe so a goal
    classified as (home), (unknown), (away) across the live → replay →
    graphic sequence doesn't fire three times.
    """

    def __init__(self) -> None:
        self._last: dict[tuple[str, str], float] = {}

    def accept(self, evt: dict[str, Any]) -> bool:
        et = str(evt["event_type"])
        team = str(evt.get("team") or "unknown")
        ts = float(evt["unix_ts"])

        prior = self._last.get((et, team))
        if prior is not None and ts - prior < _DEDUPE_WINDOW_S:
            return False

        if et == "goal":
            for (k_et, k_team), k_ts in self._last.items():
                if k_et == "goal" and ts - k_ts < _DEDUPE_WINDOW_S:
                    return False

        self._last[(et, team)] = ts
        return True


async def _persist_and_publish(evt: dict[str, Any], *, video_id: str | None = None) -> None:
    event_id = await db.insert_event(**evt, video_id=video_id)
    payload = {**evt, "id": event_id, "video_id": video_id}
    bus.publish({"type": "event", "event": payload})


async def poll_scene_index_forever(
    *,
    state: Any,
    stop: asyncio.Event,
    poll_interval_s: float = 5.0,
    resume_from_offset_s: float = 0.0,
) -> None:
    """Poll the JSON scene index; structurally classify; validate via LLM;
    persist + publish each survivor.

    Exits when `stop` is set OR the index reports the same scene count for
    ~6 consecutive polls AND total > 0.

    ``resume_from_offset_s`` skips classification for any scene window whose
    start is below the offset, treating it as already-processed. Used by the
    rehydrate path so a Stop mid-indexing doesn't re-bill the LLM validator
    for windows already in the events table.
    """
    seen: set[tuple[float, float]] = set()
    stable_count = 0
    last_total = -1
    assert state.started_at is not None, (
        "poll_scene_index_forever spawned before state.started_at was set; "
        "fix the call order in pipeline._start_vod_pipeline"
    )
    started_video_at = float(state.started_at)
    deduper = _Deduper()
    content_type = state.content_type
    resume_floor = max(0.0, float(resume_from_offset_s))
    if resume_floor > 0:
        log.info("vod resume: skipping classification for scenes < %.1fs", resume_floor)

    while not stop.is_set():
        try:
            scenes = await asyncio.wait_for(
                asyncio.to_thread(_get_scenes_for_index, state, state.vod_scene_index_id),
                timeout=20.0,
            )
        except asyncio.TimeoutError:
            log.info("get_scene_index timed out (still indexing) — re-polling in %.0fs", poll_interval_s)
            scenes = []
        except Exception as e:  # noqa: BLE001
            log.warning("get_scene_index failed: %s — retrying", e)
            scenes = []

        new_count = 0
        for scene in scenes:
            start = float(scene.get("start") or 0)
            end = float(scene.get("end") or 0)
            key = (round(start, 2), round(end, 2))
            if key in seen:
                continue
            seen.add(key)
            # Already classified in a prior run; `seen` tracks for total count.
            if start < resume_floor:
                continue
            new_count += 1
            text = scene.get("text") or scene.get("description") or ""
            unix_ts = started_video_at + start
            evt = _structural_classify(text, unix_ts, content_type=content_type)
            if not evt:
                # Advance offset on no-event windows so resume picks up at the right scene.
                await db.set_state(
                    f"vod_offset:{state.video_id}", f"{end:.2f}",
                )
                continue
            # _llm_validates_summary disabled: 6-12s per call × sequential walk = unusable latency.
            # Strengthened VISUAL_FOOTBALL prompt + structural filter + deduper are sufficient.
            if not deduper.accept(evt):
                await db.set_state(
                    f"vod_offset:{state.video_id}", f"{end:.2f}",
                )
                continue
            await _persist_and_publish(evt, video_id=state.video_id)
            await db.set_state(
                f"vod_offset:{state.video_id}", f"{end:.2f}",
            )

        total = len(scenes)
        state.vod_total_scenes = total
        state.vod_indexed_scenes = total
        if new_count > 0:
            log.info("vod batch: +%d new scenes (total=%d)", new_count, total)
        bus.publish({
            "type": "vod_progress",
            "indexed": total,
            "new_in_batch": new_count,
        })

        if total > 0 and total == last_total:
            stable_count += 1
            if stable_count >= 6:
                log.info("VOD indexing complete — total=%d", total)
                break
        else:
            stable_count = 0
            last_total = total

        try:
            await asyncio.wait_for(stop.wait(), timeout=poll_interval_s)
        except asyncio.TimeoutError:
            pass

    log.info(
        "vod poll loop exiting (stop=%s, scenes_seen=%d)",
        stop.is_set(), len(seen),
    )


def _get_scenes_for_index(state: Any, scene_index_id: str | None) -> list[dict[str, Any]]:
    """Fetch scenes for the active scene index. [] for missing/empty indexes."""
    video = state.video
    if not video or not scene_index_id:
        return []
    try:
        result = video.get_scene_index(scene_index_id)
    except InvalidRequestError as e:
        if "No results found" in str(e):
            return []
        raise
    if result is None:
        return []
    return list(result)
