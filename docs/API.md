# DataCaster — Backend API Reference

Every public HTTP endpoint exposed by the FastAPI backend on port 8000. The
frontend consumes these via `frontend/src/lib/api.ts`; the test runner
exercises them in `test-datacaster.py`.

All JSON. All paths are prefixed with `/api`. Errors are returned as
`{"detail": "..."}` with a 4xx/5xx status code; the frontend's
`humanize(err)` (in `frontend/src/lib/errors.ts`) translates the common
ones into user-facing copy.

---

## Lifecycle

### `GET /api/health`

Always 200. Returns the live `pipeline.state` shape plus a wall-clock.

```json
{
  "status": "ok",
  "now": 1778958663.71,
  "pipeline": {
    "started_at": null | float,
    "starting_at": null | float,
    "source_type": null | "video" | "url",
    "source": null | "<original input>",
    "content_type": "football" | "describe",
    "rtstream_url": null | "<hls url>",
    "rtstream_id": null | "rt-…",
    "sandbox_id": null | "bx-…",
    "ws_id": null | "<ws connection id>",
    "visual_index_id": null | "<scene index id>",
    "audio_index_id": null,
    "live_stream_url": null | "<hls url>",
    "live_player_url": null | "<player url>",
    "video_id": null | "m-z-…",
    "vod_scene_index_id": null | "<scene index id>",
    "vod_prose_index_id": null,
    "vod_total_scenes": null | int,
    "vod_indexed_scenes": null | int,
    "video_length_s": null | float,         // source runtime, drives indexing ETA
    "transcript_index_id": null | "spoken_word",  // sentinel: video.index_spoken_words ran
    "prompt_mode": "football" | "describe"
  }
}
```

### `POST /api/start`

Start a new pipeline. Idempotent if one is already running.

**Body:**

```json
{
  "source_type": "video" | "url",
  "source": "<URL or m-prefixed video id>",
  "content_type": "football" | "describe"   // optional, defaults to football
}
```

**Response:** the `pipeline.state.public()` shape (same as `/api/health`'s
`pipeline` field).

**Failures:**

- `422` — `content_type` not one of the supported values.
- `500` `start failed: Invalid request: Download failed.` — VideoDB
  couldn't fetch the URL. Retry; usually transient.
- `500` `start failed: …` — anything else from the pipeline. Backend log
  has the full traceback.

**Reuse fast path:** if `source` starts with `m-` (a previously-uploaded
VideoDB video id), the backend skips upload/transcode and calls
`coll.get_video(id)`. If the events DB already has rows for that video_id,
the entire indexing pass is skipped and the pipeline returns idle-fast.

### `POST /api/stop`

Stop the active pipeline (kills the VOD poller, releases sandbox if any,
clears in-memory state). Does **not** delete events.

**Response:** `{"status": "stopped"}`

### `POST /api/end_session`

Same as `/api/stop` plus broadcasts a `session_ended` bus message so any
SSE subscriber clears its in-memory state. **Events stay in the DB**,
keyed by `video_id`, so reopening the same video re-hydrates instantly.

**Response:** `{"status": "ended"}`

### `POST /api/live_stream`

Lazily fetch the HLS URL for the active rtstream. Required because
`rt.generate_stream()` hangs if called before VideoDB has packaged the
first segments (~30s after Start).

**Response:**

```json
{ "stream_url": null | "<hls url>", "player_url": null | "<player url>" }
```

### `POST /api/sandbox/sweep`

Manual recovery: stop any DataCaster sandboxes still tracked in the
sidecar (`/tmp/datacaster_active_sandboxes.txt`). Scoped to ids we
allocated, never blind-stops every sandbox on the account.

**Response:**

```json
{ "stopped": 0 }
```

Useful after `docker compose kill` (which bypasses the lifespan
shutdown) or any other code path that leaks a sandbox without going
through `/api/end_session`. The startup orphan sweeper runs the same
helper automatically every backend boot.

### `GET /api/videos`

List every video in the active VideoDB collection so the UI can offer
them as presets.

**Response:**

```json
{
  "videos": [
    {
      "id": "m-z-019e31a8-…",
      "name": "Over 30 Minutes of 2022 FIFA World Cup Goals | Matchday 2",
      "length": 1978.525896,
      "thumbnail_url": null | "<url>"
    }
  ]
}
```

---

## Events

### `GET /api/events`  (Server-Sent Events)

SSE stream of pipeline events.

**On connect:** if a pipeline is active, replays the most-recent 200 events
for `pipeline.video_id`. If idle, no replay (the timeline stays empty until
the next Start).

**Streamed message types:**

```
event: event
data:  {"type": "event", "event": {<events row>}}

event: commentary
data:  {"type": "commentary", "event_id": int, "commentary_id": int,
        "text": str, "audio_url": str|null, "style": str}

event: transcript
data:  {"type": "transcript", "ts": float, "text": str}

event: session_ended       data: {"type": "session_ended"}
event: resync              data: {"type": "resync", "video_id": str, "cleared": int}
event: cleared             data: {"type": "cleared", "scope": "events"|"commentary"}

event: vod_progress
data:  {"type": "vod_progress", "indexed": int, "new_in_batch": int}
                                                          // emitted every ~5s by
                                                          // poll_scene_index_forever
                                                          // drives <IndexingProgress>

event: ping                data: {}                      // 15s heartbeat
```

### `GET /api/events/history?limit=N&video_id=…`

Pull persisted events. `limit` defaults to 200; `video_id` defaults to
the active pipeline's `video_id` (or all videos if idle).

```json
{ "events": [ {<events row>}, ... ] }
```

### `GET /api/stats?video_id=…`

Per-event-type counts for the given video (or active video).

```json
{
  "counts": {"goal": 5, "yellow_card": 2, "save": 8, …},
  "total": 17
}
```

### `POST /api/events/resync`

Wipe events for the active `video_id` and restart the pipeline so a fresh
classification runs under the current prompt + thresholds. The reuse fast
path doesn't trigger because there are no cached events.

**Response:**

```json
{ "status": "resyncing", "video_id": "m-z-…", "cleared": int, "pipeline": {…} }
```

**Failures:**

- `400` — no active pipeline.
- `500` — restart failed (full traceback in backend logs).

---

## Search & Ask

### `GET /api/search?q=…&kind=visual|audio|transcript&threshold=10`

Multimodal search across the active source's indexes. Routing by `kind`:

| `kind` | VOD source | RTStream source |
|---|---|---|
| `visual` | `video.search(index_type=scene, scene_index_id=…, score_threshold=0.2)` | `coll.search(namespace="rtstream", index_type="scene")` |
| `transcript` | `video.search(index_type=spoken_word, search_type=semantic)` | `coll.search(namespace="rtstream", index_type="spoken_word")` |
| `audio` | **HTTP 400** — VOD has no audio search; the SDK exposes only scene + spoken_word for VOD | `coll.search(namespace="rtstream", index_type="audio")` |

The frontend hides the audio tab on VOD sources (`m-` prefix). Visual rows
parse the JSON envelope (`event_type · team — summary`); transcript rows
render as full sentences (justified paragraph). Every row click translates
the shot's `start` into an in-video offset and seeks the existing main
player via `lib/playerControl.ts`.

**Response:**

```json
{
  "q": "red card",
  "kind": "visual",
  "shots": [
    {
      "rtstream_id": null,
      "rtstream_name": null,
      "start": 60.0,
      "end": 60.3,
      "text": "<JSON-shaped scene text or transcript sentence>",
      "score": 0.41,
      "stream_url": "<hls url>"
    }
  ]
}
```

### `POST /api/ask`

LLM-driven Q&A: rewrite → multi-rail search → compose. **The answer is
always composed by an LLM.** No silent evidence-only fallback.

**Body:**

```json
{ "q": "did anyone get a red card?", "threshold": 6 }   // threshold optional
```

**Pipeline (server-side):**

1. `coll.generate_text(model_name="ultra")` rewrites the question into 3
   concrete search phrases (8s timeout). On failure, falls back to using
   the raw query as a single phrase.
2. Each phrase runs against scene + spoken_word indexes in parallel.
   Results are merged by `(start, end)` keeping highest score; rows
   whose parsed `event_type == "none"` and rows whose summary is raw
   JSON are dropped.
3. `coll.generate_text(model_name="ultra")` composes the final answer
   (12s timeout, retried once at 25s). On both failures, the route
   returns **HTTP 503** with the message *"Ask is temporarily
   unavailable — the LLM didn't respond in time."*

**Successful response (200):**

```json
{
  "query": "did anyone get a red card?",
  "answer": "Yes — two reds. [00:18] referee shows red to a defender after a last-man tackle, [04:24] keeper sent off for handling outside the box.",
  "evidence": [ {<shot dict>}, ... ]
}
```

**Failure (503):**

```json
{
  "detail": "Ask is temporarily unavailable — the LLM didn't respond in time. Try again in a few seconds."
}
```

Frontend renders 503 as the red error banner with a Retry button, never as
a silent empty answer.

---

## Commentary

### `POST /api/commentary?event_id=N&style=excited`

Force-generate commentary for a specific event. The autonomous worker
already does this for high-impact events; this endpoint is the manual hook.

**Response:**

```json
{
  "id": int,
  "event_id": int,
  "text": "<60-100 word broadcast script>",
  "audio_url": "<videodb audio url or empty string>",
  "voice_style": "excited",
  "created_at": float
}
```

### `GET /api/commentary/track?limit=50`

List commentary cards.

```json
{
  "items": [ {<commentary row>}, ... ],
  "voice": {
    "available": bool,
    "consecutive_failures": int,
    "backoff_remaining_s": float
  }
}
```

When `available: false`, the worker is in the 5-minute backoff after the
voice-generation cap tripped. Cards still get scripts; `audio_url` is
empty until voice clears.

---

## Highlights

### `GET /api/highlights?limit=25`

Top-N highlight clips composed from events.

```json
{ "items": [ {<highlight row with stream_url + score>}, ... ] }
```

### `POST /api/highlights/refresh`

Force a one-shot refresh.

```json
{ "stored": int }
```

### `GET /api/highlights/stream`

Composed Timeline-stitched stream.

```json
{ "mode": "timeline", "stream_url": "<hls>", "summary": "<text>" }
```

### `POST /api/highlights/reel`

Programmable-editing wedge: compose a vertical / square / landscape reel
from the most-recent N events on the active video, generate a 30-second
recap caption via `coll.generate_text` (with heuristic fallback), and
optionally post the pair to Telegram via the Bot API.

**Body:**

```json
{
  "n": 3,                              // 1..10, default 3
  "aspect": "vertical",                // "vertical" | "square" | "landscape"
  "deliver": "telegram"                // "telegram" | "none"
}
```

**Response:**

```json
{
  "reel_url": "<hls or null>",
  "caption": "<scout-grade recap, multi-line>",
  "aspect": "vertical",
  "n": 3,
  "events_used": 3,
  "delivered_to": "telegram" | null,
  "telegram_message_id": 12345 | null,
  "telegram_configured": true | false
}
```

**Failures:**

- `400` — no active pipeline (Start one first), or zero events on the
  active video (wait for the indexer).
- `500` — compose failed; full traceback in backend logs.

**Telegram delivery.** Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
in the backend env. The client first attempts `sendVideo` so the chat shows
a player chip; if Telegram can't ingest the URL (common for HLS manifests),
falls back to `sendMessage` with the caption + a clickable link. The reel
URL + caption ship back to the UI either way.

---

## Export

| Path | Returns | Filename |
|---|---|---|
| `GET /api/export/events` | JSON `{"events": [...]}` | `datacaster-events-{ts}.json` |
| `GET /api/export/commentary` | JSON `{"items": [...]}` | `datacaster-commentary-{ts}.json` |
| `GET /api/export/highlights` | JSON `{"items": [...]}` | `datacaster-highlights-{ts}.json` |

All set `Content-Disposition: attachment` so the browser downloads
directly. The kebab-menu surfaces only **Export events (JSON)** and
**About DataCaster** (links to the public GitHub repo); commentary +
highlights stay reachable via direct curl for power users.

---

## Database row shapes

For reference — the `events` and `commentary` rows you'll see in JSON
responses come from these SQLite tables.

```sql
CREATE TABLE events(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unix_ts     REAL NOT NULL,             -- started_at + scene.start
  event_type  TEXT NOT NULL,             -- e.g. "goal", "yellow_card"
  confidence  REAL,                      -- 0–1
  team        TEXT,                      -- "home" | "away" | "unknown"
  summary     TEXT,                      -- 1-line description
  raw_json    TEXT,                      -- full classifier output
  source      TEXT NOT NULL,             -- "visual" | "audio" | "alert" | …
  video_id    TEXT                       -- m-prefixed VideoDB id (NULL for live)
);

CREATE TABLE commentary(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER REFERENCES events(id),
  text        TEXT,                      -- 60-100 word broadcast script
  audio_url   TEXT,                      -- "" if voice cap tripped
  voice_style TEXT,                      -- "excited" | "analytical" | "spanish"
  created_at  REAL
);
```
