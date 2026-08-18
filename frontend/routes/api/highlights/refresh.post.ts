import { defineEventHandler } from "nitro/h3";
import { resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  return {
    stored: resolved.job.events.length,
    job_id: resolved.job.id,
    refreshed: false,
    guidance: "Highlights are derived from the persisted durable job; no background indexer or duplicate provider work was started.",
  };
});
