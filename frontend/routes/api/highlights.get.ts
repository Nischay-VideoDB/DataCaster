import { defineEventHandler, getQuery } from "nitro/h3";
import { z } from "zod";
import { apiFailure, resolveCurrentJob } from "../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const limit = z.coerce.number().int().min(1).max(100).safeParse(getQuery(event).limit ?? 25);
  if (!limit.success) return apiFailure(event, 400, "INVALID_LIMIT", "limit must be between 1 and 100.", "Retry with ?limit=25.");
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const items = [...resolved.job.events]
    .map((item, index) => ({
      id: index + 1,
      event_id: index + 1,
      event_type: item.eventType,
      score: item.confidence,
      start: item.start,
      end: item.end,
      summary: item.summary,
      stream_url: resolved.job.highlightUrl || resolved.job.streamUrl,
      provider: "videodb",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit.data);
  return { items, job_id: resolved.job.id };
});
