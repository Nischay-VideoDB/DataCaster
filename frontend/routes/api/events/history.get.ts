import { defineEventHandler, getQuery } from "nitro/h3";
import { z } from "zod";
import { apiFailure, jobEvents, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const parsedLimit = z.coerce.number().int().min(1).max(500).safeParse(getQuery(event).limit ?? 200);
  if (!parsedLimit.success) return apiFailure(event, 400, "INVALID_LIMIT", "limit must be an integer between 1 and 500.", "Retry with ?limit=200.");
  return { events: jobEvents(resolved.job).slice(0, parsedLimit.data), job_id: resolved.job.id };
});
