# DataCaster — Architecture

How the moving parts fit together. Read this before changing anything that
crosses the frontend/backend boundary, the pipeline lifecycle, or the
classifier.

For day-to-day operations see [`OPERATIONS.md`](OPERATIONS.md). For
endpoint-level detail see [`API.md`](API.md).

---

## System shape

```
        ┌──────────────────────────────────────────────────────────────┐
        │                     User's browser                           │
        │  React 18 + Vite + Tailwind v4 + shadcn/ui + hls.js          │
        └──────────────────────────────────────────────────────────────┘
                          │            ▲
              fetch /api/*│            │SSE /api/events
                          ▼            │
        ┌──────────────────────────────────────────────────────────────┐
        │   nginx :3000  (frontend container)                          │
        │   - serves dist/  - proxies /api/* → backend:8000            │
        └──────────────────────────────────────────────────────────────┘
                          │            ▲
                          ▼            │
        ┌──────────────────────────────────────────────────────────────┐
        │   FastAPI :8000  (backend container)                         │
        │   ├── routes/lifecycle.py  start / stop / health / videos    │
        │   ├── routes/events.py     SSE + history + stats + resync    │
        │   ├── routes/search.py     /api/search                       │
        │   ├── routes/ask.py        /api/ask                          │
        │   ├── routes/commentary.py /api/commentary[/track]           │
        │   ├── routes/highlights.py /api/highlights[/refresh|reel|stream] │
        │   ├── routes/export.py     /api/export/{events,commentary,…} │
        │   │                                                          │
        │   ├── pipeline.py    PipelineState, start/stop/restart       │
        │   ├── source.py      coll.upload + reuse-by-id fast path     │
        │   ├── vod.py         poll_scene_index_forever (the worker)   │
        │   ├── search.py      LLM-driven Ask + multimodal search      │
        │   ├── commentary.py  generate_text + generate_voice worker   │
        │   ├── highlights.py  Timeline composer                       │
        │   ├── telegram.py    Bot API delivery client                 │
        │   ├── sandbox.py     sidecar-tracked orphan sweeper          │
        │   ├── prompts.py     VISUAL_FOOTBALL, VISUAL_DESCRIBE, AUDIO │
        │   ├── config.py      EVENT_VOCAB, GENERIC_VOCAB, env knobs   │
        │   ├── db.py          aiosqlite, schema, queries              │
        │   └── events_bus.py  in-process pub/sub for SSE fanout       │
        └──────────────────────────────────────────────────────────────┘
                          │            ▲
                          ▼            │
        ┌──────────────────────────────────────────────────────────────┐
        │              VideoDB hosted API (api.videodb.io)             │
        │   coll.upload, video.index_scenes, video.search,             │
        │   coll.generate_voice, coll.generate_text                    │
        └──────────────────────────────────────────────────────────────┘
```

Backend and frontend run as two Docker containers (`backend`, `frontend`)
defined in `docker-compose.yml`. The SQLite DB lives at
`./data/datacaster.db` (host) → `/app/data/datacaster.db` (container) via a
directory bind-mount, so the per-`video_id`
event cache survives every `make rebuild` / `docker compose up
--force-recreate`.

---

## Two paths through the system

### A. VOD (the primary path)

```
User clicks Start (source_type="video")
        │
        ▼
POST /api/start                                       (routes/lifecycle.py)
        │
        ▼
pipeline.start_pipeline(content_type="football")      (pipeline.py)
        │
        ▼
source.upload_vod(coll, url)
        │       └─ if url starts with "m-": coll.get_video(id)         ◄── reuse fast path
        │       └─ else:                    coll.upload(url, media_type="video")
        ▼
cached_event_count = db.events_exist_for_video(video.id)
cached_offset      = db.get_state(f"vod_offset:{video.id}")
        │
        ├── cached_event_count > 0 AND fully_indexed?       ◄── instant rehydrate
        │       state.started_at = vod_anchor:<id>           (reuse same anchor)
        │       state.transcript_index_id = "spoken_word"
        │       (no SDK calls beyond background index_spoken_words(force=True))
        │       return state
        │
        ├── cached_event_count > 0 AND partial?             ◄── resume from offset
        │       state.started_at = vod_anchor:<id>
        │       worker spawned with resume_from_offset_s=cached_offset
        │
        └── 0 events ─► fresh classification:
                  asyncio.gather(
                      video.index_scenes(time_based 6s, prompt=VISUAL_…),
                      video.index_spoken_words(force=True),
                  )
                          │
                          ▼
                  state.started_at = time.time()    ◄── pin BEFORE worker spawn
                  db.set_state(f"vod_anchor:{video.id}", state.started_at)
                          │
                          ▼
                  asyncio.create_task(poll_scene_index_forever, resume_from_offset_s=…)
                          │
                          ▼
                  loop {
                    scenes = video.get_scene_index(id)         ── 20s wait_for
                    for new scene:
                       if scene.start < resume_floor: continue ── skip already-classified
                       evt = _structural_classify(scene.text)  ── vocab + non-zero confidence
                       if deduper.accept(evt):
                          db.insert_event(..., video_id=…)
                          db.set_state(f"vod_offset:{video.id}", scene.end)
                          bus.publish({"type": "event", "event": ...})
                  }
```

### B. RTStream (live RTSP/RTMP)

```
User clicks Start (source_type="url")
        │
        ▼
POST /api/start                                       (routes/lifecycle.py)
        │
        ▼
pipeline.start_pipeline(content_type=<mode>)          (pipeline.py)
        │
        ▼
_ensure_ws_listener()                                 ◄── starts WS subprocess
        │
        ▼
_resolve_source(...) → rtstream_url
        │
        ▼
coll.connect_rtstream(url, media_types=["audio","video"], store=True,
                       ws_connection_id=ws_id)        (pipeline.py)
        │
        ▼
state.rtstream_id = rt.id
state.video_id   = rt.id           ◄── per-video persistence applies here too
state.started_at = time.time()     ◄── pin BEFORE any indexer emits events
        │
        ▼
rt.start()
rt.index_visuals(prompt=visual_prompt, batch_config=…, ws_connection_id=ws_id)
rt.index_audio(prompt=AUDIO, batch_config=…, ws_connection_id=ws_id)
rt.start_transcript(ws_connection_id=ws_id)
        │
        ▼
WebSocket scenes → /tmp/videodb_events.jsonl
        │
        ▼
backend/classifier.py (jsonl tailer) → _classify_scene + _Deduper
                                     → bus.publish({"type": "event", "event": ...})
```

Public sample feed for testing: `rtsp://samples.rts.videodb.io:8554/crib`.
Time-to-first-event is ~30 seconds (one `batch_config` window). VideoDB
rejects localhost URLs; feeds must be publicly reachable.

---

## Pipeline state lifecycle

`pipeline.state` is a module-level `PipelineState` singleton:

```python
@dataclass
class PipelineState:
    started_at: float | None         # when indexing began (anchor for unix_ts math)
    starting_at: float | None        # set during /api/start, cleared on success
    source_type: str | None          # "video" | "url"
    source: str | None               # original URL or video_id
    content_type: str = "football"   # "football" | "describe"
    video_id: str | None             # m-prefixed VideoDB id (VOD path)
    vod_scene_index_id: str | None
    vod_total_scenes: int | None
    vod_indexed_scenes: int | None
    rtstream_id: str | None          # set on RTStream path
    rtstream_url: str | None
    sandbox_id: str | None
    ws_id: str | None
    visual_index_id: str | None      # mirror of vod_scene_index_id for /api/health
    audio_index_id: str | None
    transcript_index_id: str | None  # "spoken_word" sentinel once indexed
    video_length_s: float | None     # source runtime — drives indexing ETA
    live_stream_url: str | None
    live_player_url: str | None

    # Live SDK objects, not serialised:
    conn, coll, video, rtstream, sandbox, visual_idx, audio_idx
```

The `pipeline_state` SQLite KV table holds two per-video markers:

- `vod_anchor:<video_id>` — the wall-clock `started_at` used when the cached
  events were emitted. The rehydrate + resume paths reuse this so newly-
  classified events line up at the same in-video offsets as cached ones.
- `vod_offset:<video_id>` — the highest `scene.end` we've processed for this
  video. Drives the resume path; `>= video.length - 12` means fully indexed.

`state.public()` returns the JSON-safe shape that `/api/health` exposes.

**Transitions:**

```
IDLE → starting_at set → upload + reuse check → started_at set → LIVE
LIVE → /api/end_session → IDLE (state cleared, events stay in DB)
LIVE → /api/events/resync → wipes events for video_id → restarts pipeline → LIVE
```

---

## Event flow

```
VideoDB scene index
       │ (one row per 6s window)
       ▼
vod.poll_scene_index_forever
       │ classifies via _structural_classify:
       │   1. parse JSON from text/description (fence-stripping + brace-extract)
       │   2. event_type ∈ vocab + ≠ "none"
       │   3. confidence > 0.0
       │   4. _Deduper.accept(): no same (event_type, team) within 30s
       │      (cross-team dedupe for goals to absorb replay angles)
       ▼
db.insert_event(..., video_id=…)         ◄── persists to ./data/datacaster.db (bind-mount)
db.set_state(f"vod_offset:{video_id}", scene.end)   ◄── resume marker
       │
       ▼
bus.publish({"type": "event", "event": {...}})
       │
       ▼  fanout (in-process pub/sub, asyncio queues)
       ├──► routes/events.py SSE → frontend `<EventTimeline>`
       └──► commentary.py worker → coll.generate_text(model_name="basic"|"ultra")
                                   + coll.generate_voice(model_name="k2-fsa/OmniVoice", sandbox_id=…)
                                  → db.insert_commentary
                                  → bus.publish({"type": "commentary", ...})
                                  → SSE → /api/commentary/track
```

Quality control comes from the `VISUAL_FOOTBALL` prompt (defaults to `"none"`
on generic summaries) plus the temporal `_Deduper`. The bus is a tiny
`asyncio.Queue` fanout in `events_bus.py`; SSE subscribers attach via
`bus.subscribe()` and detach in a `finally`.

---

## VideoDB primitives used

| Primitive | Where | Why |
|---|---|---|
| `coll.upload(url, media_type="video")` | `source.py` | YouTube ingest; `media_type` forces Video over Audio classification. |
| `coll.get_video(id)` | `source.py` | Reuse fast path when source is an `m-` prefixed id. |
| `coll.get_videos()` | `routes/lifecycle.py` | Powers the "Your videos (N)…" preset dropdown. |
| `video.index_scenes(extraction_type=time_based, extraction_config={time:6, select_frames:["first","middle","last"]}, prompt=…)` | `pipeline.py` | The single classification pass. |
| `video.index_spoken_words(force=True)` | `pipeline.py` | Builds the spoken-word transcript index in parallel. Drives the Search panel's transcript tab on VOD. |
| `video.delete_scene_index(id)` | `pipeline.py` (Resync path) | Wipe stale indexes when prompts change. |
| `video.get_scene_index(id)` | `vod.py` (bounded by `asyncio.wait_for`) | The polling readback. |
| `video.generate_stream()` | `pipeline.py` | HLS URL for the StreamPanel. |
| `video.search(query, search_type=semantic, index_type=scene\|spoken_word, scene_index_id=…)` | `search.py`, `highlights.py` | `/api/search` + Ask evidence + highlight reel. |
| `coll.search(namespace="rtstream", index_type=scene\|audio\|spoken_word)` | `search.py` | RTStream search variant. |
| `coll.generate_text(prompt, model_name="basic"\|"ultra")` | `search.py`, `highlights.py`, `commentary.py` | Server-side LLM router. SDK only accepts `model_name ∈ {basic, pro, ultra}` — no `sandbox_id` kwarg. We pick `ultra` when a sandbox is allocated, `basic` otherwise. Returns `{"output": "..."}` (dict, not str) — every call site unwraps via `_unwrap_generate_text`. |
| `coll.generate_voice(text, model_name=VOICE_MODEL, sandbox_id=…)` | `commentary.py` | OmniVoice TTS for high-impact events. |
| `Timeline + VideoAsset + AudioAsset + generate_stream()` | `highlights.py` | Highlight composer + 9:16 reel composer (`/api/highlights/reel`). Resolution per aspect: 608×1080 vertical / 1080×1080 square / 1280×720 landscape. Heights ≤ 1080 because Timeline rejects taller renders. |
| `conn.create_sandbox(tier=…)` + lifecycle | `pipeline.py` | GPU sandbox allocation. Registered in `/tmp/datacaster_active_sandboxes.txt`; released on `/api/end_session`, FastAPI lifespan shutdown, SIGTERM, AND startup orphan sweep. |
| `conn.get_sandbox(id).stop()` | `backend/sandbox.py` | Used by the orphan sweeper. Scoped to the sidecar id list. |

---

## Multimodal search routing

| Source | `kind=visual` | `kind=transcript` | `kind=audio` |
|---|---|---|---|
| **VOD** (`m-` prefix) | `video.search(index_type=scene, scene_index_id=…)` | `video.search(index_type=spoken_word, search_type=semantic)` | **HTTP 400** — VOD has no audio search; UI hides the tab |
| **RTStream** | `coll.search(namespace="rtstream", index_type="scene")` | `coll.search(namespace="rtstream", index_type="spoken_word")` | `coll.search(namespace="rtstream", index_type="audio")` |

The Search panel renders **transcript rows as justified paragraphs** (full
sentences from the spoken-word index), **visual / audio rows as compact
single-line chips** with `line-clamp-2`. Every row click translates the
shot's `start` into an in-video offset and seeks the existing main player
via `lib/playerControl.ts:seekPlayer`.

---

## LLM-driven Ask flow

```
POST /api/ask  body={"q": "did anyone get a card?"}
        │
        ▼
1. LLM REWRITE — coll.generate_text("ultra")
   "Rewrite into 3 concrete search phrases…"
        │
        ▼ ["did anyone get a card?", "yellow card", "red card", "booking"]
        │
2. MULTI-RAIL SEARCH — for each phrase, fan out to scene + spoken_word
        │
        ├─ visual rail (scene index)
        └─ transcript rail (spoken_word)
                merged by (start, end), highest score wins
        │
        ▼  flat = visual + transcript
        ▼  filter: drop event_type="none", drop raw-JSON parse-fails
        ▼  sort by score desc
        │
3. LLM COMPOSE — coll.generate_text("ultra"), 12s timeout
   On failure: retry once at 25s
   On both fail: raise LLMComposeFailed → route returns HTTP 503
        │
        ▼
{ "query": "...",
  "answer": "Yes — two yellows. [00:18] referee ... [04:24] booking ...",
  "evidence": [...top shots, attached for trust] }
```

**No silent evidence-only fallback.** If the LLM compose call fails twice
(12s + 25s), the route returns HTTP 503 with a Retry button surfaced in
the frontend. Explicit product rule: an Ask answer is the LLM or it's an
error.

---

## Frontend layout

```
App.tsx
├── <header>
│   ├── Radio (orange #EC5B16) + DataCaster wordmark + status chip
│   ├── Centre tagline + VideoDB logo
│   └── StatusPill + uptime + End-session + ⋯ menu
│
├── <SourceControl />                               POST /api/start, /api/stop
│
└── <main grid>
    ├── <section col-span-6>          ──  StreamPanel + ReplayScrubber + QueryPanel
    │                                     ├── Ask / Search tabs (full-width)
    │                                     └── Search routes: visual / transcript [/audio]
    └── <section col-span-6>          ──  EventTimeline
                                          ├── filter strip (per content_type)
                                          ├── auto-scroll toggle
                                          ├── Resync button
                                          └── 📲 Reel last 3 (filled emerald button)
```

`StreamPanel` registers a singleton seeker in `lib/playerControl.ts` so
clicks on event timestamps + Search rows scrub the same `<video>` element
instead of remounting it.

`useEventStream` in `lib/api.ts` keeps a single SSE connection alive
across the whole app and fans out to subscribers via callback. The
dispatcher listens for `event`, `commentary`, `transcript`,
`session_ended`, `resync`, `cleared`, **and `vod_progress`** (the indexer
beacon that drives the `<IndexingProgress>` empty state).
