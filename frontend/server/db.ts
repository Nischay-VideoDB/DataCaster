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
