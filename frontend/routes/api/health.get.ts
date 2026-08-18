import { defineEventHandler } from "nitro/h3";
import { ensureSchema } from "../../server/db.js";

export default defineEventHandler(async () => {
  await ensureSchema();
  return { status: "ok", storage: "azure-postgres", worker: "vercel-workflow" };
});
