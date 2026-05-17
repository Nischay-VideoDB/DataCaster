# DataCaster — Troubleshooting Playbook

Symptom-first guide. Find the row that matches what you see, follow the
**check** steps, then apply the **fix**. Every section ends with a one-line
"if all else fails" escape hatch.

If you've never run DataCaster before, start with the [`README`](../README.md)
or [`OPERATIONS.md`](OPERATIONS.md). For VideoDB SDK specifics, see
[`SANDBOX.md`](SANDBOX.md).

---

## 0. Quick diagnostic cheat sheet

```bash
# Are both services up?
docker compose ps

# Is the backend healthy?
curl -s localhost:8000/api/health | jq .pipeline

# What's in the events DB right now?
sqlite3 data/datacaster.db "SELECT video_id, event_type, COUNT(*) \
                       FROM events GROUP BY video_id, event_type;"

# Tail logs for both services
docker compose logs -f --tail 100

# Backend-only logs, filtering out access spam
docker compose logs --since 5m backend 2>&1 \
  | grep -v "GET /api\|POST /api\|HTTP/1.1"

# Force a hard restart that preserves the DB
docker compose restart backend frontend
```

---

## 1. UI loads but the timeline shows "Indexing… first scene usually appears 3-6 minutes after Start"

This is the normal indexing-in-flight message. Free-tier scene indexing on a
33-min video takes 3-6 minutes for the first batch. Wait it out.

**Confirm the worker is making progress:**

```bash
docker compose logs --since 1m backend 2>&1 | grep -E "vod batch|scene index"
```

You should see `[vod] vod batch: +N new scenes (total=M)` lines once VideoDB
starts emitting scenes. If you see only the initial `[pipeline] VOD scene
index started …` and nothing else after 8 minutes, see Section 4.

**If a previously-indexed video isn't re-hydrating instantly:** the events
table doesn't have rows for that `video_id`. Check:

```bash
sqlite3 data/datacaster.db "SELECT COUNT(*) FROM events WHERE video_id = 'm-z-…';"
```

Zero rows means the previous run was wiped (manual SQL delete, Resync
button, or a fresh `./data/datacaster.db` file).

---

## 2. `/api/start` returns 500

**Read the actual error.** The route now logs the full traceback before
raising 500. The frontend's humanize layer pulls FastAPI's `detail` field
into the toast.

```bash
docker compose logs --since 30s backend 2>&1 | grep -A 20 "exception\|Traceback"
```

**Common causes:**

| Detail | Meaning | Fix |
|---|---|---|
| `Invalid request: Download failed` | VideoDB couldn't fetch the YouTube URL (signature rotation, region-lock, age-gate) | Retry — usually transient. Or use a different URL. |
| `coll.upload returned None` | Upload genuinely failed | Check `VIDEO_DB_API_KEY`, then retry. |
| `unsupported content_type 'X'` | The route accepts `football` or `describe` only | Send the right value via `/api/start` JSON body. |
| `Stuck on processing status` | VideoDB transcoder backlogged | Wait ~30s, retry. |

If the upload returns an `Audio` object (id prefix `a-`) instead of a
`Video` (id prefix `m-`), the `media_type="video"` kwarg + `coll.get_video`
fallback in `backend/source.py:upload_vod` should self-recover. If not,
log the type returned and check the SDK version.

---

## 3. Sandbox won't provision (USE_SANDBOX=true)

```bash
docker compose logs --since 2m backend 2>&1 | grep -i sandbox
```

Look for `creating sandbox tier=…` followed by either:
- `Sandbox bx-… not ready within 300s` — VideoDB orchestrator stalled at
  the provisioning step. **Common during the hackathon** — both medium
  and small tiers have intermittent provisioning failures. The leaked
  sandbox transitions `provisioning → failed` on its own after our
  300s timeout. Click Start again; usually succeeds on the second try.
- Silent — usually credits exhausted; check `console.videodb.io`.

If your account hits the per-tier cap:

```
Maximum active sandboxes for tier 'medium' reached (3/3)
```

…it usually means orphans accumulated. Drop tier (`SANDBOX_TIER=small`
in `.env` — small has its own 4-slot pool) and `docker compose up -d
--force-recreate backend` to pick up the change.

**Sandbox lifecycle.** Allocation registers the id in
`/tmp/datacaster_active_sandboxes.txt`. Release happens via:

- `/api/end_session` (UI End-session button)
- FastAPI lifespan shutdown (`docker compose down`, clean `restart backend`)
- `SIGTERM` handler in `backend/bootstrap.py`
- Startup orphan sweep — on every backend boot, any id still in the
  sidecar is looked up via `conn.get_sandbox(id)` and stopped.

If you suspect a leak (or used `docker compose kill backend` which bypasses
SIGTERM), run the **manual sweep** before starting a new session:

```bash
curl -s -X POST localhost:8000/api/sandbox/sweep | jq
# {"stopped": N}
```

The sweep is sidecar-scoped — it will never stop a sandbox that another
machine on the same VideoDB account allocated. Last-resort wipe (use only
if you're certain no other DataCaster instances are sharing the key):

```bash
docker compose exec backend python -c "
import videodb
conn = videodb.connect()
for s in conn.list_sandboxes(status='running'):
    print(s.id); s.stop()
"
```

---

## 4. Events not appearing after 8+ minutes

Real bug, not just slow indexing. Decision tree:

```bash
# Is the scene index registered?
curl -s localhost:8000/api/health | jq .pipeline.vod_scene_index_id

# Is the worker running?
docker compose exec backend ps aux | grep python   # uvicorn process alive?

# Is VideoDB producing scenes?
docker compose exec backend python -c "
import videodb
conn = videodb.connect(); coll = conn.get_collection()
v = coll.get_video('YOUR-VIDEO-ID')
scenes = v.get_scene_index('YOUR-SCENE-INDEX-ID')
print(f'{len(scenes) if scenes else 0} scenes')
"
```

If VideoDB has 0 scenes after 8 min, something is wrong on their side
(model queue, billing). If VideoDB has scenes but the timeline is empty,
the polling worker errored — search logs for `get_scene_index failed`.

---

## 5. Search returns no results

```bash
curl -s 'localhost:8000/api/search?q=red+card&kind=visual' | jq .shots
```

**Empty list, but events exist:** VideoDB's semantic search applies its own
score threshold below which it raises `InvalidRequestError("No results
found")`. Bare words like `card` often fall below this floor.

Fix: use multi-word queries (`red card`, `yellow card`). Ask DataCaster does
this automatically via the LLM rewrite step in `backend/search.py`.

**Empty list, no events at all:** check the events DB:

```bash
curl -s localhost:8000/api/stats | jq
```

If `total: 0`, you're not in a "search broken" state — you're in a "no
events ingested" state. Go back to Section 4.

---

## 6. Ask returns "Server error — Ask is temporarily unavailable…" (HTTP 503)

Symptom: the red error banner with the **Retry** button after asking a
question.

**Cause:** the LLM compose call (`coll.generate_text(model_name="ultra")`)
either timed out (the backend retries once: 12s → 25s, then gives up) or
errored. The route deliberately does NOT silently fall back to raw
evidence — the explicit product rule is *"an Ask answer is the LLM or
it's an error"*.

**Diagnose:**

```bash
docker compose logs --since 2m backend 2>&1 | \
  grep -E "compose attempt|generate_text|/api/ask"
```

Common patterns:

- `compose attempt 1 failed; retrying with 25s timeout` followed by
  another fail — small-tier sandbox is queue-pressed. Click Retry; usually
  succeeds.
- `generate_text error TypeError` — the SDK kwarg shape changed. We unwrap
  `{"output": "..."}` dict responses; if the SDK switches to a new shape,
  add it to `_unwrap_generate_text` in `backend/search.py`.
- Empty `evidence: []` plus 200 OK with empty `answer` — the search
  returned no shots, the LLM correctly said "no evidence". This is
  not a 503 case; the frontend renders "No matching evidence in the
  indexed timeline."

**Fix:** click Retry. If it persists, drop to `model_name="basic"`
temporarily by setting `USE_SANDBOX=false` in `.env` + recreate the
backend container.

---

## 7. Commentary not generating automatically

Default thresholds (`backend/config.py`):

```python
COMMENTARY_EVENT_TYPES = {"goal", "red_card", "penalty", "save",
                          "shot_on_target", "corner"}
COMMENTARY_MIN_CONFIDENCE = 0.5
```

Confirm classifier confidence is high enough and the event type is in the
set. Check `audio=script-only` in logs:

```bash
docker compose logs --since 5m backend 2>&1 | grep "commentary stored"
```

`audio=yes` means TTS succeeded. `audio=script-only` means the per-account
voice quota tripped — the worker enters a 5-minute backoff and retries.
Per-account voice generation has a hard daily cap on the free tier; the
script (text only) still saves to disk.

---

## 8. End-session doesn't clear the timeline

If the timeline still shows events after End-session, hard-refresh the
browser. The frontend listens for the `session_ended` SSE message and
clears local state, but a stale tab can lag.

**Idle-state DB rows are NOT a bug.** Events persist by `video_id` so the
next Start of the same video re-hydrates instantly. To wipe events for a
specific video manually:

```bash
sqlite3 data/datacaster.db "DELETE FROM events WHERE video_id = 'm-z-…';
                       DELETE FROM commentary
                       WHERE event_id IN (SELECT id FROM events
                                          WHERE video_id = 'm-z-…');"
```

Or use the **Resync** button in the Event Timeline header — it does the
same delete, then restarts the pipeline so a fresh classification runs.

---

## 9. Container won't start / port conflict

```bash
docker compose up -d 2>&1 | tail -10
```

`bind: address already in use` → something else owns 3000 or 8000.

```bash
lsof -i :3000   # or :8000
```

Kill the process or change the host port in `docker-compose.yml`.

---

## 10. Frontend looks broken even though backend says ok

Most often: cached bundle.

```bash
# 1. Hard-refresh the tab: Cmd-Shift-R (Chrome/Edge/Firefox)
#                         Cmd-Option-R (Safari)
# 2. Or open in Incognito.

# Verify the served bundle has the latest code:
curl -s localhost:3000/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1
```

If the bundle hash matches what the container has but the UI still looks
old, wipe the browser cache for `localhost:3000`.

---

## 11. Common file-permission gotcha (logo doesn't render)

Symptom: a broken-image icon next to "Football scout · automated using" in
the header.

```bash
ls -la frontend/public/videodb-logo.png
```

Mode must be world-readable (`-rw-r--r--`). macOS `cp` from a
sandboxed folder (e.g. clipboard cache) preserves `600`, which nginx
running as `nginx` user can't read → 403.

```bash
chmod 644 frontend/public/videodb-logo.png
make rebuild
```

---

## 12. Known hard limits (don't try to "fix" these)

- **VideoDB rejects local-only RTMP URLs.** Source must be publicly
  reachable. For file-mode (which is currently disabled in the UI) you'd
  need a public tunnel.
- **Live YouTube URLs do NOT work.** Neither `coll.upload` nor
  `coll.connect_rtstream` accepts a YouTube live URL. Wait for the VOD
  publish or use a real RTSP/RTMP source.
- **Audio search is RTStream-only.** The SDK's `video.search` for VOD
  exposes scene + spoken_word indexes only; there's no audio namespace.
  The frontend hides the audio tab on VOD sources.
- **`coll.generate_text` only takes `model_name ∈ {basic, pro, ultra}`.**
  No `sandbox_id`, no HuggingFace model ids on this endpoint. The sandbox
  routing for `index_scenes` / `index_visuals` does NOT apply here.
- **`coll.generate_text` returns a `dict`** (`{"output": "..."}`), not a
  bare string. Every call site unwraps with `_unwrap_generate_text` /
  the equivalent inline check.
- **Free-tier voice cap.** ~3 commentary clips per session before the
  per-account cap trips. Per-account, not per-pipeline.
- **Cold-start indexing latency.** A 33-min video = ~330 windows = 3-6
  min wait before first events on the default model. Not a bug.
- **`coll.upload` may classify some YouTube URLs as Audio.** The
  `media_type="video"` kwarg + `get_video` fallback in `upload_vod` handle
  this; don't remove them.
- **VideoDB sandbox provisioning is intermittent.** Both medium and
  small tiers occasionally time out the 300s `wait_for_ready` budget;
  the sandbox flips `provisioning → failed` on its own. Click Start
  again. Server-side issue, not DataCaster.
- **No live RTSP / RTMP demo.** The path exists but isn't tested
  end-to-end. VOD via YouTube is the primary path.

---

## 13. Last-resort full reset

```bash
docker compose down                 # stop containers
rm -f data/datacaster.db            # nuke the events DB
rm -f /tmp/videodb_events.jsonl     # nuke the JSONL tail
docker compose build --no-cache     # rebuild images
docker compose up -d                # start
```

This is destructive — all persisted events for every video are gone. Only
do it if you're certain something in the DB itself is corrupt.
