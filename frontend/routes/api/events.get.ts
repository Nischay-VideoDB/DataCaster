import { defineEventHandler } from "nitro/h3";
import { findOwnedJob } from "../../server/db.js";
import { clientHash } from "../../server/security.js";
import { eventRecord, resolveCurrentJob } from "../../server/compatibility.js";

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default defineEventHandler(async (event) => {
  const resolved = await resolveCurrentJob(event);
  if (resolved.failure) return resolved.failure;
  const initial = resolved.job;
  const owner = clientHash(event.req);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let seen = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        controller.close();
      };
      const pump = async () => {
        if (closed) return;
        try {
          const job = await findOwnedJob(initial.id, owner);
          if (!job) {
            controller.enqueue(frame("error", { type: "error", code: "JOB_NOT_FOUND" }));
            close();
            return;
          }
          job.events.slice(seen).forEach((item, offset) => {
            const record = eventRecord(item, seen + offset, job);
            controller.enqueue(frame("event", { type: "event", event: record }));
          });
          seen = job.events.length;
          controller.enqueue(frame("vod_progress", {
            type: "vod_progress",
            indexed: job.status === "completed" ? Math.ceil((job.durationSeconds || 0) / 6) : seen,
            new_in_batch: 0,
            progress: job.progress,
            stage: job.stage,
          }));
          if (job.status === "completed" || job.status === "failed") {
            controller.enqueue(frame("complete", { type: "complete", status: job.status, job_id: job.id }));
            close();
            return;
          }
          controller.enqueue(frame("ping", {}));
          timer = setTimeout(() => void pump(), 4_000);
        } catch (error) {
          controller.enqueue(frame("error", { type: "error", code: "STREAM_POLL_FAILED", message: error instanceof Error ? error.message : "poll failed" }));
          close();
        }
      };
      controller.enqueue(encoder.encode("retry: 4000\n\n"));
      void pump();
      event.req.signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
