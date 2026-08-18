import { defineEventHandler } from "nitro/h3";
import { apiFailure, resolveCurrentJob } from "../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const { job } = resolved;
  if (!job.streamUrl) {
    return apiFailure(event, 409, "STREAM_NOT_READY", "VideoDB playback is not ready for this job yet.", "Poll GET /api/jobs/{job_id}; retry after the durable job reaches a stage with streamUrl.");
  }
  return {
    stream_url: job.streamUrl,
    player_url: `https://console.videodb.io/player?url=${encodeURIComponent(job.streamUrl)}`,
    job_id: job.id,
  };
});
