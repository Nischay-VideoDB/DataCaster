import { defineEventHandler, getCookie, getQuery } from "nitro/h3";
import { z } from "zod";
import { ensureSchema, findOwnedJob } from "../../server/db.js";
import { CURRENT_JOB_COOKIE, pipelineState } from "../../server/compatibility.js";
import { clientHash } from "../../server/security.js";

export default defineEventHandler(async (event) => {
  await ensureSchema();
  const queryValue = getQuery(event).job_id;
  const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  const candidate = String(queryId || event.req.headers.get("x-datacaster-job-id") || getCookie(event, CURRENT_JOB_COOKIE) || "");
  let current = null;
  const parsed = z.string().uuid().safeParse(candidate);
  if (parsed.success) {
    current = await findOwnedJob(parsed.data, clientHash(event.req));
  }
  return {
    status: "ok",
    now: Date.now() / 1000,
    storage: "azure-postgres",
    worker: "vercel-workflow",
    pipeline: pipelineState(current),
  };
});
