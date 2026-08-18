import { defineEventHandler } from "nitro/h3";
import { apiFailure, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const url = resolved.job.highlightUrl || resolved.job.streamUrl;
  if (!url) return apiFailure(event, 409, "HIGHLIGHT_NOT_READY", "The job has no playable VideoDB stream yet.", "Poll the durable job until streamUrl or highlightUrl is populated.");
  return {
    mode: "timeline",
    stream_url: url,
    summary: `${resolved.job.events.length} indexed event${resolved.job.events.length === 1 ? "" : "s"} from the current durable job`,
    job_id: resolved.job.id,
  };
});
