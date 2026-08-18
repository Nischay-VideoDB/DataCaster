import { defineEventHandler, getQuery } from "nitro/h3";
import { z } from "zod";
import { apiFailure, resolveCurrentJob } from "../../server/compatibility.js";
import { searchOwnedJob } from "../../server/job-provider.js";
import { safeProviderError } from "../../server/security.js";

const schema = z.object({
  q: z.string().trim().min(1).max(300),
  kind: z.enum(["visual", "audio", "transcript"]).default("visual"),
  threshold: z.coerce.number().int().min(1).max(50).default(10),
});

export default defineEventHandler(async (event) => {
  const parsed = schema.safeParse(getQuery(event));
  if (!parsed.success) return apiFailure(event, 400, "INVALID_SEARCH", "Search parameters are invalid.", parsed.error.issues[0]?.message || "Provide q, kind and threshold.");
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  if (parsed.data.kind !== "visual") {
    return apiFailure(event, 501, "INDEX_RAIL_NOT_AVAILABLE", `${parsed.data.kind} search is unavailable because the durable public workflow creates only a job-scoped visual scene index.`, "Use kind=visual. Run the original operator stack locally when realtime audio/transcript rails are required.");
  }
  try {
    const shots = await searchOwnedJob(resolved.job, parsed.data.q, parsed.data.threshold);
    return { q: parsed.data.q, kind: parsed.data.kind, shots, job_id: resolved.job.id };
  } catch (error) {
    if (error instanceof Error && error.message === "JOB_NOT_READY") return apiFailure(event, 409, "JOB_NOT_READY", "Search requires a completed indexed job.", "Poll GET /api/jobs/{job_id} until status=completed.");
    return apiFailure(event, 502, "VIDEODB_SEARCH_FAILED", safeProviderError(error), "Retry without creating a new job; searches do not restart indexing.");
  }
});
