import { FatalError, sleep } from "workflow";
import type { Video } from "videodb";
import type { AnalysisEvent, AnalysisMode } from "../server/db.js";

const MAX_DURATION_SECONDS = 15 * 60;

const FOOTBALL_PROMPT = `Analyze this football video window. Return exactly one compact JSON object and no markdown:
{"event_type":"goal|shot_on_target|save|foul|yellow_card|red_card|corner|offside|none","team":"home|away|unknown","confidence":0.0,"summary":"specific visible evidence"}
Choose none unless the frames contain a concrete visible cue. Never infer player identity.`;

const DESCRIBE_PROMPT = `Describe the most important visible action in this video window. Return exactly one compact JSON object and no markdown:
{"event_type":"action|scene_change|people|object|none","team":"unknown","confidence":0.0,"summary":"specific visible evidence"}
Choose none only when the frames contain no useful visible information.`;

type Uploaded = { videoId: string; durationSeconds: number; streamUrl: string };
type IndexSnapshot = { status: string; records: Array<{ start: number; end: number; description: string }> };

async function markRunning(jobId: string): Promise<void> {
  "use step";
  const { findJob, updateJob } = await import("../server/db.js");
  const job = await findJob(jobId);
  if (!job) throw new FatalError("Analysis job no longer exists");
  if (job.status === "completed") return;
  await updateJob(jobId, { status: "running", stage: "Uploading media to VideoDB", progress: 8, error: null });
}

async function uploadMedia(jobId: string, sourceUrl: string): Promise<Uploaded> {
  "use step";
  const { connect } = await import("videodb");
  const { findJob, findReusableAsset, updateJob } = await import("../server/db.js");
  const job = await findJob(jobId);
  if (job?.videoId && job.streamUrl && job.durationSeconds) {
    return { videoId: job.videoId, streamUrl: job.streamUrl, durationSeconds: job.durationSeconds };
  }
  const reusable = await findReusableAsset(sourceUrl, jobId);
  if (reusable?.videoId && reusable.streamUrl && reusable.durationSeconds) {
    await updateJob(jobId, {
      videoId: reusable.videoId,
      durationSeconds: reusable.durationSeconds,
      streamUrl: reusable.streamUrl,
      stage: "Reusing the existing VideoDB asset; creating a fresh analysis index",
      progress: 28,
    });
    return { videoId: reusable.videoId, streamUrl: reusable.streamUrl, durationSeconds: reusable.durationSeconds };
  }
  const apiKey = process.env.VIDEO_DB_API_KEY || process.env.VIDEODB_API_KEY;
  if (!apiKey) throw new FatalError("VIDEO_DB_API_KEY is not configured");
  const conn = connect({ apiKey });
  const uploaded = await conn.uploadURL("default", {
    url: sourceUrl,
    name: `DataCaster public analysis ${jobId.slice(0, 8)}`,
    description: "Public, rate-limited DataCaster demo run",
  });
  if (!uploaded || !("generateStream" in uploaded)) throw new Error("VideoDB did not return a video asset");
  const video = uploaded as Video;
  const durationSeconds = Number(video.length || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("VideoDB could not determine media duration");
  if (durationSeconds > MAX_DURATION_SECONDS) {
    throw new FatalError("This public demo accepts videos up to 15 minutes to control processing cost");
  }
  const streamUrl = await video.generateStream();
  await updateJob(jobId, {
    videoId: video.id,
    durationSeconds,
    streamUrl,
    stage: "Creating a VideoDB visual index",
    progress: 28,
  });
  return { videoId: video.id, durationSeconds, streamUrl };
}

async function startVisualIndex(jobId: string, videoId: string, mode: AnalysisMode): Promise<string> {
  "use step";
  const { connect } = await import("videodb");
  const { findJob, updateJob } = await import("../server/db.js");
  const job = await findJob(jobId);
  if (job?.sceneIndexId) return job.sceneIndexId;
  const apiKey = process.env.VIDEO_DB_API_KEY || process.env.VIDEODB_API_KEY;
  if (!apiKey) throw new FatalError("VIDEO_DB_API_KEY is not configured");
  const coll = await connect({ apiKey }).getCollection();
  const video = await coll.getVideo(videoId);
  let sceneIndexId: string | undefined;
  try {
    sceneIndexId = await video.indexVisuals({
      batchConfig: { type: "time", value: 6, frameCount: 3, selectFrames: ["first", "middle", "last"] },
      prompt: mode === "football" ? FOOTBALL_PROMPT : DESCRIBE_PROMPT,
      modelName: "basic",
      name: `datacaster_public_${mode}_${jobId.slice(0, 8)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existing = message.match(/Scene index with id\s+([a-f0-9]+)/i)?.[1];
    if (!existing) throw error;
    sceneIndexId = existing;
  }
  if (!sceneIndexId) throw new Error("VideoDB did not return a scene index id");
  await updateJob(jobId, { sceneIndexId, stage: "VideoDB is analyzing scene windows", progress: 38 });
  return sceneIndexId;
}

async function readIndex(videoId: string, sceneIndexId: string): Promise<IndexSnapshot> {
  "use step";
  const { connect } = await import("videodb");
  const apiKey = process.env.VIDEO_DB_API_KEY || process.env.VIDEODB_API_KEY;
  if (!apiKey) throw new FatalError("VIDEO_DB_API_KEY is not configured");
  const coll = await connect({ apiKey }).getCollection();
  const video = await coll.getVideo(videoId);
  const indexes = await video.listSceneIndex();
  const current = indexes.find((item) => item.sceneIndexId === sceneIndexId);
  let records: IndexSnapshot["records"] = [];
  try { records = await video.getSceneIndex(sceneIndexId); } catch { /* not ready yet */ }
  return { status: current?.status || (records.length ? "ready" : "processing"), records };
}

function parseRecord(record: { start: number; end: number; description: string }, mode: AnalysisMode): AnalysisEvent | null {
  const text = String(record.description || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  let parsed: Record<string, unknown> = {};
  if (match) {
    try { parsed = JSON.parse(match[0]); } catch { parsed = {}; }
  }
  const eventType = String(parsed.event_type || (mode === "describe" ? "action" : "none"));
  if (eventType === "none") return null;
  const summary = String(parsed.summary || text).replace(/\s+/g, " ").trim().slice(0, 280);
  if (!summary) return null;
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5)));
  return {
    start: Math.max(0, Number(record.start || 0)),
    end: Math.max(Number(record.start || 0) + 0.5, Number(record.end || 0)),
    eventType,
    team: String(parsed.team || "unknown"),
    confidence,
    summary,
  };
}

async function finishAnalysis(jobId: string, videoId: string, durationSeconds: number, streamUrl: string, mode: AnalysisMode, records: IndexSnapshot["records"]): Promise<void> {
  "use step";
  const { connect } = await import("videodb");
  const { updateJob } = await import("../server/db.js");
  const events = records.map((record) => parseRecord(record, mode)).filter((event): event is AnalysisEvent => Boolean(event));
  const apiKey = process.env.VIDEO_DB_API_KEY || process.env.VIDEODB_API_KEY;
  if (!apiKey) throw new FatalError("VIDEO_DB_API_KEY is not configured");
  const coll = await connect({ apiKey }).getCollection();
  const video = await coll.getVideo(videoId);
  const chosen = events
    .map((event) => ({ start: Math.max(0, event.start), end: Math.min(durationSeconds, event.end) }))
    .filter((event) => event.end - event.start >= 0.5)
    .slice(0, 5);
  const highlightUrl = chosen.length
    ? await video.generateStream(chosen.map((event) => [event.start, event.end] as [number, number]))
    : streamUrl;
  await updateJob(jobId, {
    status: "completed",
    stage: events.length ? "Analysis ready" : "Analysis ready — no qualifying event detected",
    progress: 100,
    events,
    highlightUrl,
    error: null,
  });
}

async function failAnalysis(jobId: string, message: string): Promise<void> {
  "use step";
  const { updateJob } = await import("../server/db.js");
  await updateJob(jobId, { status: "failed", stage: "Analysis failed", progress: 100, error: message });
}

export async function analyzeMatch(jobId: string, sourceUrl: string, mode: AnalysisMode): Promise<{ jobId: string }> {
  "use workflow";
  try {
    await markRunning(jobId);
    const uploaded = await uploadMedia(jobId, sourceUrl);
    const sceneIndexId = await startVisualIndex(jobId, uploaded.videoId, mode);
    let stableReads = 0;
    let lastCount = -1;
    let snapshot: IndexSnapshot = { status: "processing", records: [] };
    for (let attempt = 0; attempt < 90; attempt += 1) {
      snapshot = await readIndex(uploaded.videoId, sceneIndexId);
      const ready = ["ready", "done", "completed", "indexed"].includes(snapshot.status.toLowerCase());
      stableReads = snapshot.records.length > 0 && snapshot.records.length === lastCount ? stableReads + 1 : 0;
      lastCount = snapshot.records.length;
      if (ready || stableReads >= 2) break;
      await sleep("10s");
    }
    if (!snapshot.records.length) throw new Error("VideoDB scene indexing did not finish within 15 minutes");
    await finishAnalysis(jobId, uploaded.videoId, uploaded.durationSeconds, uploaded.streamUrl, mode, snapshot.records);
    return { jobId };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = /api[_ -]?key|token|authorization|credential/i.test(raw)
      ? "The media provider rejected this run. Please try again later."
      : raw.replace(/https?:\/\/[^\s]+/g, "the submitted media URL").slice(0, 300);
    await failAnalysis(jobId, message);
    return { jobId };
  }
}
