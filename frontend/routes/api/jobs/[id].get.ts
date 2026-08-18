import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import { findJob, listQuestions } from "../../../server/db.js";

export default defineEventHandler(async (event) => {
  const parsed = z.string().uuid().safeParse(getRouterParam(event, "id"));
  if (!parsed.success) { setResponseStatus(event, 400); return { error: "Invalid job id" }; }
  const job = await findJob(parsed.data);
  if (!job) { setResponseStatus(event, 404); return { error: "Analysis not found" }; }
  return { job, questions: await listQuestions(job.id) };
});
