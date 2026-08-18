import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import { analyzeMatch } from "../../workflows/analyze-match.js";
import { assertWithinRateLimits, createJob, findIdempotentJob, updateJob } from "../../server/db.js";
import { clientHash, defaultIdempotencyKey, validatePublicMediaUrl } from "../../server/security.js";

const bodySchema = z.object({
  sourceUrl: z.string().min(1).max(2048),
  mode: z.enum(["football", "describe"]).default("football"),
  idempotencyKey: z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});

export default defineEventHandler(async (event) => {
  try {
    const body = bodySchema.parse(await readBody(event));
    const sourceUrl = await validatePublicMediaUrl(body.sourceUrl);
    const hash = clientHash(event.req);
    const key = body.idempotencyKey || defaultIdempotencyKey(sourceUrl, body.mode);
    const existing = await findIdempotentJob(hash, key);
    if (existing) return { job: existing, reused: true };
    await assertWithinRateLimits(hash);
    const job = await createJob({
      id: randomUUID(),
      clientHash: hash,
      idempotencyKey: key,
      sourceUrl,
      mode: body.mode,
    });
    const run = await start(analyzeMatch, [job.id, sourceUrl, body.mode]);
    await updateJob(job.id, { workflowRunId: run.runId });
    setResponseStatus(event, 202);
    return { job: { ...job, workflowRunId: run.runId }, reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start analysis";
    if (message === "CLIENT_RATE_LIMIT") {
      setResponseStatus(event, 429); return { error: "This browser has reached the public limit of 3 runs per 24 hours." };
    }
    if (message === "GLOBAL_RATE_LIMIT") {
      setResponseStatus(event, 429); return { error: "Today’s public demo capacity has been reached. Prepared runs remain available." };
    }
    setResponseStatus(event, 400);
    return { error: message.slice(0, 300) };
  }
});
