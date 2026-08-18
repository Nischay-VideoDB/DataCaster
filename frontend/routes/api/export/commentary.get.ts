import { defineEventHandler } from "nitro/h3";
import { listCommentary } from "../../../server/db.js";
import { attachmentHeaders, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const items = await listCommentary(resolved.job.id, 10_000);
  return new Response(JSON.stringify({ items, job_id: resolved.job.id }, null, 2), {
    status: 200,
    headers: attachmentHeaders(`datacaster-commentary-${resolved.job.id.slice(0, 8)}.json`),
  });
});
