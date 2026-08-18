import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("hosted runs use durable storage, Vercel Workflow, real VideoDB and public abuse controls", async () => {
  const [route, workflow, db, security, ui] = await Promise.all([
    readFile(resolve(frontendRoot, "routes/api/jobs.post.ts"), "utf8"),
    readFile(resolve(frontendRoot, "workflows/analyze-match.ts"), "utf8"),
    readFile(resolve(frontendRoot, "server/db.ts"), "utf8"),
    readFile(resolve(frontendRoot, "server/security.ts"), "utf8"),
    readFile(resolve(frontendRoot, "src/components/PublicLiveAnalysis.tsx"), "utf8"),
  ]);
  assert.match(route, /start\(analyzeMatch/);
  assert.match(workflow, /"use workflow"/);
  assert.match(workflow, /uploadURL/);
  assert.match(workflow, /indexVisuals/);
  assert.match(workflow, /generateStream/);
  assert.match(workflow, /findReusableAsset/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS analysis_jobs/);
  assert.match(db, /UNIQUE \(client_hash, idempotency_key\)/);
  assert.match(db, /CLIENT_RATE_LIMIT/);
  assert.match(security, /Only HTTPS media URLs are accepted/);
  assert.match(security, /isPrivateAddress/);
  assert.match(ui, /Ask VideoDB/);
  assert.match(ui, /results persist across refreshes/);
});
