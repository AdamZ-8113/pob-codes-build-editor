import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseTestServer } from "../../scripts/release/serve-test-release.mjs";

test("candidate server serves static release bytes and controls with no dev fallback or arbitrary Host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pob-release-server-"));
  let server;
  try {
    await mkdir(join(directory, "import2"));
    await writeFile(join(directory, "import2/index.html"), "candidate only");
    await writeFile(join(directory, "_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n/import2/\n  Cache-Control: public, max-age=0, must-revalidate\n");
    await writeFile(join(directory, "_redirects"), "/import2 /import2/ 308\n");
    server = await createReleaseTestServer(directory);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/import2/`);
    assert.equal(await response.text(), "candidate only");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const redirect = await fetch(`${origin}/import2`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/import2/");
    for (const path of ["/", "/src/main.ts", "/payload/manifest.json", "/_headers", "/_redirects", "/%2e%2e%5cpackage.json", "/import2/unknown", "/.git/config"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${origin}/import2/`, { method: "POST" })).status, 405);
    const badHost = await new Promise((resolve, reject) => {
      const req = request(`${origin}/import2/`, { headers: { host: "pob.codes" } }, response => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(badHost, 403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
