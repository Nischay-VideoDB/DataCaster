import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import { findOwnedJob, listQuestions } from "../../../server/db.js";
import { clientHash } from "../../../server/security.js";
import { rememberCurrentJob } from "../../../server/compatibility.js";

export default defineEventHandler(async (event) => {
  const parsed = z.string().uuid().safeParse(getRouterParam(event, "id"));
  if (!parsed.success) { setResponseStatus(event, 400); return { error: "Invalid job id" }; }
  const job = await findOwnedJob(parsed.data, clientHash(event.req));
  if (!job) { setResponseStatus(event, 404); return { error: "Analysis not found" }; }
  rememberCurrentJob(event, job.id);
  return { job, questions: await listQuestions(job.id) };
});
