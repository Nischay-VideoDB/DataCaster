# DataCaster — Operations Guide

How DataCaster runs day-to-day: the services, the moving parts, the configuration
knobs, and what "normal" looks like in the logs and the UI.

If you're hitting a specific failure, jump straight to
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md). If you're reading this on a fresh
clone, start with the [`README`](../README.md).

---

## Run modes

There is exactly one supported run mode: **Docker Compose**.

```bash
docker compose up -d        # starts backend on :8000, frontend on :3000
docker compose logs -f      # tail both services
docker compose down         # stop everything
```

The repo also ships a `Makefile` with convenience targets:

```bash
make up         # docker compose up -d
make rebuild    # no-cache rebuild + force recreate (for code changes)
make logs       # tail both services
make smoke      # one-off SDK connectivity test
make down       # stop
```

For UI changes you almost always want `make rebuild` — Vite builds are baked
into the frontend image at `docker compose build` time, not mounted from the
host. Backend code changes can use `docker compose restart backend` since
uvicorn is the only service.

---

## Architecture in one paragraph

The frontend (React + Vite + Tailwind v4 + shadcn/ui) is served by nginx
on `:3000`. Nginx proxies everything under `/api/*` to the FastAPI backend on
`:8000`. The backend connects to VideoDB's hosted API for the actual video
work — uploading, scene indexing, semantic search, voice generation. Events
classified from VideoDB's scene-index JSON are persisted to a local SQLite
file (`datacaster.db`) and pushed to subscribers over Server-Sent Events.

For the longer version see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Background workers (under the uvicorn lifespan)

| Worker | What it does | Source |
|---|---|---|
| `vod_poller` | Polls VideoDB scene index every 5s, classifies new windows, persists + bus-publishes events | `backend/vod.py` |
| `commentary_worker` | Subscribes to the bus; for high-impact football events, generates a 30s broadcast script via `coll.generate_text` and TTS via `coll.generate_voice` | `backend/commentary.py` |
| `highlight_indexer` | Background loop. Refreshes the top-N highlight rows in SQLite every 60s via `video.search`; surfaced today via the on-demand reel composer (`/api/highlights/reel` + the **📲 Reel last 3** button), not via a passive right-rail panel. | `backend/highlights.py` |

The workers are spawned in `backend/main.py`'s lifespan handler and live for
the lifetime of the uvicorn process. `pipeline.start_pipeline` controls
whether the VOD poller runs (it's gated on whether a video has events
already cached — see "Persistence model" below).

---

## State files (where things actually live)

| Location | Contents | Cleared by |
|---|---|---|
| `./datacaster.db` (SQLite, **bind-mounted** into container at `/app/datacaster.db`) | events, commentary, highlights, `pipeline_state` KV (vod_offset, vod_anchor, started_at) | `db.clear_events_for_video(id)` (Resync), or `rm ./datacaster.db` for a full wipe |
| `/tmp/videodb_events.jsonl` | Raw WebSocket events from VideoDB (RTStream path only) | Container restart |
| `/tmp/videodb_ws_id` | The active WS connection id | Container restart |
| `/tmp/datacaster_active_sandboxes.txt` | Sidecar list of allocated sandbox ids | Cleared as ids stop / on startup sweep |
| In-memory `pipeline.state` | Runtime SDK handles, video_id, scene_index_id, started_at | Backend restart, `/api/end_session` |

**Persistence model — the cost-saving cache.** Events are tagged with
`video_id` and persist across container rebuilds via the bind mount. The
rehydrate gate in `_start_vod_pipeline` has three branches:

1. **Fully indexed** (`vod_offset >= video.length - 12`) → instant rehydrate.
   No SDK calls, no sandbox spend; the SSE replay-on-connect feeds the
   timeline from `db.list_events_for_video()` immediately. The reused
   `vod_anchor:<video_id>` keeps cached events at the right in-video offsets.
2. **Partial cache** (events > 0 but offset < length) → resume mode. Worker
   spawns with `resume_from_offset_s = cached_offset` and skips
   classification for any scene whose `start < resume_floor`. So a Stop
   at scene 100 picks up at scene 101, no re-billing the LLM.
3. **No cache** → fresh classification.

To force a re-classification under updated prompts, hit the **Resync** button
in the Event Timeline header (`POST /api/events/resync`). Resync wipes
events for the active `video_id`, clears `vod_offset:` + `vod_anchor:`
markers, and **deletes the VideoDB scene index** so the next Start rebuilds
under the current prompt.

`/api/end_session` stops the pipeline + clears in-memory state + releases
the sandbox, but **does NOT wipe the events table**. Events stay
queryable per `video_id` until Resync or `rm ./datacaster.db`.

---

## Configuration knobs

Set in `.env` (gitignored) — see `.env.example` for the full set.

| Variable | Default | What it does |
|---|---|---|
| `VIDEO_DB_API_KEY` | (required) | Your VideoDB API key. Get one at `console.videodb.io`. |
| `USE_SANDBOX` | `true` | When `true`, every Start spins up a hackathon sandbox (paid). Set to `false` to fall back to VideoDB's free-tier defaults. |
| `SANDBOX_TIER` | `small` | `small` ($1/hr, 4 slots) or `medium` ($3.50/hr, 3 slots). VideoDB's medium-tier provisioning has been intermittent during the hackathon; small tier is more reliable. |
| `VISUAL_MODEL` | `google/gemma-4-E2B-it` | Visual scene description model for the **RTStream** `rt.index_visuals` path. The VOD `video.index_scenes` path uses the default model (medium-tier 31B Gemma kept hanging at the indexer queue). |
| `AUDIO_MODEL` | `Qwen/Qwen3.5-9B` | Audio classifier (RTStream only). Small-tier. |
| `VOICE_MODEL` | `k2-fsa/OmniVoice` | TTS for commentary. Small-tier; sandbox-routed via `coll.generate_voice(sandbox_id=…)`. |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram Bot API token (from @BotFather). Required for `/api/highlights/reel` to deliver to Telegram. |
| `TELEGRAM_CHAT_ID` | unset | Numeric chat id (DM @userinfobot to find it). Required alongside `TELEGRAM_BOT_TOKEN`. |

**Important LLM-routing note**: `coll.generate_text` does **not** accept
`sandbox_id` or HuggingFace model ids — its only valid `model_name` values
are `basic`, `pro`, `ultra`. The Ask + recap + commentary call sites pick
`ultra` when a sandbox is allocated, `basic` otherwise. The 31B Gemma /
2B Gemma names above only apply to the indexer endpoints (`index_scenes`,
`rt.index_visuals`).

**Code-level knobs** that are deliberately *not* in the env (changing these
needs a code review + smoke test):

- `backend/config.py` — `EVENT_VOCAB`, `GENERIC_VOCAB`,
  `COMMENTARY_EVENT_TYPES`, `COMMENTARY_MIN_CONFIDENCE`.
- `backend/vod.py` — `_DEDUPE_WINDOW_S` (single 30s structural window). An
  LLM validator stub is defined in `_llm_validates_summary` but disabled in
  the poll loop because each call is ~6-12s on `coll.generate_text("ultra")`
  and the worker walks scenes sequentially.
- `backend/prompts.py` — `VISUAL_FOOTBALL`, `VISUAL_DESCRIBE`,
  `VISUAL_PROMPTS`, `COMMENTARY_*`.

---

## Routine commands

```bash
# Day-to-day
make up                                  # start everything
make logs                                # follow both services
make down                                # stop everything
make rebuild                             # no-cache rebuild + restart

# Health
curl -s localhost:8000/api/health | jq   # backend pipeline state
curl -s localhost:8000/api/stats  | jq   # active-video event counts
curl -s localhost:8000/api/videos | jq   # videos in your VideoDB collection

# Backend-only restart (faster for backend-only fixes)
docker compose restart backend

# Inspect persisted events
sqlite3 datacaster.db "SELECT video_id, COUNT(*) FROM events GROUP BY video_id;"

# End-to-end test (six phases — see `test-datacaster.py` docstring)
python test-datacaster.py --phase A      # idle suite, ~10s, no API spend
python test-datacaster.py --phase D      # frontend bundle reachability
python test-datacaster.py --phase F      # Telegram delivery probe (~5s, requires bot env)
python test-datacaster.py --phase E      # RTStream live ingest (~3 min, real VideoDB)
python test-datacaster.py --phase B      # football VOD run (~4 min, real VideoDB)
python test-datacaster.py --phase C      # describe-mode VOD run (~3 min)
python test-datacaster.py                # full A→F run (~14 min total)
```

---

## What "normal" looks like

### After `make up` + opening `localhost:3000`

- Header shows: logo, "Football scout · automated using" + VideoDB wordmark,
  IDLE pill on the right.
- Source bar: type dropdown (YouTube VOD / RTSP/RTMP URL), text input, the
  "Your videos (N)…" dropdown listing previously-uploaded videos, Start
  button.
- Event Timeline empty: "Click Start to begin tracing events."
- Ask DataCaster panel: empty input, suggested prompt chips.

### After clicking Start with a previously-indexed video

- Reuse path fires: `[source] reusing existing video id=…` in backend logs.
- Rehydrate gate: `[pipeline] VOD video_id=… fully indexed previously
  (N events, offset=…s) — instant rehydrate.`
- `started_at` set immediately (reused from `vod_anchor:<id>`). UI flips to
  VOD pill in <1s.
- Timeline populates from disk via SSE replay-on-connect. **No SDK calls,
  no sandbox spend, no validator runs.**

### After clicking Start with a partially-indexed video (Stop mid-run)

- `[pipeline] VOD video_id=… partial cache: N events, offset=Xs/Ys —
  resuming.`
- Worker spawns with `resume_from_offset_s=X`; classifier skips scenes
  whose start < X. Picks up where the previous run left off.

### After clicking Start with a fresh video

- `[pipeline] creating sandbox tier=small`
- `[source] uploading VOD url=https://youtu.be/…` (or
  `[source] reusing existing video id=…` if previously uploaded)
- 30-90s for upload + transcode (`length=NNNN.Ns` log line confirms ready).
- Either:
  - `[pipeline] VOD json index <id> exists with N scenes — reusing.`
    (cached on VideoDB side; fast path), OR
  - 3-6 minutes of silent indexing (fresh `index_scenes` call).
- First batch: `[vod] vod batch: +N new scenes (total=M)`.
- Timeline starts populating; commentary worker picks up high-impact
  events when within OmniVoice cap.

### Healthy log shape

```
[pipeline]   INFO creating sandbox tier=small
[source]     INFO reusing existing video id=m-z-...  length=1978.5s
[pipeline]   INFO VOD json index <id> exists with 337 scenes — reusing.
[pipeline]   INFO VOD indexes ready scene=<id> transcript=spoken_word
[vod]        INFO vod batch: +5 new scenes (total=12)
[commentary] INFO commentary stored id=1 event_id=3 audio=yes len=412
```

---

## Cost monitoring

Default config (`USE_SANDBOX=true`, tier `small`):

| Step | Notes |
|---|---|
| Sandbox compute | $1/hr (small) or $3.50/hr (medium). Released on `/api/end_session`, container shutdown, SIGTERM, AND startup orphan sweep. |
| Upload + transcode | ~1 credit per minute of source video |
| Scene index + spoken-word index (parallel) | ~1 credit per 6s scene window + transcript credits per minute |
| `coll.generate_text(model_name="ultra")` (Ask rewrite + compose, recap, commentary) | ~0.1 credit per call; routed server-side, NOT via sandbox |
| `coll.generate_voice(sandbox_id=…)` (commentary) | OmniVoice via sandbox; per-account cap still applies, 5-min backoff on cap hit |

A 33-min YouTube source: ~$2-3 in credits + the sandbox-hour rate while
the session is active. **Re-running the same video is free** — events
cached by `video_id` in the bind-mounted `./datacaster.db` rehydrate
instantly with zero SDK calls.

Drop to `USE_SANDBOX=false` to skip the sandbox layer entirely and use
VideoDB's free-tier defaults (lower-quality classifier; Ask falls back to
`coll.generate_text(model_name="basic")`).

**Important:** events persist by `video_id`. Re-running the same video
re-uses cached events — no re-indexing, no re-billing. Only the sandbox
hour ticks while the session window is open.

`/api/videos` lists all videos in your VideoDB collection. Use it to spot
videos you forgot you uploaded.

---

## Pre-submission checklist

```bash
# 1. Fresh-clone smoke test
git clone https://github.com/sahil-sharma-50/DataCaster /tmp/dc-fresh && cd /tmp/dc-fresh
cp .env.example .env && $EDITOR .env   # set VIDEO_DB_API_KEY
                                       # optional: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
docker compose up -d --build
open http://localhost:3000

# 2. Confirm secrets are not committed
git ls-files | grep -E "(\.env$|api[_-]?key)"   # must return nothing
git grep -i "sk-[a-z0-9]" -- '*.py' '*.ts' '*.json' '*.md' || echo "OK — no live keys tracked"

# 3. Run the offline test tiers (no API spend)
python test-datacaster.py --phase A     # idle assertions
python test-datacaster.py --phase D     # frontend bundle reachability
python test-datacaster.py --phase F     # Telegram delivery probe (skips T29 by default)

# 4. (Optional) end-to-end with real VideoDB (~14 min, paid)
python test-datacaster.py               # phases A→F

# 5. Update the demo video / 200-word description if behaviour changed
```

---

## Related docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system shape, data flow, VideoDB primitives used.
- [`API.md`](API.md) — every backend endpoint with payload + response shape.
- [`CLASSIFIER_TUNING.md`](CLASSIFIER_TUNING.md) — the locked-in prompt + threshold config.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — symptom-first failure playbook.
- [`SANDBOX.md`](SANDBOX.md) — VideoDB hackathon SDK reference.
