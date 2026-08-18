import { defineEventHandler } from "nitro/h3";
import { listCompatibilityReels } from "../../../server/db.js";
import { attachmentHeaders, resolveCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const reels = await listCompatibilityReels(resolved.job.id, 1_000);
  const items = reels.length ? reels : [{
    reelUrl: resolved.job.highlightUrl || resolved.job.streamUrl,
    caption: resolved.job.events.map((item) => item.summary).join(" "),
    aspect: "native",
    n: resolved.job.events.length,
    eventsUsed: resolved.job.events.length,
    createdAt: resolved.job.updatedAt,
  }];
  return new Response(JSON.stringify({ items, job_id: resolved.job.id }, null, 2), {
    status: 200,
    headers: attachmentHeaders(`datacaster-highlights-${resolved.job.id.slice(0, 8)}.json`),
  });
});
