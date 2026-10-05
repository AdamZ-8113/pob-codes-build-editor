import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import { harnessEnvironment, main, selectHarnesses, validateRegistry } from "../../scripts/test-browser.mjs";

const registry = JSON.parse(await readFile(new URL("../browser-harnesses.json", import.meta.url), "utf8"));
const discovered = (await readdir(new URL("../browser/", import.meta.url))).filter(name => name.endsWith(".mjs"));

test("every browser harness is classified exactly once with local-only reasons", () => {
  validateRegistry(registry, discovered);
  for (const invalid of [
    { ...registry, ci: [...registry.ci, "test-new.mjs"] },
    { ...registry, ci: registry.ci.slice(1) },
    { ...registry, ci: [...registry.ci, registry.ci[0]] },
    { ...registry, localOnly: { ...registry.localOnly, [registry.ci[0]]: "overlap" } },
    { ...registry, localOnly: { ...registry.localOnly, "test-lan-dev.mjs": " " } },
    { ...registry, chromeOnly: { "test-not-registered.mjs": "needs Chrome" } },
    { ...registry, chromeOnly: { "test-lan-dev.mjs": "must be a CI entry" } },
    { ...registry, chromeOnly: { "test-render-reuse.mjs": " " } },
  ]) assert.throws(() => validateRegistry(invalid, discovered), /Browser harness registry is stale/);
  assert.throws(() => validateRegistry(registry, [...discovered, "test-new.mjs"]), /Browser harness registry is stale/);
});

test("browser children cannot inherit an origin override", () => {
  const environment = { DESKTOP_POB_ORIGIN: "https://example.invalid", desktop_pob_origin: "", BUILD_EDITOR_BROWSER_CHANNEL: "", PATH: "tools" };
  assert.deepEqual(harnessEnvironment(environment), { BUILD_EDITOR_BROWSER_CHANNEL: "", PATH: "tools" });
  assert.equal(environment.DESKTOP_POB_ORIGIN, "https://example.invalid");
});

test("browser selection preserves manual Chrome and opts into bundled Chromium", () => {
  assert.equal(browserChannel({}), "chrome");
  assert.equal(browserChannel({ BUILD_EDITOR_BROWSER_CHANNEL: "" }), undefined);
  assert.equal(browserChannel({ BUILD_EDITOR_BROWSER_CHANNEL: "msedge" }), "msedge");
});

test("runner selects only registered harnesses", () => {
  assert.deepEqual(selectHarnesses(registry, []), registry.ci);
  assert.equal(selectHarnesses(registry, ["--all"]).length, discovered.length);
  assert.deepEqual(selectHarnesses(registry, ["--only", "test-header"]), ["test-header.mjs"]);
  assert.deepEqual(selectHarnesses(registry, ["--only", "test-lan-dev.mjs"]), ["test-lan-dev.mjs"]);
  for (const args of [["--only"], ["--only", "../test-unknown"], ["--all", "--only", "test-header"]]) {
    assert.throws(() => selectHarnesses(registry, args), /Usage:/);
  }
});

test("runner rejects every origin override before starting a server", async () => {
  for (const name of ["DESKTOP_POB_ORIGIN", "desktop_pob_origin"]) {
    for (const value of ["", "http://127.0.0.1:3999", "https://example.invalid"]) {
      await assert.rejects(main([], { [name]: value }), /refuses DESKTOP_POB_ORIGIN/);
    }
  }
});

test("runner refuses an occupied loopback port without replacing its listener", async () => {
  const listener = createServer(socket => socket.end());
  const owned = await new Promise((resolve, reject) => {
    listener.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
    listener.listen(3010, "127.0.0.1", () => resolve(true));
  });
  try {
    await assert.rejects(main(["--only", "test-browser"], harnessEnvironment()), /refuses an existing listener/);
    if (owned) assert.equal(listener.listening, true);
  } finally {
    if (owned) await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});
