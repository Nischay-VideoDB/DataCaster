import { defineEventHandler } from "nitro/h3";
import { apiFailure } from "../../../server/compatibility.js";

export default defineEventHandler((event) => apiFailure(
  event,
  501,
  "OPERATOR_SANDBOX_CONTROL_UNAVAILABLE",
  "Sandbox sweeping is an operator-machine recovery control and is not exposed by the public serverless deployment.",
  "Run the original FastAPI stack locally and use its sidecar-scoped sweep command. Public Vercel Workflow runs do not allocate DataCaster operator sandboxes.",
));
