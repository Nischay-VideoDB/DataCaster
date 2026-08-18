import { defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import { apiFailure, pipelineState, rememberCurrentJob } from "../../server/compatibility.js";
import { startDurableJob } from "../../server/start-job.js";

const schema = z.object({
  source_type: z.enum(["file", "url", "video"]).default("url"),
  source: z.string().min(1).max(2048),
  content_type: z.enum(["football", "describe"]).default("football"),
  idempotency_key: z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});

export default defineEventHandler(async (event) => {
  const parsed = schema.safeParse(await readBody(event));
  if (!parsed.success) {
    return apiFailure(event, 422, "INVALID_START_PAYLOAD", "The start payload is invalid.", parsed.error.issues[0]?.message || "Submit a public HTTPS URL.");
  }
  if (parsed.data.source_type === "file") {
    return apiFailure(event, 501, "LOCAL_FILE_REQUIRES_OPERATOR", "Local file capture is not available in the public serverless deployment.", "Run the original FastAPI/operator stack locally for filesystem capture, or submit a public HTTPS media URL with source_type=url.");
  }
  if (parsed.data.source_type === "video") {
    return apiFailure(event, 410, "SHARED_VIDEO_CATALOG_REMOVED", "Direct shared-collection VideoDB IDs are not accepted by the public deployment.", "Submit the original public HTTPS media URL. This prevents one visitor from enumerating or opening another visitor’s collection assets.");
  }
  try {
    const result = await startDurableJob(event, {
      sourceUrl: parsed.data.source,
      mode: parsed.data.content_type,
      idempotencyKey: parsed.data.idempotency_key,
    });
    rememberCurrentJob(event, result.job.id);
    if (!result.reused) setResponseStatus(event, 202);
    return { ...pipelineState(result.job), reused: result.reused };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start analysis";
    if (message === "CLIENT_RATE_LIMIT") return apiFailure(event, 429, "CLIENT_RATE_LIMIT", "This client has reached the public run limit.", "Use a prepared example or retry after the 24-hour window.");
    if (message === "GLOBAL_RATE_LIMIT") return apiFailure(event, 429, "GLOBAL_RATE_LIMIT", "The public demo has reached today’s run capacity.", "Use a prepared example or retry later.");
    return apiFailure(event, 400, "START_REJECTED", message.slice(0, 300), "Submit a public HTTPS video or YouTube URL no longer than 15 minutes.");
  }
});
