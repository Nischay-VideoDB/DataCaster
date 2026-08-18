import { defineEventHandler, getQuery } from "nitro/h3";
import { z } from "zod";
import { listCommentary } from "../../../server/db.js";
import { apiFailure, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const limit = z.coerce.number().int().min(1).max(100).safeParse(getQuery(event).limit ?? 50);
  if (!limit.success) return apiFailure(event, 400, "INVALID_LIMIT", "limit must be between 1 and 100.", "Retry with ?limit=50.");
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const rows = await listCommentary(resolved.job.id, limit.data);
  return {
    items: rows.map((item) => ({
      id: item.id,
      event_id: item.eventId,
      text: item.text,
      audio_url: item.audioUrl,
      voice_style: item.voiceStyle,
      created_at: new Date(item.createdAt).getTime() / 1000,
    })),
    voice: { available: false, consecutive_failures: 0, backoff_remaining_s: 0, reason: "operator voice generation is not enabled on the public serverless adapter" },
    job_id: resolved.job.id,
  };
});
