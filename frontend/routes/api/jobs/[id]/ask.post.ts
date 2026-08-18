import { connect, IndexTypeValues, SearchTypeValues } from "videodb";
import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { z } from "zod";
import { countQuestions, findJob, saveQuestion } from "../../../../server/db.js";
import { safeProviderError } from "../../../../server/security.js";

const schema = z.object({ question: z.string().trim().min(4).max(300) });

export default defineEventHandler(async (event) => {
  const id = z.string().uuid().safeParse(getRouterParam(event, "id"));
  if (!id.success) { setResponseStatus(event, 400); return { error: "Invalid job id" }; }
  const body = schema.safeParse(await readBody(event));
  if (!body.success) { setResponseStatus(event, 400); return { error: "Ask a question between 4 and 300 characters." }; }
  const job = await findJob(id.data);
  if (!job || job.status !== "completed" || !job.videoId) {
    setResponseStatus(event, 409); return { error: "The analysis must finish before you can ask about it." };
  }
  if (await countQuestions(job.id) >= 5) {
    setResponseStatus(event, 429); return { error: "This public run has reached its limit of 5 questions." };
  }
  try {
    const apiKey = process.env.VIDEO_DB_API_KEY || process.env.VIDEODB_API_KEY;
    if (!apiKey) throw new Error("VideoDB is not configured");
    const coll = await connect({ apiKey }).getCollection();
    const video = await coll.getVideo(job.videoId);
    let sources: Array<{ start: number; end: number; text: string; streamUrl?: string }> = [];
    if (job.sceneIndexId) {
      try {
        const result = await video.legacySearch(
          body.data.question,
          SearchTypeValues.semantic,
          IndexTypeValues.scene,
          8,
          0.05,
          undefined,
          undefined,
          "start",
        );
        sources = result.getShots().slice(0, 6).map((shot) => ({
          start: shot.start,
          end: shot.end,
          text: shot.text,
          streamUrl: shot.streamUrl,
        }));
      } catch { /* fall back to the persisted, provider-produced event records */ }
    }
    if (!sources.length) {
      sources = job.events.slice(0, 8).map((item) => ({
        start: item.start, end: item.end, text: item.summary, streamUrl: job.highlightUrl || undefined,
      }));
    }
    const context = sources.map((source) => `[${source.start.toFixed(1)}-${source.end.toFixed(1)}s] ${source.text}`).join("\n");
    const generated = await coll.generateText(
      `You are DataCaster, an evidence-first video analyst. Answer only from the timestamped VideoDB evidence below. If the evidence is insufficient, say so. Cite timestamps in square brackets.\n\nQuestion: ${body.data.question}\n\nEvidence:\n${context}`,
      "basic",
      "text",
      { maxTokens: 320, temperature: 0.1 },
    );
    const answer = typeof generated === "string"
      ? generated
      : String(generated.output || generated.text || generated.response || "The evidence was insufficient to answer.");
    await saveQuestion(job.id, body.data.question, answer, sources);
    return { answer, sources };
  } catch (error) {
    setResponseStatus(event, 502);
    return { error: safeProviderError(error) };
  }
});
