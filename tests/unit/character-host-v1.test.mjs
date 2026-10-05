import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCharacterHostV1, createPobCodesCharacterTransport } from "../../src/character-host-v1.js";

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
test("production transport adapts the existing guarded PoB Codes routes", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const request = JSON.parse(init.body);
    return request.characterName
      ? Response.json({ itemsJson: '{"items":[],"character":{"name":"FixtureRanger"}}', passiveSkillsJson: '{"hashes":[1],"hashes_ex":[],"mastery_effects":{}}' })
      : Response.json({ accountName: request.accountName, characters: [{ name: "FixtureRanger" }], realm: { realmCode: request.realm } });
  };
  const transport = createPobCodesCharacterTransport({ origin: "https://pob.codes", fetchImpl });
  const list = await transport.request({ method: "POST", path: "/api/poe/characters", body: { contractVersion: 1, realm: "pc", account: "Fixture#1234" } }, { signal: new AbortController().signal });
  const character = await transport.request({ method: "POST", path: "/api/poe/import-character", body: { contractVersion: 1, realm: "pc", account: "Fixture#1234", character: "FixtureRanger" } }, { signal: new AbortController().signal });
  assert.deepEqual(list, { ok: true, data: { characters: [{ name: "FixtureRanger" }] } });
  assert.deepEqual(character, { ok: true, data: { items: { items: [], character: { name: "FixtureRanger" } }, passiveSkills: { hashes: [1], hashes_ex: [], mastery_effects: {} } } });
  assert.deepEqual(calls.map(call => call.url), ["https://pob.codes/api/poe/characters", "https://pob.codes/api/poe/import-character"]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { accountName: "Fixture#1234", realm: "pc" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { accountName: "Fixture#1234", characterName: "FixtureRanger", realm: "pc" });
  assert.ok(calls.every(call => call.init.credentials === "omit" && call.init.redirect === "error"));
});
test("production transport preserves guarded API errors", async () => {
  const transport = createPobCodesCharacterTransport({
    origin: "https://pob.codes",
    fetchImpl: async () => Response.json({ code: "POE_ACCOUNT_PRIVATE", error: "Account profile is private." }, { status: 403 }),
  });
  const host = createCharacterHostV1({ transport });
  const result = await host.onFetch("https://www.pathofexile.com/character-window/get-characters?accountName=Fixture&realm=pc");
  assert.match(result.error, /Account profile is private/);
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

// Matches ImportTab.lua's list -> profile -> items/passives callback sequence.
test("completes the PoB profile follow-up only for the active listed account", async () => {
  const calls = [];
  const host = createCharacterHostV1({ transport: createPobCodesCharacterTransport({
    origin: "https://pob.codes",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return String(url).endsWith("/characters")
        ? Response.json({ characters: [{ name: "FixtureRanger" }] })
        : Response.json({ itemsJson: '{"items":[]}', passiveSkillsJson: '{"hashes":[1]}' });
    },
  }) });
  const account = "Fixture??#1234";
  const encoded = encodeURIComponent(account);
  const base = "https://www.pathofexile.com/";
  const profile = `${base}account/view-profile/${encoded}`;
  assert.match((await host.onFetch(profile)).error, /Blocked/);
  assert.equal((await host.onFetch(`${base}character-window/get-characters?accountName=${encoded}&realm=pc`)).status, 200);
  const response = await host.onFetch(profile);
  assert.equal(response.status, 200);
  assert.equal(decodeURIComponent(response.body.match(/\/view-profile\/([^/]+)\/characters/)[1]), account);
  assert.equal(calls.length, 1, "profile callback must not make another network request");
  for (const url of [`${profile}/characters`, `${profile}?extra=1`, `${base}account/view-profile/Other`, `${base}oauth/authorize`]) {
    assert.match((await host.onFetch(url)).error, /Blocked/);
  }
  const query = `?accountName=${encoded}&character=FixtureRanger&realm=pc`;
  const results = await Promise.all(["get-items", "get-passive-skills"].map(operation => host.onFetch(`${base}character-window/${operation}${query}`)));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(calls.length, 2);
  await host.onFetch(`${base}character-window/get-characters?accountName=Other&realm=pc`);
  assert.match((await host.onFetch(profile)).error, /Blocked/);
  host.reset();
  assert.match((await host.onFetch(`${base}account/view-profile/Other`)).error, /Blocked/);
});
