import { defineEventHandler, readBody } from "nitro/h3";
import { z } from "zod";
import { countQuestions } from "../../server/db.js";
import { apiFailure, resolveCurrentJob } from "../../server/compatibility.js";
import { askOwnedJob } from "../../server/job-provider.js";
import { safeProviderError } from "../../server/security.js";

const schema = z.object({
  q: z.string().trim().min(4).max(300),
  threshold: z.number().int().min(1).max(20).default(6),
});

export default defineEventHandler(async (event) => {
  const parsed = schema.safeParse(await readBody(event));
  if (!parsed.success) return apiFailure(event, 400, "INVALID_QUESTION", "Ask a question between 4 and 300 characters.", "Send JSON such as {\"q\":\"What happened?\",\"threshold\":6}.");
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  if (resolved.job.status !== "completed" || !resolved.job.videoId) return apiFailure(event, 409, "JOB_NOT_READY", "Ask requires a completed indexed job.", "Poll GET /api/jobs/{job_id} until status=completed.");
  if (await countQuestions(resolved.job.id) >= 5) return apiFailure(event, 429, "QUESTION_LIMIT", "This public run has reached its limit of five questions.", "Start a genuinely different analysis or use the persisted answers already returned for this job.");
  try {
    const result = await askOwnedJob(resolved.job, parsed.data.q, parsed.data.threshold);
    return { query: result.query, answer: result.answer, evidence: result.sources };
  } catch (error) {
    if (error instanceof Error && error.message === "NO_EVIDENCE") return apiFailure(event, 409, "NO_EVIDENCE", "This job has no qualifying indexed evidence for Ask.", "Review the playable source or run a different analysis mode.");
    return apiFailure(event, 503, "ASK_UNAVAILABLE", safeProviderError(error), "Retry in a few seconds; the same job and index will be reused.");
  }
});
