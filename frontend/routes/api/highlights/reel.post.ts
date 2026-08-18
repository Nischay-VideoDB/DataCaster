import { defineEventHandler, readBody } from "nitro/h3";
import { z } from "zod";
import { apiFailure, resolveCurrentJob } from "../../../server/compatibility.js";
import { generateOwnedReel } from "../../../server/job-provider.js";
import { safeProviderError } from "../../../server/security.js";

const schema = z.object({
  n: z.number().int().min(1).max(10).default(3),
  aspect: z.enum(["vertical", "square", "landscape"]).default("vertical"),
  deliver: z.enum(["telegram", "none"]).default("telegram"),
});

export default defineEventHandler(async (event) => {
  const raw = await readBody(event);
  const parsed = schema.safeParse(raw || {});
  if (!parsed.success) return apiFailure(event, 400, "INVALID_REEL_REQUEST", "The reel request is invalid.", parsed.error.issues[0]?.message || "Use n=1..10, a supported aspect and deliver=none.");
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  if (parsed.data.deliver === "telegram") {
    return apiFailure(event, 501, "PUBLIC_DELIVERY_DISABLED", "The public adapter never sends media to an operator-configured Telegram chat.", "Retry with deliver=none. The endpoint will return a persisted VideoDB reel URL and caption without messaging any external recipient.");
  }
  try {
    const reel = await generateOwnedReel(resolved.job, parsed.data.n, parsed.data.aspect);
    return {
      reel_url: reel.reelUrl,
      caption: reel.caption,
      aspect: reel.aspect,
      n: reel.n,
      events_used: reel.eventsUsed,
      delivered_to: null,
      telegram_message_id: null,
      telegram_configured: false,
      job_id: resolved.job.id,
      reused: Boolean(reel.createdAt),
      adapter_note: "VideoDB composes the selected event windows. The legacy aspect value is retained as artifact metadata; the source stream keeps its native presentation.",
    };
  } catch (error) {
    if (error instanceof Error && error.message === "JOB_NOT_READY") return apiFailure(event, 409, "JOB_NOT_READY", "Reel generation requires a completed job.", "Poll the durable job until it completes.");
    if (error instanceof Error && error.message === "NO_EVIDENCE") return apiFailure(event, 409, "NO_EVIDENCE", "No qualifying event windows are available for a reel.", "Review the full source stream or run a different analysis mode.");
    return apiFailure(event, 502, "REEL_FAILED", safeProviderError(error), "Retry the same job/n/aspect; persisted artifacts are reused.");
  }
});
