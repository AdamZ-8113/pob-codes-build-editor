import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyImport2Config } from "./verify-import2-release.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));

test("Import2 deployment is an assets-only prefix route", async () => {
  const config = await verifyImport2Config();
  assert.equal(config.assets.not_found_handling, "404-page");
  assert.equal("main" in config, false);
  assert.equal(config.routes[0].pattern, "pob.codes/import2*");
});

test("Import2 runtime is browser-only and fail-closed on legacy payloads", async () => {
  const main = await readFile(join(appDir, "src/main.ts"), "utf8");
  const payload = await readFile(join(appDir, "upstream/packages/driver/src/js/payload.ts"), "utf8");
  const productionProfile = await readFile(join(appDir, "profile-import2-production.mjs"), "utf8");
  assert.match(main, /allowLegacyPayloadFallback: !import2Preview/);
  assert.match(main, /PoB Codes Import2 Preview v1/);
  assert.match(main, /Network access is unavailable in this browser-only preview/);
  assert.match(main, /payloadPrefetch"\) === "1"/);
  assert.match(payload, /allowLegacyFallback !== false/);
  assert.match(productionProfile, /\/cdn-cgi\//);
  assert.match(productionProfile, /Disabled page contains a non-Cloudflare script/);
  assert.doesNotMatch(productionProfile, /process\.exit/);
});
