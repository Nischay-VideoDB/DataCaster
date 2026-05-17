# DataCaster — VideoDB Hackathon Submission

**Repo:** `https://github.com/sahil-sharma-50/DataCaster`
**Demo video:** `https://youtu.be/lR99z0Jel-4`
**Live link:** `http://localhost:3000` after `docker compose up -d`

---

## 200-word description (paste into the submission form)

DataCaster automates the football scouting workflow.
Point it at a YouTube match or a live
RTSP/RTMP feed; VideoDB ingests, indexes, and exposes four
production-ready surfaces from one pipeline.

**Structured event JSON feed** — every goal, save, card, corner is
classified per a strict football schema with confidence and team labels,
persisted by `video_id` to a bind-mounted SQLite cache so re-runs cost
zero credits. **Multimodal search** — visual, transcript, and audio
indexes routed per tab, every result row click seeks the existing
player. **LLM-driven Ask** — `coll.generate_text` rewrites the question,
fans out across scene + spoken-word indexes, composes a scout-grade
answer with `[MM:SS]` citations; on LLM failure returns HTTP 503 (no
silent fallback). **Programmable editing → Telegram** — one-click 9:16
reel of the last N events, prose recap caption, posted to Telegram via
Bot API.

Built solo across the 48-hour window using the hackathon SDK. Hits
RTStream + Search/Memory + generative + programmable editing — every
primitive on the rubric, layered into one shippable workflow rather than
a toy demo. Sandbox lifecycle is hardened: lifespan shutdown, SIGTERM,
sidecar-tracked sweeper. Test runner exercises VOD, describe-mode, live
RTStream, Telegram delivery, and sandbox lifecycle end-to-end. ~ 198 words.

---

## VideoDB primitives used

| Primitive | What it powers |
|---|---|
| `coll.upload(media_type="video")` | YouTube VOD ingest |
| `coll.get_video(id)` | Reuse fast path — skips re-upload on indexed videos |
| `coll.get_videos()` | "Your videos (N)…" preset dropdown |
| `coll.connect_rtstream(...)` | Live RTSP/RTMP path (Phase E exercises it) |
| `rt.index_visuals` + `rt.index_audio` + `rt.start_transcript` | Live ingest indexing |
| `video.index_scenes(time_based 6s, prompt=…)` | Single-pass football classifier |
| `video.index_spoken_words(force=True)` | Drives the Search panel's transcript tab |
| `video.delete_scene_index` | Resync wipes the stale index before rebuilding |
| `video.get_scene_index` | VOD polling readback (resume-aware) |
| `video.generate_stream` | HLS for the StreamPanel + reel preview |
| `video.search(semantic, index_type=scene\|spoken_word, scene_index_id=…)` | `/api/search` (visual + transcript tabs) + Ask evidence |
| `coll.search(namespace="rtstream", index_type=scene\|audio\|spoken_word)` | Live-feed search variant |
| `coll.generate_text(model_name="basic"\|"ultra")` | Ask rewrite + compose, reel recap, commentary scripts |
| `coll.generate_voice(model_name="k2-fsa/OmniVoice", sandbox_id=…)` | OmniVoice TTS, sandbox-routed |
| `Timeline + VideoAsset + Track + generate_stream` | 9:16 reel composer at 608×1080 |
| `conn.create_sandbox(tier=…)` lifecycle | Sandbox routing + sidecar-tracked orphan sweep |

---

## Mandatory check (from the brief)

- [x] **`CaptureSession` or `RTStream`** — `coll.connect_rtstream(...)` +
  `rt.index_visuals` / `index_audio` / `start_transcript`. Public RTSP
  preset shipped in the UI; `test-datacaster.py --phase E` exercises it
  end-to-end.
- [x] **`Search` / `Memory` / `Context`** —
  `video.search(index_type=scene\|spoken_word)` + per-`video_id`
  bind-mounted SQLite persistence + LLM-driven Ask via
  `coll.generate_text`. Memory survives every `make rebuild`; Resync
  force-rebuilds with a fresh VideoDB scene index.

---

## Run it in 60 seconds

```bash
git clone https://github.com/sahil-sharma-50/DataCaster && cd DataCaster
cp .env.example .env
# Edit .env: paste your VIDEO_DB_API_KEY (required).
# Optional: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for reel delivery.
docker compose up -d
open http://localhost:3000
```

In the UI: pick **YouTube VOD** → paste a URL or pick a previously-
uploaded video → Start. After ~3 minutes you'll see events stream into
the timeline. **Re-loading the same video is instant** — events cache by
`video_id` in `./data/datacaster.db` (bind-mounted) and the rehydrate path
returns immediately with zero SDK calls. Click **📲 Reel last 3** (top-
right of the timeline) to compose a 9:16 highlight, generate a recap
caption, and post it to Telegram.

For the live-ingest demo: pick **RTSP / RTMP URL** → choose the
"VideoDB sample · live RTSP feed" preset → Start. First events arrive
in ~30 seconds.

---

## Test plan

```bash
python test-datacaster.py --phase A      # idle (<10s, no API spend)
python test-datacaster.py --phase D      # frontend bundle check
python test-datacaster.py --phase F      # Telegram delivery probe (~5s)
python test-datacaster.py --phase B      # football VOD (~4 min, paid)
python test-datacaster.py --phase C      # describe-mode VOD (~3 min)
python test-datacaster.py --phase E      # live RTStream (~3 min)
python test-datacaster.py --phase G      # sandbox lifecycle (~30s+)
python test-datacaster.py                # full run (~16 min)
```
