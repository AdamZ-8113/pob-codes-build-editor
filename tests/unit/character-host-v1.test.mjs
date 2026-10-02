import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCharacterHostV1 } from "../../src/character-host-v1.js";

const fixture = async name => JSON.parse(await readFile(new URL(`../../contracts/fixtures/${name}`, import.meta.url), "utf8"));
test("strictly translates list and coalesces paired imports", async () => {
  const calls = [];
  const transport = { enabled: true, async request(request) { calls.push(request); return request.path.endsWith("characters") ? fixture("character-list-success.json") : fixture("character-data-success.json"); } };
  const host = createCharacterHostV1({ transport });
  const base = "https://www.pathofexile.com/character-window/";
  assert.equal((await host.onFetch(`${base}get-characters?accountName=Fixture&realm=PC`)).status, 200);
  const url = "?accountName=Fixture&character=FixtureRanger&realm=pc";
  const [items, passives] = await Promise.all([host.onFetch(`${base}get-items${url}`), host.onFetch(`${base}get-passive-skills${url}`)]);
  assert.equal(items.status, 200); assert.equal(passives.status, 200);
  assert.deepEqual(calls.map(call => call.path), ["/api/poe/characters", "/api/poe/import-character"]);
});
test("blocks arbitrary proxying and disabled production transport", async () => {
  const host = createCharacterHostV1();
  assert.match((await host.onFetch("https://evil.example/character-window/get-items?account=a&character=b")).error, /Blocked/);
  assert.match((await host.onFetch("https://www.pathofexile.com/character-window/get-characters?accountName=a")).error, /Paste a build code/);
  assert.match((await host.onFetch("https://www.pathofexile.com/api/profile")).error, /Blocked/);
});
test("enforces concurrency, timeout cancellation, and stale generations", async () => {
  let release;
  const transport = { enabled: true, request(_request, { signal }) { return new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => reject(signal.reason)); }); } };
  const host = createCharacterHostV1({ transport, limits: { maxConcurrency: 1, timeoutMs: 10 } });
  const first = host.onFetch("https://www.pathofexile.com/character-window/get-characters?accountName=a");
  assert.match((await host.onFetch("https://www.pathofexile.com/character-window/get-items?accountName=a&character=b")).error, /busy/);
  host.reset();
  assert.match((await first).error, /Stale|cancelled/);
  const timeout = await host.onFetch("https://www.pathofexile.com/character-window/get-items?accountName=a&character=b");
  assert.match(timeout.error, /timed out|abort/i);
  void release;
});
