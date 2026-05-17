"""Highlights composer: turn the top-N high-impact events into a single
playable Timeline stream URL.

Strategy:
1. Periodically search across rtstream memory for goal/save/red_card moments.
2. For each shot, store its `generate_stream()` URL as a per-clip highlight.
3. On `/api/highlights/stream`, build a Timeline:
     - VideoAsset per clip (requires a permanent Video.id, so we export
       the live RTStream first; this happens lazily on first highlight call)
     - Optionally overlay any commentary AudioAsset for the same event window.
   Returns the composed timeline URL.

Fallback (when rt.export() flakes): return the most recent shot's stream_url
verbatim so the UI still has *something* to play.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from videodb import IndexType, SearchType
from videodb.editor import AudioAsset, Clip, Fit, Timeline, Track, VideoAsset
from videodb.exceptions import InvalidRequestError

from . import db, pipeline

log = logging.getLogger("highlights")

# Cache the export so we only run it once per pipeline start.
_export: dict[str, Any] | None = None
_export_lock = asyncio.Lock()


async def _ensure_export() -> dict[str, Any] | None:
    """Run rt.export() once and cache video_id + duration."""
    global _export
    async with _export_lock:
        if _export is not None:
            return _export
        rt = pipeline.state.rtstream
        if rt is None:
            return None
        try:
            res = await asyncio.to_thread(rt.export, name=f"datacaster_{int(time.time())}")
            _export = {
                "video_id": res.video_id,
                "stream_url": res.stream_url,
                "duration": float(getattr(res, "duration", 0) or 0),
                "started_at": pipeline.state.started_at or time.time(),
            }
            log.info("rtstream exported video_id=%s duration=%s", res.video_id, _export["duration"])
            return _export
        except Exception as e:  # noqa: BLE001
            log.warning("rt.export failed: %s", e)
            _export = {"failed": True}
            return _export


_HIGHLIGHT_QUERIES = ["goal", "save", "red card", "penalty"]


def _merge_shot(seen: dict[tuple[float, float], dict[str, Any]], shot: Any, q: str) -> None:
    """Dedup-merge a shot into `seen` by (start,end) key."""
    start = float(getattr(shot, "start", 0) or 0)
    end = float(getattr(shot, "end", 0) or 0)
    if end <= start:
        return
    key = (round(start, 1), round(end, 1))
    score = float(getattr(shot, "search_score", 0) or 0)
    if key in seen and score <= seen[key]["score"]:
        return
    try:
        url = shot.generate_stream()
    except Exception:  # noqa: BLE001
        url = None
    seen[key] = {
        "start": start, "end": end, "score": score, "query": q,
        "text": getattr(shot, "text", "") or "", "stream_url": url,
    }


def _search_top_highlights_vod_sync(state: Any, threshold: int) -> list[dict[str, Any]]:
    """VOD branch: search the video's scene index directly (rtstream namespace is empty for VOD)."""
    video = state.video
    seen: dict[tuple[float, float], dict[str, Any]] = {}
    for q in _HIGHLIGHT_QUERIES:
        kwargs: dict[str, Any] = {
            "query": q,
            "search_type": SearchType.semantic,
            "index_type": IndexType.scene,
            "score_threshold": 0.3,
            "result_threshold": threshold,
        }
        if state.vod_scene_index_id:
            kwargs["scene_index_id"] = state.vod_scene_index_id
        try:
            res = video.search(**kwargs)
            for shot in res.get_shots():
                _merge_shot(seen, shot, q)
        except InvalidRequestError as e:
            if "No results found" in str(e):
                continue
            log.warning("VOD highlight search '%s' failed: %s", q, e)
        except Exception as e:  # noqa: BLE001
            log.warning("VOD highlight search '%s' errored: %s", q, e)
    return sorted(seen.values(), key=lambda h: h["score"], reverse=True)[:8]


def _search_top_highlights_rtstream_sync(state: Any, threshold: int) -> list[dict[str, Any]]:
    """Live branch: search the rtstream namespace on the collection."""
    coll = state.coll
    if coll is None:
        return []
    seen: dict[tuple[float, float], dict[str, Any]] = {}
    for q in _HIGHLIGHT_QUERIES:
        try:
            res = coll.search(query=q, namespace="rtstream", index_type="scene",
                              result_threshold=threshold)
            for shot in res.get_shots():
                _merge_shot(seen, shot, q)
        except InvalidRequestError as e:
            if "No results found" in str(e):
                continue
            log.warning("highlight search '%s' failed: %s", q, e)
        except Exception as e:  # noqa: BLE001
            log.warning("highlight search '%s' errored: %s", q, e)
    return sorted(seen.values(), key=lambda h: h["score"], reverse=True)[:8]


def _search_top_highlights_sync(threshold: int = 20) -> list[dict[str, Any]]:
    """Dispatch to VOD/RTStream based on pipeline.state. [] when idle."""
    state = pipeline.state
    if state.video_id is not None and state.video is not None:
        return _search_top_highlights_vod_sync(state, threshold)
    if state.rtstream_id is not None:
        return _search_top_highlights_rtstream_sync(state, threshold)
    return []


async def refresh_highlights() -> int:
    """Search → upsert into the highlights table. Returns count stored."""
    rows = await asyncio.to_thread(_search_top_highlights_sync)
    n = 0
    for row in rows:
        event_id = await db.find_event_near_ts(row["start"], window_s=3.0)
        if event_id is None:
            event_id = -1
        await db.upsert_highlight(
            event_id=event_id, shot_start=row["start"], shot_end=row["end"],
            stream_url=row["stream_url"] or "", score=row["score"],
        )
        n += 1
    return n


async def highlight_indexer(stop: asyncio.Event) -> None:
    """Background worker: refresh highlights adaptively while pipeline is up.
    Sleeps 20s while we have <6 highlights, 60s once we've reached 6+."""
    while not stop.is_set():
        # Run for either pipeline mode — VOD (state.video) or live (state.rtstream).
        if pipeline.state.rtstream is not None or pipeline.state.video is not None:
            try:
                await refresh_highlights()
            except Exception as e:  # noqa: BLE001
                log.warning("highlight_indexer recovered: %s", e)
        try:
            current = await db.list_highlights(limit=6)
            sleep_s = 60 if len(current) >= 6 else 20
        except Exception:  # noqa: BLE001
            sleep_s = 60
        try:
            await asyncio.wait_for(stop.wait(), timeout=sleep_s)
        except asyncio.TimeoutError:
            pass


def _read_top_highlight_rows(limit: int = 6) -> list[dict[str, Any]]:
    """Direct sqlite read — we're already on a worker thread."""
    import sqlite3
    with sqlite3.connect(pipeline.REPO_ROOT / "datacaster.db") as raw:
        raw.row_factory = sqlite3.Row
        return [dict(r) for r in raw.execute(
            "SELECT * FROM highlights ORDER BY score DESC LIMIT ?", (limit,)
        )]


def _build_timeline_from_clips(
    conn: Any, video_id: str, duration_total: float, clip_specs: list[tuple[float, float]],
) -> str | None:
    """Timeline assembly for VOD and live paths. clip_specs: [(offset_s, duration_s)]."""
    timeline = Timeline(conn)
    timeline.resolution = "1280x720"
    timeline.background = "#000000"
    video_track = Track()
    cursor = 0
    used = 0
    for offset, clip_dur in clip_specs:
        if offset < 0 or offset + clip_dur > duration_total:
            continue
        try:
            video_track.add_clip(cursor, Clip(
                asset=VideoAsset(id=video_id, start=offset),
                duration=clip_dur,
                fit=Fit.crop,
            ))
            cursor += int(clip_dur)
            used += 1
        except Exception as e:  # noqa: BLE001
            log.warning("clip add failed: %s", e)
    if used == 0:
        return None
    timeline.add_track(video_track)
    try:
        return timeline.generate_stream()
    except Exception as e:  # noqa: BLE001
        log.warning("timeline.generate_stream failed: %s", e)
        return None


def _compose_timeline_vod_sync() -> str | None:
    """VOD branch: video already has permanent id; timestamps are in-video offsets, used directly."""
    state = pipeline.state
    conn = state.conn
    video = state.video
    if conn is None or video is None:
        return None
    duration_total = float(getattr(video, "length", 0) or 0)
    if duration_total <= 0:
        return None
    clip_specs: list[tuple[float, float]] = []
    for h in _read_top_highlight_rows(limit=6):
        start = float(h["shot_start"] or 0)
        end = float(h["shot_end"] or 0)
        if end <= start:
            continue
        clip_specs.append((max(0.0, start), max(2.0, min(15.0, end - start))))
    return _build_timeline_from_clips(conn, video.id, duration_total, clip_specs)


def _compose_timeline_rtstream_sync() -> str | None:
    """Live branch: needs cached rt.export() for a permanent video id to re-clip against."""
    state = pipeline.state
    conn = state.conn
    if conn is None or _export is None or _export.get("failed"):
        return None
    video_id = _export["video_id"]
    started = float(_export["started_at"])
    duration_total = float(_export["duration"])
    clip_specs: list[tuple[float, float]] = []
    for h in _read_top_highlight_rows(limit=6):
        start = float(h["shot_start"] or 0)
        end = float(h["shot_end"] or 0)
        if end <= start:
            continue
        # convert wall-clock unix ts to offset within the exported video
        offset = max(0.0, start - started)
        clip_specs.append((offset, max(2.0, min(15.0, end - start))))
    return _build_timeline_from_clips(conn, video_id, duration_total, clip_specs)


def _compose_timeline_sync() -> str | None:
    """Timeline from recent highlights, dispatched on pipeline mode. None → caller falls back."""
    state = pipeline.state
    if state.video_id is not None and state.video is not None:
        return _compose_timeline_vod_sync()
    if state.rtstream_id is not None:
        return _compose_timeline_rtstream_sync()
    return None


async def get_highlights_stream() -> dict[str, Any]:
    """Top-level entry point for /api/highlights/stream."""
    state = pipeline.state
    # Live RTStream needs export() for a permanent video id; VOD already has state.video.id.
    if state.video_id is not None and state.video is not None:
        composed = await asyncio.to_thread(_compose_timeline_sync)
        if composed:
            return {"mode": "composed", "stream_url": composed}
    elif state.rtstream_id is not None:
        export = await _ensure_export()
        if export and not export.get("failed"):
            composed = await asyncio.to_thread(_compose_timeline_sync)
            if composed:
                return {"mode": "composed", "stream_url": composed}

    # Fallback: return the highest-score single shot's URL.
    rows = await db.list_highlights(limit=1)
    if rows and rows[0].get("stream_url"):
        return {"mode": "single", "stream_url": rows[0]["stream_url"],
                "summary": rows[0].get("summary")}
    return {"mode": "none", "stream_url": None}


# ──────────────────────────────────────────────────────────────────────────
# Reel composer: 9:16 reel from last N events + generate_text recap caption.
# ──────────────────────────────────────────────────────────────────────────


_REEL_PRE_PAD_S = 5.0
_REEL_POST_PAD_S = 5.0
# Timeline rejects heights > 1080. Widths are even (608 not 607.5).
_REEL_RESOLUTIONS = {
    "vertical":   "608x1080",
    "square":     "1080x1080",
    "landscape":  "1280x720",
}


def _ts_to_mmss(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


def _compose_reel_sync(
    events: list[dict[str, Any]], aspect: str = "vertical",
) -> str | None:
    """Timeline from events at the requested aspect (vertical/square/landscape preset). None on failure."""
    state = pipeline.state
    conn = state.conn
    video = state.video
    if conn is None or video is None:
        return None
    duration_total = float(getattr(video, "length", 0) or 0)
    if duration_total <= 0:
        return None
    started_at = float(state.started_at or 0)
    if started_at <= 0:
        return None

    timeline = Timeline(conn)
    timeline.resolution = _REEL_RESOLUTIONS.get(aspect, _REEL_RESOLUTIONS["vertical"])
    timeline.background = "#000000"

    video_track = Track()
    cursor = 0
    used = 0
    # Sort oldest-first so the reel reads chronologically.
    for evt in sorted(events, key=lambda e: float(e.get("unix_ts") or 0)):
        unix_ts = float(evt.get("unix_ts") or 0)
        if unix_ts <= 0:
            continue
        # unix_ts → in-video offset
        offset = max(0.0, unix_ts - started_at - _REEL_PRE_PAD_S)
        clip_dur = _REEL_PRE_PAD_S + _REEL_POST_PAD_S
        if offset + clip_dur > duration_total:
            clip_dur = max(2.0, duration_total - offset)
            if clip_dur <= 0:
                continue
        try:
            video_track.add_clip(cursor, Clip(
                asset=VideoAsset(id=video.id, start=offset),
                duration=clip_dur,
                fit=Fit.crop,
            ))
            cursor += int(clip_dur)
            used += 1
        except Exception as e:  # noqa: BLE001
            log.warning("reel clip add failed for event %s: %s", evt.get("id"), e)

    if used == 0:
        log.warning("reel: no usable clips from %d events", len(events))
        return None

    timeline.add_track(video_track)
    try:
        return timeline.generate_stream()
    except Exception as e:  # noqa: BLE001
        log.warning("reel timeline.generate_stream failed: %s", e)
        return None


_HUMAN_LABELS = {
    "goal":            "a goal",
    "red_card":        "a red card",
    "yellow_card":     "a yellow card",
    "penalty":         "a penalty",
    "save":            "a big save",
    "shot_on_target":  "an effort on target",
    "shot_off_target": "a shot just off",
    "corner":          "a corner",
    "free_kick":       "a free-kick",
    "kick_off":        "the restart",
    "foul":            "a foul",
    "throw_in":        "a throw-in",
}


def _heuristic_recap(events: list[dict[str, Any]]) -> str:
    """Fan-style prose fallback when generate_text is unavailable. Caps at 5 sentences."""
    if not events:
        return "Quiet window — nothing dramatic in this stretch."

    started_at = float(pipeline.state.started_at or 0)
    sorted_evts = sorted(events, key=lambda e: float(e.get("unix_ts") or 0))
    has_goal = any((e.get("event_type") or "") == "goal" for e in sorted_evts)

    sentences: list[str] = []
    for evt in sorted_evts[:5]:
        unix_ts = float(evt.get("unix_ts") or 0)
        offset = max(0.0, unix_ts - started_at) if started_at else 0.0
        et_raw = evt.get("event_type") or "event"
        label = _HUMAN_LABELS.get(et_raw, et_raw.replace("_", " "))
        team = (evt.get("team") or "").strip()
        team_str = f" for the {team} side" if team and team != "unknown" else ""
        summary = (evt.get("summary") or "").strip().rstrip(".")
        ts = _ts_to_mmss(offset)
        if et_raw == "goal":
            sentence = f"At [{ts}] there's {label}{team_str} ⚽"
        else:
            sentence = f"At [{ts}] {label}{team_str}"
        if summary:
            sentence += f" — {summary[0].lower()}{summary[1:]}."
        else:
            sentence += "."
        sentences.append(sentence)

    if has_goal:
        sentences.append("Cracking stretch of football. 🔥")

    return " ".join(sentences)


async def build_recap_caption(events: list[dict[str, Any]]) -> str:
    """30-second sportsbook recap via coll.generate_text (12s timeout). Falls back to heuristic."""
    coll = pipeline.state.coll
    if coll is None or not events:
        return _heuristic_recap(events)

    started_at = float(pipeline.state.started_at or 0)

    bullets: list[str] = []
    for evt in sorted(events, key=lambda e: float(e.get("unix_ts") or 0)):
        unix_ts = float(evt.get("unix_ts") or 0)
        offset = max(0.0, unix_ts - started_at) if started_at else 0.0
        et = (evt.get("event_type") or "event").replace("_", " ")
        team = (evt.get("team") or "").strip()
        team_str = f" · {team}" if team and team != "unknown" else ""
        summary = (evt.get("summary") or "").strip()[:200]
        bullets.append(f"[{_ts_to_mmss(offset)}] {et}{team_str} — {summary}")

    prompt = (
        "You are a football fan writing a Telegram channel caption for a "
        "30-second highlight reel. Imagine you're posting for a passionate "
        "match-day group — friends who love the game.\n\n"
        "Style:\n"
        "• Write as flowing prose, NOT bullet points and NOT a list. "
        "Stitch the moments into a short narrative the reader can follow "
        "in one breath.\n"
        "• Exactly 3 to 5 sentences. Present tense. Vivid action verbs "
        "(\"slots past the keeper\", \"crashes off the crossbar\", "
        "\"goes down clutching his shin\"). Avoid clinical phrases like "
        "\"shot on target\" — paraphrase to actual play.\n"
        "• Quote the in-video timestamp inline as [MM:SS] every time you "
        "mention a specific moment. Example: \"At [02:14] the keeper "
        "spreads himself wide and palms it past the post.\"\n"
        "• Use AT MOST two emojis in the entire caption, placed inline "
        "next to the moments they describe — ⚽ for a goal, 🧤 for a "
        "huge save, 🟨 / 🟥 for cards, 🔥 only after a goal sentence. "
        "No emoji-led bullets, no decorative emojis.\n"
        "• NO preamble (\"Based on the events…\"), NO hashtags, NO "
        "headings, NO list markers, NO mention of being an AI, NO "
        "\"Highlights drop\" intro line.\n\n"
        f"Events (chronological, [MM:SS] · type · description):\n"
        + "\n".join(bullets)
        + "\n\nTelegram caption (3-5 sentences of prose):"
    )

    def _call():
        # SDK only accepts model_name ∈ {basic, pro, ultra}.
        model = "ultra" if pipeline.state.sandbox_id else "basic"
        return coll.generate_text(prompt=prompt, model_name=model)

    def _unwrap(out: Any) -> str | None:
        # Hackathon SDK returns {"output": "..."}.
        if isinstance(out, str):
            return out.strip() or None
        if isinstance(out, dict):
            for key in ("output", "text", "response"):
                v = out.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
        return None

    try:
        result = await asyncio.wait_for(asyncio.to_thread(_call), timeout=12.0)
        unwrapped = _unwrap(result)
        if unwrapped:
            return unwrapped[:1200]
    except asyncio.TimeoutError:
        log.warning("build_recap_caption: generate_text timed out")
    except Exception as e:  # noqa: BLE001
        log.warning("build_recap_caption: generate_text error %s", type(e).__name__)
    return _heuristic_recap(events)


async def compose_reel_from_events(
    events: list[dict[str, Any]], aspect: str = "vertical",
) -> dict[str, Any]:
    """End-to-end reel build: Timeline + recap caption. Returns {reel_url, caption}."""
    reel_url, caption = await asyncio.gather(
        asyncio.to_thread(_compose_reel_sync, events, aspect),
        build_recap_caption(events),
    )
    return {"reel_url": reel_url, "caption": caption}
