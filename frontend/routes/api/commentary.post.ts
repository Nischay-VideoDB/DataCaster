import { defineEventHandler, getQuery } from "nitro/h3";
import { z } from "zod";
import { apiFailure, resolveCurrentJob } from "../../server/compatibility.js";
import { generateOwnedCommentary } from "../../server/job-provider.js";
import { safeProviderError } from "../../server/security.js";

const schema = z.object({
  event_id: z.coerce.number().int().min(1),
  style: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).default("excited"),
});

export default defineEventHandler(async (event) => {
  const parsed = schema.safeParse(getQuery(event));
  if (!parsed.success) return apiFailure(event, 400, "INVALID_COMMENTARY_REQUEST", "event_id and style are invalid.", "Use an event id returned by GET /api/events/history.");
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  if (resolved.job.status !== "completed") return apiFailure(event, 409, "JOB_NOT_READY", "Commentary requires a completed job.", "Poll the job until it completes.");
  try {
    const item = await generateOwnedCommentary(resolved.job, parsed.data.event_id, parsed.data.style);
    return {
      id: item.id,
      event_id: item.eventId,
      text: item.text,
      audio_url: item.audioUrl,
      voice_style: item.voiceStyle,
      created_at: new Date(item.createdAt).getTime() / 1000,
      job_id: resolved.job.id,
      voice_note: "The serverless adapter generates and persists the grounded script; operator voice synthesis remains disabled.",
    };
  } catch (error) {
    if (error instanceof Error && error.message === "EVENT_NOT_FOUND") return apiFailure(event, 404, "EVENT_NOT_FOUND", "No event in this job has that event_id.", "Use an id returned by GET /api/events/history for the same current job.");
    return apiFailure(event, 502, "COMMENTARY_FAILED", safeProviderError(error), "Retry this same event/style; persisted results are reused and do not regenerate.");
  }
});
