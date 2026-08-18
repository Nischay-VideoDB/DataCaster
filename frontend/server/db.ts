import { Pool } from "pg";

export type AnalysisMode = "football" | "describe";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export type AnalysisEvent = {
  start: number;
  end: number;
  eventType: string;
  team: string;
  confidence: number;
  summary: string;
};

export type AnalysisJob = {
  id: string;
  sourceUrl: string;
  mode: AnalysisMode;
  status: JobStatus;
  stage: string;
  progress: number;
  videoId: string | null;
  durationSeconds: number | null;
  streamUrl: string | null;
  highlightUrl: string | null;
  sceneIndexId: string | null;
  events: AnalysisEvent[];
  error: string | null;
  workflowRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisQuestion = {
  question: string;
  answer: string;
  sources: Array<{ start: number; end: number; text: string; streamUrl?: string }>;
  createdAt: string;
};

export type CompatibilityCommentary = {
  id: number;
  eventId: number;
  text: string;
  audioUrl: string | null;
  voiceStyle: string;
  createdAt: string;
};

export type CompatibilityReel = {
  reelUrl: string;
  caption: string;
  aspect: "vertical" | "square" | "landscape";
  n: number;
  eventsUsed: number;
  createdAt: string;
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not configured");

const globalForPool = globalThis as unknown as { datacasterPool?: Pool };
export const pool = globalForPool.datacasterPool ?? new Pool({
  connectionString,
  max: 3,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
});
if (process.env.NODE_ENV !== "production") globalForPool.datacasterPool = pool;

let schemaReady: Promise<void> | undefined;

export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id uuid PRIMARY KEY,
        client_hash text NOT NULL,
        idempotency_key text NOT NULL,
        source_url text NOT NULL,
        mode text NOT NULL CHECK (mode IN ('football', 'describe')),
        status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        stage text NOT NULL,
        progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        video_id text,
        duration_seconds double precision,
        stream_url text,
        highlight_url text,
        scene_index_id text,
        events jsonb NOT NULL DEFAULT '[]'::jsonb,
        error text,
        workflow_run_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (client_hash, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS analysis_jobs_client_created_idx
        ON analysis_jobs (client_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS analysis_jobs_created_idx
        ON analysis_jobs (created_at DESC);
      CREATE TABLE IF NOT EXISTS analysis_questions (
        id bigserial PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
        question text NOT NULL,
        answer text NOT NULL,
        sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS compatibility_commentary (
        id bigserial PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
        event_id integer NOT NULL,
        voice_style text NOT NULL,
        text text NOT NULL,
        audio_url text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (job_id, event_id, voice_style)
      );
      CREATE TABLE IF NOT EXISTS compatibility_reels (
        id bigserial PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
        event_count integer NOT NULL,
        aspect text NOT NULL CHECK (aspect IN ('vertical', 'square', 'landscape')),
        reel_url text NOT NULL,
        caption text NOT NULL,
        events_used integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (job_id, event_count, aspect)
      );
    `);
  })();
  return schemaReady;
}

function mapJob(row: Record<string, unknown>): AnalysisJob {
  return {
    id: String(row.id),
    sourceUrl: String(row.source_url),
    mode: row.mode as AnalysisMode,
    status: row.status as JobStatus,
    stage: String(row.stage),
    progress: Number(row.progress),
    videoId: row.video_id ? String(row.video_id) : null,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    streamUrl: row.stream_url ? String(row.stream_url) : null,
    highlightUrl: row.highlight_url ? String(row.highlight_url) : null,
    sceneIndexId: row.scene_index_id ? String(row.scene_index_id) : null,
    events: Array.isArray(row.events) ? row.events as AnalysisEvent[] : [],
    error: row.error ? String(row.error) : null,
    workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function findJob(id: string): Promise<AnalysisJob | null> {
  await ensureSchema();
  const { rows } = await pool.query("SELECT * FROM analysis_jobs WHERE id = $1", [id]);
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function findOwnedJob(id: string, clientHash: string): Promise<AnalysisJob | null> {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT * FROM analysis_jobs WHERE id = $1 AND client_hash = $2",
    [id, clientHash],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function findIdempotentJob(clientHash: string, key: string): Promise<AnalysisJob | null> {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT * FROM analysis_jobs WHERE client_hash = $1 AND idempotency_key = $2",
    [clientHash, key],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function findReusableAsset(sourceUrl: string, excludeJobId: string): Promise<AnalysisJob | null> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM analysis_jobs
     WHERE source_url = $1 AND id <> $2 AND video_id IS NOT NULL
       AND stream_url IS NOT NULL AND duration_seconds IS NOT NULL
       AND created_at > now() - interval '30 days'
     ORDER BY updated_at DESC LIMIT 1`,
    [sourceUrl, excludeJobId],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function createJob(input: {
  id: string;
  clientHash: string;
  idempotencyKey: string;
  sourceUrl: string;
  mode: AnalysisMode;
}): Promise<AnalysisJob> {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO analysis_jobs
      (id, client_hash, idempotency_key, source_url, mode, status, stage, progress)
     VALUES ($1, $2, $3, $4, $5, 'queued', 'Waiting for durable worker', 2)
     RETURNING *`,
    [input.id, input.clientHash, input.idempotencyKey, input.sourceUrl, input.mode],
  );
  return mapJob(rows[0]);
}

export async function updateJob(id: string, patch: Record<string, unknown>): Promise<void> {
  await ensureSchema();
  const allowed: Record<string, string> = {
    status: "status",
    stage: "stage",
    progress: "progress",
    videoId: "video_id",
    durationSeconds: "duration_seconds",
    streamUrl: "stream_url",
    highlightUrl: "highlight_url",
    sceneIndexId: "scene_index_id",
    events: "events",
    error: "error",
    workflowRunId: "workflow_run_id",
  };
  const entries = Object.entries(patch).filter(([key]) => key in allowed);
  if (!entries.length) return;
  const sets = entries.map(([key], index) => `${allowed[key]} = $${index + 2}`);
  const values = entries.map(([key, value]) => key === "events" ? JSON.stringify(value) : value);
  await pool.query(
    `UPDATE analysis_jobs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...values],
  );
}

export async function assertWithinRateLimits(clientHash: string): Promise<void> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE client_hash = $1) AS client_count,
       count(*) AS global_count
     FROM analysis_jobs
     WHERE created_at > now() - interval '24 hours'`,
    [clientHash],
  );
  if (Number(rows[0].client_count) >= 3) throw new Error("CLIENT_RATE_LIMIT");
  if (Number(rows[0].global_count) >= 30) throw new Error("GLOBAL_RATE_LIMIT");
}

export async function countQuestions(jobId: string): Promise<number> {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM analysis_questions WHERE job_id = $1",
    [jobId],
  );
  return Number(rows[0].count);
}

export async function listQuestions(jobId: string): Promise<AnalysisQuestion[]> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT question, answer, sources, created_at
     FROM analysis_questions WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId],
  );
  return rows.map((row) => ({
    question: String(row.question),
    answer: String(row.answer),
    sources: Array.isArray(row.sources) ? row.sources : [],
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

export async function saveQuestion(jobId: string, question: string, answer: string, sources: unknown): Promise<void> {
  await ensureSchema();
  await pool.query(
    "INSERT INTO analysis_questions (job_id, question, answer, sources) VALUES ($1, $2, $3, $4::jsonb)",
    [jobId, question, answer, JSON.stringify(sources ?? [])],
  );
}

function mapCommentary(row: Record<string, unknown>): CompatibilityCommentary {
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    text: String(row.text),
    audioUrl: row.audio_url ? String(row.audio_url) : null,
    voiceStyle: String(row.voice_style),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function findCommentary(jobId: string, eventId: number, style: string): Promise<CompatibilityCommentary | null> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM compatibility_commentary
     WHERE job_id = $1 AND event_id = $2 AND voice_style = $3`,
    [jobId, eventId, style],
  );
  return rows[0] ? mapCommentary(rows[0]) : null;
}

export async function saveCommentary(input: {
  jobId: string;
  eventId: number;
  style: string;
  text: string;
  audioUrl?: string | null;
}): Promise<CompatibilityCommentary> {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO compatibility_commentary (job_id, event_id, voice_style, text, audio_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id, event_id, voice_style) DO UPDATE SET text = compatibility_commentary.text
     RETURNING *`,
    [input.jobId, input.eventId, input.style, input.text, input.audioUrl ?? null],
  );
  return mapCommentary(rows[0]);
}

export async function listCommentary(jobId: string, limit = 50): Promise<CompatibilityCommentary[]> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM compatibility_commentary
     WHERE job_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [jobId, limit],
  );
  return rows.map(mapCommentary);
}

function mapReel(row: Record<string, unknown>): CompatibilityReel {
  return {
    reelUrl: String(row.reel_url),
    caption: String(row.caption),
    aspect: row.aspect as CompatibilityReel["aspect"],
    n: Number(row.event_count),
    eventsUsed: Number(row.events_used),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function findCompatibilityReel(jobId: string, n: number, aspect: CompatibilityReel["aspect"]): Promise<CompatibilityReel | null> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM compatibility_reels
     WHERE job_id = $1 AND event_count = $2 AND aspect = $3`,
    [jobId, n, aspect],
  );
  return rows[0] ? mapReel(rows[0]) : null;
}

export async function saveCompatibilityReel(input: {
  jobId: string;
  n: number;
  aspect: CompatibilityReel["aspect"];
  reelUrl: string;
  caption: string;
  eventsUsed: number;
}): Promise<CompatibilityReel> {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO compatibility_reels
      (job_id, event_count, aspect, reel_url, caption, events_used)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id, event_count, aspect) DO UPDATE SET reel_url = compatibility_reels.reel_url
     RETURNING *`,
    [input.jobId, input.n, input.aspect, input.reelUrl, input.caption, input.eventsUsed],
  );
  return mapReel(rows[0]);
}

export async function listCompatibilityReels(jobId: string, limit = 25): Promise<CompatibilityReel[]> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM compatibility_reels
     WHERE job_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [jobId, limit],
  );
  return rows.map(mapReel);
}
