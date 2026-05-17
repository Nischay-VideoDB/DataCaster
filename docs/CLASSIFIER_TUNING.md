# Classifier Tuning

The DataCaster classifier is **prompt-first**. Quality control comes from a
strict `VISUAL_FOOTBALL` prompt that defaults to `event_type: "none"` on
generic summaries, plus two structural guards (vocab membership + temporal
deduper). No hardcoded confidence floors, no synonym tables, no regex over
summaries.

This doc explains every layer that's currently in the code.

---

## Layer 1 — `VISUAL_FOOTBALL` prompt (`backend/prompts.py`)

The prompt is the **primary** quality lever. Three things it has to do:

- **Default to `event_type: "none"`.** Roughly 9 out of 10 broadcast windows
  are midfield play, replays, dugout shots, commentator close-ups. The model
  must be told this — without the prior, it tries to label every window.
  Rule 0 of the prompt makes this explicit.
- **Reject the score graphic as a goal cue.** *"The mere presence of the
  score graphic on screen is NOT a goal — the score graphic is on every
  single frame of a football broadcast."* Goals require either ball
  visibly in the net or a coordinated team celebration.
- **Forbid generic phrases in the summary.** Rule 1 lists banned phrases
  (*"dynamic moment"*, *"intense action"*, *"key moment"*, *"captures a
  moment"*, *"during the match"*, …) and tells the model to flip
  `event_type` to `"none"` if its draft summary contains one.

`VISUAL_DESCRIBE` is the parallel prompt for non-football content
(podcasts, demos). It uses a smaller vocab (`scene_change`, `speaker`,
`action`, `text_overlay`, `none`) and the same "default to none" rule.

`VISUAL_PROMPTS` in `backend/prompts.py` is the dispatch table:

```python
VISUAL_PROMPTS = {
    "football": VISUAL_FOOTBALL,
    "describe": VISUAL_DESCRIBE,
}
```

`pipeline.start_pipeline(content_type=...)` picks the right prompt at
indexing time.

---

## Layer 2 — Structural classifier (`backend/vod.py:_structural_classify`)

Three filters, all cheap, no LLM:

1. JSON parse the model output (handles ```json fences + brace extraction).
2. `event_type` must be in the active mode's vocab and not `"none"`.
3. `confidence > 0.0`.

That's it. No per-event-type floors, no summary regex.

---

## Layer 3 — Temporal `_Deduper`

A 30s same-`(event_type, team)` window. Goals additionally cross-team-
dedupe so a single goal classified as `(home)` then `(unknown)` then
`(away)` across the live → replay → graphic sequence doesn't fire three
times. Single `_DEDUPE_WINDOW_S = 30.0` constant — applies to every event
type.

---

## Layer 4 — Single JSON pass

```python
video.index_scenes(
    extraction_type=SceneExtractionType.time_based,
    extraction_config={"time": 6, "select_frames": ["first", "middle", "last"]},
    prompt=VISUAL_PROMPTS[content_type],
)
```

Why these numbers:
- `shot_based` produces ~1070 micro-scenes for a 33-min video; way too
  granular and the model classifies each replay angle independently.
- 10s windows miss real goals (event happens in the first second, rest
  of window is celebration → model sees crowd shot → returns "none").
- 6s with first/middle/last gives motion context (kick → ball-in-net →
  celebration) so a single goal scene contains enough visual evidence.

---

## Layer 5 — Resume-aware progress marker

`pipeline_state.vod_offset:<video_id>` records the latest `scene.end` the
worker has processed. A Stop mid-indexing leaves the marker behind; the
next Start spawns the worker with `resume_from_offset_s = cached_offset`
so it skips already-classified scenes. Combined with the bind-mounted
`./data/datacaster.db`, indexing cost is paid once per video across rebuilds.

The fully-indexed gate is `vod_offset >= video.length - 12`; once
crossed, the rehydrate path skips classification entirely on the next
Start and feeds the timeline from disk via SSE replay-on-connect.

---

## LLM validator (defined but disabled)

`backend/vod.py:_llm_validates_summary` is a yes/no "does this summary
cite a specific cue?" filter. It's defined but **not called** from the
poll worker. Each call costs ~6-12s on `coll.generate_text("ultra")` and
the worker walks scenes sequentially — re-enabling it without
parallelisation would push a 337-scene batch from <1s to 30+ minutes.
Re-enable by refactoring `poll_scene_index_forever` to `asyncio.gather`
validators per batch.

---

## Expected outcomes on a 33-min FIFA highlights video

- **~80-100 events total** under the default model. The strict prompt
  does the heavy lifting.
- The most common over-firer is `goal` on score-graphic-with-celebration
  cuts. If a particular video shows lots of phantom goals, dropping the
  default model in favour of `gemma-4-31B-it` (set `SANDBOX_TIER=medium`)
  tightens the model output enough that the prompt rules stick.
- Time-to-first-event: **3-6 minutes** on the default model on a fresh
  index. **Instant** on a previously-indexed video (rehydrate path).

## When to retune

- VideoDB swaps the underlying vision model. Run a 5-min test video and
  recheck event counts; update the example numbers above.
- The default model regresses on the "default to none" rule and goals
  start over-firing. Either bump to medium tier (`SANDBOX_TIER=medium`)
  or re-introduce a single confidence floor for `goal` only — cheapest
  way to suppress the phantom-goal failure mode.
- A new content_type ships that needs its own filters.

## Related files

- `backend/prompts.py` — `VISUAL_FOOTBALL` (the primary lever),
  `VISUAL_DESCRIBE`, commentary prompts.
- `backend/vod.py` — `_structural_classify`, `_Deduper`,
  `poll_scene_index_forever` (resume-aware).
- `backend/pipeline.py` — `_start_vod_pipeline` extraction config + the
  rehydrate / partial-cache / fresh-index branch logic.
- `backend/config.py` — `EVENT_VOCAB`, `GENERIC_VOCAB`,
  `SUPPORTED_CONTENT_TYPES`, `VOCAB_BY_MODE`.
- `test-datacaster.py` — Phase B (T11) regression watch for VOD timestamp
  drift, Phase C (T17) for football-vocab leak in describe mode.
