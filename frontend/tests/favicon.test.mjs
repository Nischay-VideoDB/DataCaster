import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the public build has an accessible branded favicon and a default icon route", async () => {
  const [indexHtml, favicon, vercelConfig] = await Promise.all([
    readFile(resolve(frontendRoot, "index.html"), "utf8"),
    readFile(resolve(frontendRoot, "public/favicon.svg"), "utf8"),
    readFile(resolve(frontendRoot, "vercel.json"), "utf8"),
  ]);

  assert.match(indexHtml, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  assert.match(favicon, /<title id="title">DataCaster<\/title>/);
  assert.deepEqual(JSON.parse(vercelConfig).rewrites, [
    { source: "/favicon.ico", destination: "/favicon.svg" },
  ]);
});
