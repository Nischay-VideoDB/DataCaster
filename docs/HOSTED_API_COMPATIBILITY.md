# Hosted API compatibility

The Vercel deployment preserves the durable `POST /api/jobs` workflow and
prepared examples while adapting the original FastAPI contract to Nitro,
Azure Postgres, Vercel Workflow, and job-scoped VideoDB access.

Every data route resolves a current `job_id` from the `datacaster_current_job`
HTTP-only cookie, `x-datacaster-job-id`, or `?job_id=` and verifies that the
same client owns the job. The hosted deployment never lists the shared
VideoDB collection. Unknown `/api/**` paths return typed JSON `404` responses
and never fall through to the React document.

| Original route | Hosted behavior |
| --- | --- |
| `GET /api/health` | Azure Postgres/Workflow health plus current durable pipeline shape |
| `GET /api/videos` | `410 SHARED_VIDEO_CATALOG_REMOVED`; use a public URL |
| `POST /api/start` | URL inputs adapt to the durable job workflow; local files and shared video IDs are rejected explicitly |
| `POST /api/stop` | `409`; durable Workflow jobs are not in-memory processes |
| `POST /api/sandbox/sweep` | `501`; operator-machine recovery only |
| `POST /api/end_session` | Clears the browser's current-job cookie without deleting durable results |
| `POST /api/live_stream` | Returns the current job's persisted VideoDB stream |
| `GET /api/events` | Job-scoped SSE replay/poll stream |
| `GET /api/events/history` | Job-scoped persisted event history |
| `GET /api/stats` | Counts derived from the current job's persisted events |
| `POST /api/events/resync` | `409`; directs callers to create a new explicit job without silently spending provider credits |
| `GET /api/search` | Live VideoDB visual search against only the job's scene index; audio/transcript rails return `501` |
| `POST /api/commentary` | Live grounded script generation, persisted per job/event/style; operator voice synthesis is disabled |
| `GET /api/commentary/track` | Job-scoped persisted commentary |
| `GET /api/highlights/stream` | Current job's persisted VideoDB highlight/source stream |
| `GET /api/highlights` | Job-scoped ranked event highlights |
| `POST /api/highlights/refresh` | Idempotent persisted-event refresh; starts no provider work |
| `POST /api/highlights/reel` | `deliver=none` creates/reuses a job-scoped VideoDB reel; public Telegram delivery returns `501` |
| `POST /api/ask` | Live, evidence-grounded VideoDB answer scoped to the current job |
| `GET /api/export/events` | Job-scoped JSON attachment |
| `GET /api/export/commentary` | Job-scoped JSON attachment |
| `GET /api/export/highlights` | Job-scoped JSON attachment |

The original operator FastAPI stack remains available for RTStream capture,
filesystem sources, sandbox recovery, background workers, realtime audio
rails, voice synthesis, and Telegram delivery.
