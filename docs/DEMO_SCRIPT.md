# DataCaster — Demo video screenplay

90-second walkthrough for the hackathon submission. Hits every primitive
on the rubric (RTStream + Search/Memory + generative + programmable
editing) plus the polish moments judges remember.

Record with **QuickTime** (`Cmd+Shift+5` → record selection). Window
size **1280×800** so it reads at YouTube unlisted scale. Two takes
minimum; pick the one with the cleaner click cadence.

---

## Pre-flight (do once before the recording)

```bash
# 1. Make sure docker is up + containers fresh.
make rebuild
sleep 5
curl -s localhost:8000/api/health | jq .pipeline.started_at   # → null

# 2. Pre-upload the demo video so the reuse path lights up on Start.
#    Open localhost:3000 → pick YouTube VOD → paste:
#    https://youtu.be/DP4epIVQOCk
#    Click Start, wait once for the ~3-minute index pass to finish.
#    End-session. The events are now persisted by video_id.

# 3. Verify the catalog dropdown shows the video.
curl -s localhost:8000/api/videos | jq '.videos | length'      # → ≥1

# 4. Ensure Telegram creds are set in .env so the reel delivery beat
#    actually shows the "Sent to Telegram" badge during the recording.
grep TELEGRAM .env
```

---

## Scene-by-scene

### 0:00 – 0:08 — Idle

**Show.** Browser tab opens to `localhost:3000`. Header reads:
`DataCaster · FOOTBALL SCOUT · AUTOMATED USING [VideoDB logo]`.
SourceControl bar empty. Timeline says "Click Start to begin tracing
events."

**Voiceover.** *"DataCaster automates the football scouting workflow
that Sportradar and Stats Perform run by hand. One pipeline, three
products: structured events, searchable memory, programmable editing."*

### 0:08 – 0:22 — Re-hydrate VOD start

**Action.** Click the **YouTube VOD** type. Click the catalog dropdown
→ pick the pre-uploaded video. Click **Start**.

**Show.** Status pill flips IDLE → CONNECTING → VOD · N events within
1 second. Timeline populates from disk *immediately* (rehydrate from
the bind-mounted SQLite cache — zero SDK calls, zero sandbox spend).
Stream player attaches.

**Voiceover.** *"Events are cached by video id in a bind-mounted SQLite
file, so re-running an already-classified match is instant. No re-
upload, no re-indexing, no LLM calls."*

### 0:22 – 0:36 — Click an event → seek + commentary

**Action.** Filter the timeline to **GOALS**. Click a high-scoring goal
row.

**Show.** Player scrubs to the goal moment. (If commentary is enabled and
within voice quota: short broadcast clip auto-plays.)

**Voiceover.** *"Click any event and the player scrubs to the exact
moment. High-impact moments are auto-narrated by OmniVoice."*

### 0:36 – 0:50 — Live RTStream demo

**Action.** Click **End session** → confirm. Timeline clears. Pick
**RTSP / RTMP URL** type → choose the *"VideoDB sample · live RTSP
feed"* preset → Start.

**Show.** Status pill shows LIVE within 3 seconds (no upload phase).
First events appear ~30 seconds later. Video player attaches to the
public sample feed.

**Voiceover.** *"Same pipeline, live ingest. RTStream lights up the
visual, audio, and transcript indexes concurrently. Time-to-first-event:
about 30 seconds."*

*(Cut here if you want to keep it under 90s — the RTStream beat only
needs to PROVE that the live path runs.)*

### 0:50 – 1:10 — Programmable editing wedge

**Action.** End the RTStream session → Start the cached YouTube VOD
again. Wait 1-2 seconds for the timeline to repopulate. Click
**📲 Reel last 3** (top-right of the timeline header).

**Show.** Reel dialog opens within ~60 seconds. 9:16 vertical preview
auto-plays. Scout-grade recap caption fills the textarea. Telegram
badge: **Sent to Telegram · #N**. Cut to the actual Telegram chat for
2-3 seconds — the bot has just posted the reel.

**Voiceover.** *"One click composes a 9:16 reel via VideoDB Timeline,
generates a 30-second recap with `coll.generate_text`, and posts it to
Telegram via the Bot API. Wire it into anything: Slack, the web, a
phone."*

### 1:10 – 1:25 — Ask DataCaster

**Action.** Type into the Ask bar: *"did anyone get a red card?"*
Press Enter.

**Show.** A scout-grade answer comes back in ~10-15 seconds, with
inline `[MM:SS]` citations. The answer is composed end-to-end by
`coll.generate_text(model_name="ultra")` — a real LLM call, not a
heuristic stitch.

**Voiceover.** *"Ask runs end-to-end through the LLM. The model
rewrites the question into concrete search phrases, fans those out
across the visual and transcript indexes, then composes a scout-grade
answer with inline citations. No hardcoded synonym tables, no
heuristic fallback — if the LLM fails, you see a Retry button, never
a fake answer."*

### 1:25 – 1:30 — Cue out

**Show.** Header logo + tagline. Cut.

**Voiceover.** *"DataCaster. RTStream + Search + Memory + Programmable
editing in one pipeline."*

---

## Gotchas to watch on the take

- Hard-refresh the tab (`Cmd-Shift-R`) before hitting record so the
  bundle is fresh and the QuickTime capture doesn't catch a stale UI.
- Stop any other Docker projects on the same machine to keep `:8000`
  and `:3000` free of port-conflict toasts.
- If the public RTSP sample is down (it has been historically), swap
  the preset for a local `mediamtx` loop:
  ```bash
  bash scripts/start_mediamtx.sh
  bash scripts/start_pipeline.sh ~/Movies/match.mp4
  ```
- If the reel takes >90 s to compose, end the session and try again —
  Timeline `generate_stream` occasionally queues behind another job on
  the free tier. Don't show the spinner for >15 s on camera.

---

## Upload + paste

```bash
# 1. Trim with QuickTime to ≤90 s.
# 2. Export 1080p H.264.
# 3. Upload to YouTube as Unlisted.
# 4. Paste the URL into SUBMISSION.md (top, "Demo video:" line).
```
