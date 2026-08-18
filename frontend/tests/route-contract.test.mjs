import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(frontendRoot, "..");

const expected = [
  "GET /api/health",
  "GET /api/videos",
  "POST /api/start",
  "POST /api/stop",
  "POST /api/sandbox/sweep",
  "POST /api/end_session",
  "POST /api/live_stream",
  "GET /api/events",
  "GET /api/events/history",
  "GET /api/stats",
  "POST /api/events/resync",
  "GET /api/search",
  "POST /api/commentary",
  "GET /api/commentary/track",
  "GET /api/highlights/stream",
  "GET /api/highlights",
  "POST /api/highlights/refresh",
  "POST /api/highlights/reel",
  "POST /api/ask",
  "GET /api/export/events",
  "GET /api/export/commentary",
  "GET /api/export/highlights",
].sort();

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

test("the production Nitro adapter covers the entire original FastAPI route contract", async () => {
  const backendFiles = (await walk(resolve(repositoryRoot, "backend/routes"))).filter((path) => path.endsWith(".py"));
  const declared = [];
  for (const path of backendFiles) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/@router\.(get|post)\("([^"]+)"\)/g)) {
      declared.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }
  assert.deepEqual(declared.sort(), expected);

  const routeRoot = resolve(frontendRoot, "routes");
  const routeFiles = (await walk(routeRoot)).filter((path) => /\.(get|post)\.ts$/.test(path));
  const implemented = routeFiles.map((path) => {
    const local = relative(routeRoot, path).split(sep).join("/");
    const match = local.match(/^(.*)\.(get|post)\.ts$/);
    return `${match[2].toUpperCase()} /${match[1].replace(/\/index$/, "")}`;
  }).sort();
  for (const route of expected) assert.ok(implemented.includes(route), `missing Nitro adapter for ${route}`);
});

test("job-scoped compatibility routes cannot enumerate the shared collection or fall through to the SPA", async () => {
  const [compatibility, videos, catchAll, events, start, stop, sweep, resync] = await Promise.all([
    readFile(resolve(frontendRoot, "server/compatibility.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/videos.get.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/[...path].ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/events.get.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/start.post.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/stop.post.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/sandbox/sweep.post.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/events/resync.post.ts"), "utf8"),
  ]);

  assert.match(compatibility, /findOwnedJob\(parsed\.data, clientHash\(event\.req\)\)/);
  assert.match(videos, /SHARED_VIDEO_CATALOG_REMOVED/);
  assert.doesNotMatch(videos, /getVideos|getCollection/);
  assert.match(catchAll, /setResponseStatus\(event, 404\)/);
  assert.match(catchAll, /API_ROUTE_NOT_FOUND/);
  assert.match(events, /text\/event-stream/);
  assert.match(events, /resolveCurrentJob/);
  assert.match(start, /LOCAL_FILE_REQUIRES_OPERATOR/);
  assert.match(start, /source_type === "video"/);
  assert.match(stop, /DURABLE_JOB_CANNOT_BE_STOPPED/);
  assert.match(sweep, /OPERATOR_SANDBOX_CONTROL_UNAVAILABLE/);
  assert.match(resync, /DURABLE_REINDEX_REQUIRES_NEW_JOB/);
});

test("the live job routes enforce ownership and establish the compatibility current-job cookie", async () => {
  const [create, read, ask] = await Promise.all([
    readFile(resolve(frontendRoot, "routes/api/jobs.post.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/jobs/[id].get.ts"), "utf8"),
    readFile(resolve(frontendRoot, "routes/api/jobs/[id]/ask.post.ts"), "utf8"),
  ]);
  assert.match(create, /rememberCurrentJob\(event, result\.job\.id\)/);
  assert.match(read, /findOwnedJob\(parsed\.data, clientHash\(event\.req\)\)/);
  assert.match(ask, /findOwnedJob\(id\.data, clientHash\(event\.req\)\)/);
});
