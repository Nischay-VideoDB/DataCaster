import type { H3Event } from "nitro/h3";
import { deleteCookie, getCookie, getQuery, setCookie, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import type { AnalysisEvent, AnalysisJob } from "./db.js";
import { findOwnedJob } from "./db.js";
import { clientHash } from "./security.js";

export const CURRENT_JOB_COOKIE = "datacaster_current_job";

export type ApiFailure = {
  error: string;
  code: string;
  guidance: string;
};

export type CurrentJobResult =
  | { job: AnalysisJob; failure?: never }
  | { job?: never; failure: ApiFailure };

export function apiFailure(
  event: H3Event,
  status: number,
  code: string,
  error: string,
  guidance: string,
): ApiFailure {
  setResponseStatus(event, status);
  return { error, code, guidance };
}

export function rememberCurrentJob(event: H3Event, jobId: string): void {
  setCookie(event, CURRENT_JOB_COOKIE, jobId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function forgetCurrentJob(event: H3Event): void {
  deleteCookie(event, CURRENT_JOB_COOKIE, { path: "/" });
}

export async function resolveCurrentJob(event: H3Event): Promise<CurrentJobResult> {
  const queryValue = getQuery(event).job_id;
  const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  const rawId = String(
    queryId || event.req.headers.get("x-datacaster-job-id") || getCookie(event, CURRENT_JOB_COOKIE) || "",
  );
  if (!rawId) {
    return {
      failure: apiFailure(
        event,
        409,
        "CURRENT_JOB_REQUIRED",
        "This compatibility route requires a current analysis job.",
        "Start a run with POST /api/jobs or POST /api/start, then keep the returned job_id cookie or pass ?job_id=<uuid> from the same client.",
      ),
    };
  }
  const parsed = z.string().uuid().safeParse(rawId);
  if (!parsed.success) {
    return {
      failure: apiFailure(
        event,
        400,
        "INVALID_JOB_ID",
        "The supplied job_id is not a valid UUID.",
        "Use the job id returned by POST /api/jobs or POST /api/start.",
      ),
    };
  }
  const job = await findOwnedJob(parsed.data, clientHash(event.req));
  if (!job) {
    return {
      failure: apiFailure(
        event,
        404,
        "JOB_NOT_FOUND",
        "No analysis owned by this client matches the supplied job_id.",
        "Use a job created from this browser/client. Shared VideoDB collection data is never listed by the public deployment.",
      ),
    };
  }
  rememberCurrentJob(event, job.id);
  return { job };
}

export function eventRecord(item: AnalysisEvent, index: number, job: AnalysisJob) {
  return {
    id: index + 1,
    unix_ts: new Date(job.createdAt).getTime() / 1000 + item.start,
    start: item.start,
    end: item.end,
    event_type: item.eventType,
    confidence: item.confidence,
    team: item.team,
    summary: item.summary,
    raw_json: null,
    source: "videodb_scene_index",
    video_id: job.videoId,
  };
}

export function jobEvents(job: AnalysisJob) {
  return job.events.map((item, index) => eventRecord(item, index, job));
}

export function pipelineState(job: AnalysisJob | null) {
  if (!job) {
    return {
      job_id: null,
      started_at: null,
      starting_at: null,
      source_type: null,
      source: null,
      content_type: "football",
      rtstream_url: null,
      rtstream_id: null,
      sandbox_id: null,
      ws_id: null,
      visual_index_id: null,
      audio_index_id: null,
      live_stream_url: null,
      live_player_url: null,
      video_id: null,
      vod_scene_index_id: null,
      vod_prose_index_id: null,
      vod_total_scenes: null,
      vod_indexed_scenes: null,
      video_length_s: null,
      transcript_index_id: null,
      prompt_mode: "football",
      durable_status: "idle",
      stage: "No current durable job",
      progress: 0,
    };
  }
  const created = new Date(job.createdAt).getTime() / 1000;
  return {
    job_id: job.id,
    started_at: job.status === "queued" ? null : created,
    starting_at: job.status === "queued" ? created : null,
    source_type: "url",
    source: job.sourceUrl,
    content_type: job.mode,
    rtstream_url: null,
    rtstream_id: null,
    sandbox_id: null,
    ws_id: null,
    visual_index_id: job.sceneIndexId,
    audio_index_id: null,
    live_stream_url: job.streamUrl,
    live_player_url: job.streamUrl
      ? `https://console.videodb.io/player?url=${encodeURIComponent(job.streamUrl)}`
      : null,
    video_id: job.videoId,
    vod_scene_index_id: job.sceneIndexId,
    vod_prose_index_id: null,
    vod_total_scenes: job.durationSeconds ? Math.ceil(job.durationSeconds / 6) : null,
    vod_indexed_scenes: job.status === "completed" ? Math.ceil((job.durationSeconds || 0) / 6) : null,
    video_length_s: job.durationSeconds,
    transcript_index_id: null,
    prompt_mode: job.mode,
    durable_status: job.status,
    stage: job.stage,
    progress: job.progress,
  };
}

export function attachmentHeaders(name: string): Headers {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "private, no-store",
  });
}
