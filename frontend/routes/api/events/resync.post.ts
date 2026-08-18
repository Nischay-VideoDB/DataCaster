import { defineEventHandler } from "nitro/h3";
import { apiFailure, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  return apiFailure(
    event,
    409,
    "DURABLE_REINDEX_REQUIRES_NEW_JOB",
    "The public deployment does not mutate or delete the evidence index of an existing durable job.",
    "Create a new run with POST /api/jobs and an explicit new idempotencyKey. This response starts no VideoDB work and incurs no provider spend.",
  );
});
