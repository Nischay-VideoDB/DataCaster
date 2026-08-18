import { randomUUID } from "node:crypto";
import type { H3Event } from "nitro/h3";
import { start } from "workflow/api";
import type { AnalysisMode } from "./db.js";
import { assertWithinRateLimits, createJob, findIdempotentJob, updateJob } from "./db.js";
import { clientHash, defaultIdempotencyKey, validatePublicMediaUrl } from "./security.js";
import { analyzeMatch } from "../workflows/analyze-match.js";

export async function startDurableJob(event: H3Event, input: {
  sourceUrl: string;
  mode: AnalysisMode;
  idempotencyKey?: string;
}) {
  const sourceUrl = await validatePublicMediaUrl(input.sourceUrl);
  const hash = clientHash(event.req);
  const key = input.idempotencyKey || defaultIdempotencyKey(sourceUrl, input.mode);
  const existing = await findIdempotentJob(hash, key);
  if (existing) return { job: existing, reused: true };
  await assertWithinRateLimits(hash);
  const job = await createJob({
    id: randomUUID(),
    clientHash: hash,
    idempotencyKey: key,
    sourceUrl,
    mode: input.mode,
  });
  const run = await start(analyzeMatch, [job.id, sourceUrl, input.mode]);
  await updateJob(job.id, { workflowRunId: run.runId });
  return { job: { ...job, workflowRunId: run.runId }, reused: false };
}
