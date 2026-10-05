import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import { harnessEnvironment, selectHarnesses, validateRegistry } from "../../scripts/test-browser.mjs";

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
