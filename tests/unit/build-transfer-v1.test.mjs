import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBuildTransferV1 } from "../../src/build-transfer-v1.js";

const code = "abcDEF_0123456789-xyz";
const response = (body, { ok = true, status = 200, cache = "no-store" } = {}) => ({
  ok,
  status,
  headers: { get(name) { return name.toLowerCase() === "cache-control" ? cache : null; } },
  async json() { return typeof body === "string" ? JSON.parse(body) : body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

test("raw codes and owned pob.codes links resolve without an external-site upload", async () => {
  const calls = [];
  const transfer = createBuildTransferV1({
    apiBaseUrl: "https://api.pob.codes",
    getBuildCode: async () => code,
    fetchImpl: async (...args) => { calls.push(args); return response(code); },
  });
  assert.equal(await transfer.resolve(code), code);
  assert.equal(await transfer.resolve("https://pob.codes/b/abc_1234"), code);
  assert.equal(calls[0][0], "https://api.pob.codes/abc_1234/raw");
  assert.throws(() => createBuildTransferV1({ apiBaseUrl: "https://pob.codes/api", getBuildCode: async () => code }), /api\.pob\.codes/);
});

test("external links use the same guarded resolver as the /b/ importer", async () => {
  for (const input of [
    "https://pobb.in/example123",
    "https://poe.ninja/poe1/pob/example123",
    "maxroll.gg/poe/pob/example123",
    "https://pastebin.com/example123",
    "https://poedb.tw/pob/example123",
    "pob://pobbin/example123",
  ]) {
    const calls = [];
    const transfer = createBuildTransferV1({
      apiBaseUrl: "https://api.pob.codes",
      getBuildCode: async () => code,
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return url.endsWith("/pob")
          ? response({ id: "resolved_123", shortUrl: "/b/resolved_123" }, { status: 201 })
          : response(code);
      },
    });
    assert.equal(await transfer.resolve(input), code);
    assert.equal(calls[0][0], "https://api.pob.codes/pob");
    assert.equal(calls[0][1].body, input);
    assert.equal(calls[0][1].headers["x-pobcodes-client"], "web");
    assert.equal(calls[1][0], "https://api.pob.codes/resolved_123/raw");
  }
});

test("shell exposes one Launch in PoB.Codes action and no Contribute link", async () => {
  const [html, main] = await Promise.all([readFile("index.html", "utf8"), readFile("src/main.ts", "utf8")]);
  assert.match(html, /id="launch-build"[^>]*disabled>Launch in PoB\.Codes/);
  assert.doesNotMatch(html, />Contribute</);
  assert.doesNotMatch(html, /id="shared-build"/);
  assert.match(main, /window\.open\("about:blank", "_blank"\)/);
  assert.match(main, /buildTransfer!\.share\(\)/);
});

test("sharing uses PoB's native pob.codes plain endpoint and retries the exact snapshot", async () => {
  let attempt = 0;
  let exports = 0;
  const bodies = [];
  const transfer = createBuildTransferV1({
    apiBaseUrl: "https://api.pob.codes/",
    getBuildCode: async () => { exports++; return code; },
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.pob.codes/pob/plain");
      assert.equal(init.headers["x-pobcodes-client"], "web");
      bodies.push(init.body);
      attempt++;
      return attempt === 1 ? response("failed", { ok: false, status: 500 }) : response("share_123", { status: 200 });
    },
  });
  await assert.rejects(transfer.share(), /retry/);
  assert.equal(transfer.hasPendingShare, true);
  assert.equal(await transfer.retry(), "https://pob.codes/b/share_123");
  assert.equal(exports, 1);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(transfer.hasPendingShare, false);
});

test("native PoB build-site requests are restricted to the shared resolver and plain upload", async () => {
  const calls = [];
  const transfer = createBuildTransferV1({
    apiBaseUrl: "https://api.pob.codes",
    getBuildCode: async () => code,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith("/pob")) return response({ id: "resolved_123", shortUrl: "/b/resolved_123" }, { status: 201 });
      if (url.endsWith("/raw")) return response(code);
      if (url.endsWith("/pob/plain")) return response("shared_123");
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal((await transfer.onFetch("https://pobb.in/pob/example123")).body, code);
  assert.equal((await transfer.onFetch("https://api.pob.codes/resolved_123/raw")).body, code);
  assert.equal((await transfer.onFetch("https://api.pob.codes/pob/plain", {}, code)).body, "shared_123");
  assert.equal(await transfer.onFetch("https://example.com/build/example123"), undefined);
  assert.equal(calls.filter(([url]) => url.endsWith("/pob")).length, 1);
});
