# Hackathon_VideoDB

This repo is the user's workspace for the **VideoDB Global Online Hackathon** (May 16–18, 2026, 48-hour solo build).

## Authoritative references — read before writing VideoDB code

- **`docs/SANDBOX.md`** — full sandbox SDK reference (install, lifecycle, tiers, models, every workload API with code samples). Source: https://hackday.videodb.io/sandbox.html. This is the **first** thing to consult for any sandbox / RTStream / index / generate call.
- **`.claude/skills/videodb/SKILL.md`** — official VideoDB skill (capabilities overview, ingestion, indexing, editing, generation, alerts).
- **`.env`** — `VIDEO_DB_API_KEY` (gitignored).

## Hackathon constraints (don't violate)

- Install the **hackathon branch** of the SDK, not PyPI:
  `pip install "git+https://github.com/Video-DB/videodb-python.git@hackathon"`
- Submission **must use both**: (1) `CaptureSession`/`RTStream` and (2) `Search`/`Memory`/`Context`. Missing either ≈ disqualified.
- Solo build (teams of 2 max).
- Deadline: **Mon 2026-05-18 10:00 IST**, hard cutoff. Form locks. Missing any deliverable → DQ before judging.
- Required deliverables: public GitHub repo + working demo (video or live link) + ≤200-word description.
- Judging weights: Technical execution 40% / Creativity 30% / Depth of VideoDB usage 30%.

## Sandbox usage rules (cost matters)

- **Always** stop sandboxes in `finally:` — `idle_timeout` is a safety net, not the primary mechanism.
- **Reuse one sandbox** per session/workflow. Don't spin up per call.
- **Always pass `sandbox_id=sandbox.id`** to every workload call.
- Pick tier by the heaviest model: `small` $1/hr (Whisper, OmniVoice, Qwen-9B, Gemma-2B, Stable Audio), `medium` $3.50/hr (Gemma-31B, Qwen-27B, FLUX.1-dev).

## Showcase apps to study, not duplicate

VideoDB's six first-party reference apps live at https://videodb.io/showcase and `github.com/video-db/<repo>`: `pair-programmer`, `openclaw-monitoring`, `call.md`, `bloom`, `agentic-streams`, `focusd`. The hackathon brief's "inspiration" list maps 1:1 to these. Build adjacent verticals or sharper specializations, not clones. `call.md` and `openclaw-monitoring` are the best read-aloud examples for the mandatory `RTStream + index + memory` pattern.
