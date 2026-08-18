import { defineEventHandler } from "nitro/h3";
import { attachmentHeaders, jobEvents, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  return new Response(JSON.stringify({ events: jobEvents(resolved.job), job_id: resolved.job.id }, null, 2), {
    status: 200,
    headers: attachmentHeaders(`datacaster-events-${resolved.job.id.slice(0, 8)}.json`),
  });
});
