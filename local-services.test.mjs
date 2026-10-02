import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { allowedRemote, publicIPv4, fetchRemote, createLocalServices } from "./local-services.mjs";

test("network boundary permits exact public service hosts and excludes private targets", () => {
  assert.equal(allowedRemote("https://api.pathofexile.com/character").hostname, "api.pathofexile.com");
  for (const url of ["http://pobb.in/a", "https://pobb.in.evil.test/a", "https://127.0.0.1/", "https://pobb.in:8080/a", "https://user:password@pobb.in/a", "file:///a"]) assert.throws(() => allowedRemote(url));
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.3.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::1"]) assert.equal(publicIPv4(address), false);
  assert.equal(publicIPv4("1.1.1.1"), true);
});

test("redirects cannot escape allowlist and credentials do not cross origins", async () => {
  let calls = 0;
  await assert.rejects(fetchRemote({ url: "https://pobb.in/a" }, async () => {
    calls++; return { status: 302, headers: { location: "http://127.0.0.1/private" }, body: "" };
  }));
  assert.equal(calls, 1);
  await assert.rejects(fetchRemote({ url: "https://www.pathofexile.com/oauth/token", body: "code=secret" }, async () => ({ status: 307, headers: { location: "https://pobb.in/" }, body: "" })));
  const seen = [];
  const result = await fetchRemote({ url: "https://pobb.in/a", body: "code", headers: { Authorization: "secret", Cookie: "secret", Host: "evil.test" } }, async (url, options) => {
    seen.push({ url: url.href, body: options.body, headers: { ...options.headers } });
    return seen.length === 1 ? { status: 302, headers: { location: "https://pob.codes/b/a" }, body: "" } : { status: 200, headers: {}, body: "build" };
  });
  assert.equal(result.body, "build");
  assert.equal(seen[0].headers.host, undefined);
  assert.equal(seen[1].headers.authorization, undefined);
  assert.equal(seen[1].headers.cookie, undefined);
  assert.equal(seen[1].body, undefined);
});

async function harness(t) {
  const services = createLocalServices({ callbackPorts: [0], remoteRequest: async () => ({ status: 200, headers: {}, body: "ok" }) });
  const server = http.createServer((request, response) => services.middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { services.close(); await new Promise(resolve => server.close(resolve)); });
  const call = (path, payload, headers = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Pob-Local": "1", Origin: origin, ...headers }, body: JSON.stringify(payload) });
  return { call };
}

const authUrl = "https://www.pathofexile.com/oauth/authorize?client_id=pob&response_type=code&state=verified-state&code_challenge=challenge&code_challenge_method=S256";

test("service rejects cross-origin requests and missing intent header", async t => {
  const { call } = await harness(t);
  assert.equal((await call("/fetch", { url: "https://pobb.in/a" }, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await call("/fetch", { url: "https://pobb.in/a" }, { "X-Pob-Local": "" })).status, 403);
  assert.equal((await call("/fetch", { url: "https://pobb.in/a" })).status, 200);
});

test("OAuth callback validates state and returns PoB's code, state, and callback port", async t => {
  const { call } = await harness(t);
  const session = await (await call("/oauth/start", { url: authUrl })).json();
  assert.equal(new URL(session.url).searchParams.get("redirect_uri"), `http://localhost:${session.port}`);
  const callback = `http://127.0.0.1:${session.port}/`;
  assert.equal((await fetch(callback + "?state=incorrect&code=secret")).status, 400);
  assert.equal((await (await call("/oauth/poll", { id: session.id })).json()).done, false);
  assert.equal((await fetch(callback + "?state=verified-state&code=synthetic-code")).status, 200);
  const complete = await (await call("/oauth/poll", { id: session.id })).json();
  assert.deepEqual(complete, { done: true, result: { code: "synthetic-code", state: "verified-state", port: session.port } });
  assert.equal((await call("/oauth/poll", { id: session.id })).status, 404);
});

test("OAuth cancellation closes callback listener and invalid targets are rejected", async t => {
  const { call } = await harness(t);
  assert.equal((await call("/oauth/start", { url: authUrl.replace("www.pathofexile.com", "pobb.in") })).status, 400);
  const session = await (await call("/oauth/start", { url: authUrl })).json();
  const result = await (await call("/oauth/cancel", { id: session.id })).json();
  assert.equal(result.result.error, "Authorization cancelled.");
  await assert.rejects(fetch(`http://127.0.0.1:${session.port}/`));
});
