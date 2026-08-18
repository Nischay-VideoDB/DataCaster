import { connect, IndexTypeValues, SearchTypeValues } from "videodb";
import type { AnalysisJob, CompatibilityReel } from "./db.js";
import {
  findCommentary,
  findCompatibilityReel,
  saveCommentary,
  saveCompatibilityReel,
  saveQuestion,
} from "./db.js";

function apiKey(): string {
  const value = process.env.VIDEO_DB_API_KEY || process.env.VIDEODB_API_KEY;
  if (!value) throw new Error("VideoDB is not configured");
  return value;
}

function generatedText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return String(record.output || record.text || record.response || fallback).trim();
  }
  return fallback;
}

export type ScopedShot = {
  rtstream_id: null;
  rtstream_name: null;
  start: number;
  end: number;
  text: string;
  score: number | null;
  stream_url: string | null;
};

export async function searchOwnedJob(job: AnalysisJob, query: string, threshold: number): Promise<ScopedShot[]> {
  if (job.status !== "completed" || !job.videoId || !job.sceneIndexId) {
    throw new Error("JOB_NOT_READY");
  }
  const coll = await connect({ apiKey: apiKey() }).getCollection();
  const result = await coll.legacySearch(
    query,
    SearchTypeValues.semantic,
    IndexTypeValues.scene,
    threshold,
    0.05,
    undefined,
    undefined,
    "start",
    undefined,
    job.sceneIndexId,
  );
  return result.getShots().slice(0, threshold).map((shot) => ({
    rtstream_id: null,
    rtstream_name: null,
    start: Number(shot.start || 0),
    end: Number(shot.end || shot.start || 0),
    text: String(shot.text || "VideoDB visual match"),
    score: shot.searchScore == null ? null : Number(shot.searchScore),
    stream_url: shot.streamUrl || job.highlightUrl || job.streamUrl,
  }));
}

export async function askOwnedJob(job: AnalysisJob, question: string, threshold: number) {
  let sources: Array<{ start: number; end: number; text: string; streamUrl?: string }> = [];
  try {
    const shots = await searchOwnedJob(job, question, threshold);
    sources = shots.slice(0, 8).map((shot) => ({
      start: shot.start,
      end: shot.end,
      text: shot.text,
      streamUrl: shot.stream_url || undefined,
    }));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "JOB_NOT_READY") throw error;
  }
  if (!sources.length) {
    sources = job.events.slice(0, 8).map((item) => ({
      start: item.start,
      end: item.end,
      text: item.summary,
      streamUrl: job.highlightUrl || job.streamUrl || undefined,
    }));
  }
  if (!sources.length) throw new Error("NO_EVIDENCE");
  const coll = await connect({ apiKey: apiKey() }).getCollection();
  const context = sources
    .map((source) => `[${source.start.toFixed(1)}-${source.end.toFixed(1)}s] ${source.text}`)
    .join("\n");
  const generated = await coll.generateText(
    `You are DataCaster, an evidence-first video analyst. Answer only from the timestamped VideoDB evidence below. If the evidence is insufficient, say so. Cite timestamps in square brackets.\n\nQuestion: ${question}\n\nEvidence:\n${context}`,
    "basic",
    "text",
    { maxTokens: 320, temperature: 0.1 },
  );
  const answer = generatedText(generated, "The indexed evidence was insufficient to answer.");
  await saveQuestion(job.id, question, answer, sources);
  return { query: question, answer, evidence: sources, sources };
}

export async function generateOwnedCommentary(job: AnalysisJob, eventId: number, style: string) {
  const existing = await findCommentary(job.id, eventId, style);
  if (existing) return existing;
  const event = job.events[eventId - 1];
  if (!event) throw new Error("EVENT_NOT_FOUND");
  const coll = await connect({ apiKey: apiKey() }).getCollection();
  const generated = await coll.generateText(
    `Write a concise 60-100 word ${style} live-sports commentary call for this indexed event. Stay grounded in the supplied evidence; do not invent player identities or scorelines. Evidence at ${event.start.toFixed(1)}-${event.end.toFixed(1)} seconds: ${event.summary}`,
    "basic",
    "text",
    { maxTokens: 180, temperature: 0.3 },
  );
  return saveCommentary({
    jobId: job.id,
    eventId,
    style,
    text: generatedText(generated, event.summary),
    audioUrl: null,
  });
}

export async function generateOwnedReel(
  job: AnalysisJob,
  n: number,
  aspect: CompatibilityReel["aspect"],
): Promise<CompatibilityReel> {
  const existing = await findCompatibilityReel(job.id, n, aspect);
  if (existing) return existing;
  if (job.status !== "completed" || !job.videoId) throw new Error("JOB_NOT_READY");
  const selected = job.events
    .slice(0, n)
    .map((item) => [Math.max(0, item.start), Math.min(job.durationSeconds || item.end, item.end)] as [number, number])
    .filter(([start, end]) => end - start >= 0.5);
  if (!selected.length) throw new Error("NO_EVIDENCE");
  const coll = await connect({ apiKey: apiKey() }).getCollection();
  const video = await coll.getVideo(job.videoId);
  const reelUrl = await video.generateStream(selected);
  const evidence = job.events.slice(0, selected.length)
    .map((item) => `[${item.start.toFixed(1)}s] ${item.summary}`)
    .join("\n");
  const generated = await coll.generateText(
    `Write a concise client-demo recap caption from only these VideoDB-indexed moments. Do not invent names or scores.\n${evidence}`,
    "basic",
    "text",
    { maxTokens: 180, temperature: 0.2 },
  );
  return saveCompatibilityReel({
    jobId: job.id,
    n,
    aspect,
    reelUrl,
    caption: generatedText(generated, job.events.slice(0, selected.length).map((item) => item.summary).join(" ")),
    eventsUsed: selected.length,
  });
}
