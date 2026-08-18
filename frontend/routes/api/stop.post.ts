import { defineEventHandler } from "nitro/h3";
import { apiFailure, resolveCurrentJob } from "../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  return apiFailure(event, 409, "DURABLE_JOB_CANNOT_BE_STOPPED", "Public analyses run as durable Vercel Workflows and cannot be stopped through the legacy in-memory control.", `Job ${resolved.job.id} remains queryable. To leave it, call POST /api/end_session; no new provider work is started by this response.`);
});
