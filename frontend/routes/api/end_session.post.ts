import { defineEventHandler } from "nitro/h3";
import { forgetCurrentJob, resolveCurrentJob } from "../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  forgetCurrentJob(event);
  return {
    status: "ended",
    job_id: resolved.job.id,
    durable_job_preserved: true,
    guidance: "The browser’s current-job pointer was cleared. Durable results remain stored and can be reopened by their owning client with the job_id.",
  };
});
