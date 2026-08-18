import { defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import { rememberCurrentJob } from "../../server/compatibility.js";
import { startDurableJob } from "../../server/start-job.js";

const bodySchema = z.object({
  sourceUrl: z.string().min(1).max(2048),
  mode: z.enum(["football", "describe"]).default("football"),
  idempotencyKey: z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});

export default defineEventHandler(async (event) => {
  try {
    const body = bodySchema.parse(await readBody(event));
    const result = await startDurableJob(event, body);
    rememberCurrentJob(event, result.job.id);
    if (!result.reused) setResponseStatus(event, 202);
    return result;
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
