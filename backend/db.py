"""Async SQLite via aiosqlite. Single file, no migrations."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import aiosqlite

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unix_ts REAL NOT NULL,
    event_type TEXT NOT NULL,
    confidence REAL,
    team TEXT,
    summary TEXT,
    raw_json TEXT,
    source TEXT NOT NULL,
    video_id TEXT  -- NULL for live RTStream; set on VOD events for re-hydration
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(unix_ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_video ON events(video_id);

CREATE TABLE IF NOT EXISTS commentary(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events(id),
    text TEXT,
    audio_url TEXT,
    voice_style TEXT,
    created_at REAL
);

CREATE TABLE IF NOT EXISTS highlights(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events(id),
    shot_start REAL,
    shot_end REAL,
    stream_url TEXT,
    score REAL,
    UNIQUE(event_id)
);

CREATE TABLE IF NOT EXISTS pipeline_state(
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS extractions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unix_ts REAL NOT NULL,
    kind TEXT NOT NULL,
    topic TEXT,
    entities_json TEXT,
    quotes_json TEXT,
    sentiment TEXT,
    raw_json TEXT,
    source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extractions_ts ON extractions(unix_ts);
"""


async def init() -> None:
    """Create tables if missing; in-place migrate older DBs that lack `events.video_id`."""
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        # ALTER raises on duplicate column rather than no-op'ing; swallow that case.
        try:
            await db.execute("ALTER TABLE events ADD COLUMN video_id TEXT")
        except Exception:  # noqa: BLE001
            pass
        await db.execute("CREATE INDEX IF NOT EXISTS idx_events_video ON events(video_id)")
        await db.commit()


async def reset_events_and_commentary() -> None:
    """Wipe events, commentary, and highlights for a fresh pipeline run."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM commentary")
        await db.execute("DELETE FROM highlights")
        await db.execute("DELETE FROM events")
        # Reset autoincrement so event ids stay small in the UI.
        await db.execute("DELETE FROM sqlite_sequence WHERE name IN ('events','commentary','highlights')")
        await db.commit()


async def clear_events() -> int:
    """Wipe events + dependent commentary/highlights. Returns count removed."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*) FROM events")
        row = await cur.fetchone()
        n = int(row[0]) if row else 0
        # Drop dependents first.
        await db.execute("DELETE FROM commentary")
        await db.execute("DELETE FROM highlights")
        await db.execute("DELETE FROM events")
        await db.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('events','commentary','highlights')"
        )
        await db.commit()
    return n


async def clear_commentary() -> int:
    """Wipe just the commentary table. Events and highlights are preserved."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*) FROM commentary")
        row = await cur.fetchone()
        n = int(row[0]) if row else 0
        await db.execute("DELETE FROM commentary")
        await db.execute("DELETE FROM sqlite_sequence WHERE name = 'commentary'")
        await db.commit()
    return n


async def insert_event(
    *, unix_ts: float, event_type: str, confidence: float | None,
    team: str | None, summary: str | None, raw_json: dict | str, source: str,
    video_id: str | None = None,
) -> int:
    raw = raw_json if isinstance(raw_json, str) else json.dumps(raw_json)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO events(unix_ts, event_type, confidence, team, summary, raw_json, source, video_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (unix_ts, event_type, confidence, team, summary, raw, source, video_id),
        )
        await db.commit()
        return cur.lastrowid or 0


async def events_exist_for_video(video_id: str) -> int:
    """Count of persisted events for this video; >0 means we can re-hydrate without re-indexing."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT COUNT(*) FROM events WHERE video_id = ?", (video_id,)
        )
        row = await cur.fetchone()
        return int(row[0]) if row else 0


async def list_events_for_video(video_id: str, limit: int = 1000) -> list[dict[str, Any]]:
    """All persisted events for this video, oldest-first. Used at Start to hydrate from disk."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT * FROM events WHERE video_id = ? ORDER BY unix_ts ASC LIMIT ?",
            (video_id, limit),
        )
        return [dict(r) for r in rows]


async def clear_events_for_video(video_id: str) -> int:
    """Wipe events + dependent commentary/highlights for a single video. Used by /api/events/resync."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT COUNT(*) FROM events WHERE video_id = ?", (video_id,)
        )
        row = await cur.fetchone()
        n = int(row[0]) if row else 0
        await db.execute(
            "DELETE FROM commentary WHERE event_id IN (SELECT id FROM events WHERE video_id = ?)",
            (video_id,),
        )
        await db.execute(
            "DELETE FROM highlights WHERE event_id IN (SELECT id FROM events WHERE video_id = ?)",
            (video_id,),
        )
        await db.execute("DELETE FROM events WHERE video_id = ?", (video_id,))
        await db.commit()
    return n


async def list_events(
    limit: int = 200, video_id: str | None = None,
) -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if video_id is not None:
            rows = await db.execute_fetchall(
                "SELECT * FROM events WHERE video_id = ? ORDER BY id DESC LIMIT ?",
                (video_id, limit),
            )
        else:
            rows = await db.execute_fetchall(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
            )
        return [dict(r) for r in rows]


async def get_event(event_id: int) -> dict[str, Any] | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        row = await db.execute_fetchall(
            "SELECT * FROM events WHERE id = ?", (event_id,)
        )
        return dict(row[0]) if row else None


async def event_counts(video_id: str | None = None) -> dict[str, int]:
    async with aiosqlite.connect(DB_PATH) as db:
        if video_id is not None:
            rows = await db.execute_fetchall(
                "SELECT event_type, COUNT(*) FROM events WHERE video_id = ? "
                "GROUP BY event_type",
                (video_id,),
            )
        else:
            rows = await db.execute_fetchall(
                "SELECT event_type, COUNT(*) FROM events GROUP BY event_type"
            )
        return {r[0]: r[1] for r in rows}


async def insert_commentary(
    *, event_id: int, text: str, audio_url: str, voice_style: str, created_at: float,
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO commentary(event_id, text, audio_url, voice_style, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (event_id, text, audio_url, voice_style, created_at),
        )
        await db.commit()
        return cur.lastrowid or 0


async def list_commentary(limit: int = 50) -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT c.*, e.event_type, e.summary, e.unix_ts AS event_ts "
            "FROM commentary c LEFT JOIN events e ON e.id = c.event_id "
            "ORDER BY c.id DESC LIMIT ?",
            (limit,),
        )
        return [dict(r) for r in rows]


async def upsert_highlight(
    *, event_id: int, shot_start: float, shot_end: float, stream_url: str, score: float,
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO highlights(event_id, shot_start, shot_end, stream_url, score) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(event_id) DO UPDATE SET "
            "shot_start=excluded.shot_start, shot_end=excluded.shot_end, "
            "stream_url=excluded.stream_url, score=excluded.score",
            (event_id, shot_start, shot_end, stream_url, score),
        )
        await db.commit()


async def list_highlights(limit: int = 25) -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT h.*, e.event_type, e.summary "
            "FROM highlights h LEFT JOIN events e ON e.id = h.event_id "
            "ORDER BY h.score DESC LIMIT ?",
            (limit,),
        )
        return [dict(r) for r in rows]


async def insert_extraction(
    *, unix_ts: float, kind: str, topic: str | None,
    entities: list[str] | None, quotes: list[str] | None,
    sentiment: str | None, raw_json: dict | str, source: str,
) -> int:
    raw = raw_json if isinstance(raw_json, str) else json.dumps(raw_json)
    ents = json.dumps(entities or [])
    qs = json.dumps(quotes or [])
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO extractions(unix_ts, kind, topic, entities_json, quotes_json, "
            "sentiment, raw_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (unix_ts, kind, topic, ents, qs, sentiment, raw, source),
        )
        await db.commit()
        return cur.lastrowid or 0


async def list_extractions(limit: int = 100) -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT * FROM extractions ORDER BY id DESC LIMIT ?", (limit,)
        )
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["entities"] = json.loads(d.pop("entities_json") or "[]")
            except json.JSONDecodeError:
                d["entities"] = []
            try:
                d["quotes"] = json.loads(d.pop("quotes_json") or "[]")
            except json.JSONDecodeError:
                d["quotes"] = []
            out.append(d)
        return out


async def find_event_near_ts(
    unix_ts: float, window_s: float = 3.0,
) -> int | None:
    """events.id closest to unix_ts within window_s, or None. Links highlights to triggering events."""
    async with aiosqlite.connect(DB_PATH) as db:
        rows = await db.execute_fetchall(
            "SELECT id, unix_ts FROM events "
            "WHERE ABS(unix_ts - ?) < ? "
            "ORDER BY ABS(unix_ts - ?) ASC LIMIT 1",
            (unix_ts, window_s, unix_ts),
        )
        return rows[0][0] if rows else None


async def count_events_by_type(since_ts: float) -> dict[str, int]:
    """Counts grouped by event_type since the given ts. Used by auto-detect-mode (football vs insights)."""
    async with aiosqlite.connect(DB_PATH) as db:
        rows = await db.execute_fetchall(
            "SELECT event_type, COUNT(*) FROM events "
            "WHERE unix_ts >= ? GROUP BY event_type",
            (since_ts,),
        )
        return {row[0]: row[1] for row in rows}


async def set_state(key: str, value: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO pipeline_state(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        await db.commit()


async def get_state(key: str) -> str | None:
    async with aiosqlite.connect(DB_PATH) as db:
        row = await db.execute_fetchall(
            "SELECT value FROM pipeline_state WHERE key = ?", (key,)
        )
        return row[0][0] if row else None
