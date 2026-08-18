import { defineEventHandler } from "nitro/h3";
import { apiFailure } from "../../server/compatibility.js";

export default defineEventHandler((event) => apiFailure(
  event,
  410,
  "SHARED_VIDEO_CATALOG_REMOVED",
  "The public deployment intentionally does not list the shared VideoDB collection.",
  "Submit a public HTTPS media URL to POST /api/jobs or POST /api/start. Results and media are scoped to the owning client and current job_id.",
));
