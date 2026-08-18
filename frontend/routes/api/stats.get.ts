import { defineEventHandler } from "nitro/h3";
import { resolveCurrentJob } from "../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const counts = resolved.job.events.reduce<Record<string, number>>((result, item) => {
    result[item.eventType] = (result[item.eventType] || 0) + 1;
    return result;
  }, {});
  return { counts, total: resolved.job.events.length, job_id: resolved.job.id };
});
