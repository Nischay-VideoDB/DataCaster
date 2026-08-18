import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("prepared showcase ships three frozen sessions with evidence, playback, and an operator handoff", async () => {
  const [app, manifest] = await Promise.all([
    readFile(resolve(frontendRoot, "src/App.tsx"), "utf8"),
    readFile(resolve(frontendRoot, "src/lib/prepared-sessions.ts"), "utf8"),
  ]);

  assert.match(manifest, /version: "2026-08-18"/);
  assert.match(manifest, /id: "matchday-two-goal-review"/);
  assert.match(manifest, /id: "matchday-two-discipline-review"/);
  assert.match(manifest, /id: "matchday-two-reel-handoff"/);
  assert.equal((manifest.match(/embed\/lR99z0Jel-4/g) ?? []).length, 3);
  assert.match(manifest, /They are not fresh provider responses/);
  assert.match(manifest, /No standalone exported VideoDB reel URL is retained/);

  assert.match(app, /aria-label="Prepared match sessions"/);
  assert.match(app, /aria-pressed=\{active\}/);
  assert.match(app, /selected\.timeline\.map/);
  assert.match(app, /selected\.evidence\.map/);
  assert.match(app, /Open source VOD/);
  assert.match(app, /If the embedded player is unavailable/);
  assert.match(app, /Want a fresh run\?/);
  assert.match(app, /New analysis/);
  assert.match(app, /Prepared examples/);
});
