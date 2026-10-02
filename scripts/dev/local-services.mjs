import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { devRequestHost } from "./dev-network.mjs";

const hosts = new Set(["www.pathofexile.com", "pathofexile.com", "api.pathofexile.com", "pob.codes", "api.pob.codes", "pobb.in", "pastebin.com", "pastebinp.com", "poe.ninja"]);
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const maxRequest = 8 * 1024 * 1024;
const maxResponse = 32 * 1024 * 1024;

export function allowedRemote(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error("This network destination is not supported by the local PoB bridge.");
  return url;
}

export function publicIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

async function secureRequest(url, { headers, body }) {
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) throw new Error("Network destination resolved to a non-public address.");
  // Pin the verified DNS result for this connection; do not resolve it again in HTTPS.
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: body === undefined ? "GET" : "POST", headers, timeout: 30_000,
      lookup: (_host, options, callback) => options.all
        ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
    }, response => {
      const chunks = []; let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > maxResponse) response.destroy(new Error("Remote response exceeded the local bridge limit."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("Remote request timed out.")));
    request.on("error", reject);
    request.end(body);
  });
}

export async function fetchRemote(payload, request = secureRequest) {
  let url = allowedRemote(payload.url);
  let body = payload.body;
  if (body !== undefined && (typeof body !== "string" || Buffer.byteLength(body) > maxRequest)) throw new Error("Invalid request body.");
  const headers = {};
  for (const [name, value] of Object.entries(payload.headers ?? {})) {
    if (!/^[a-z0-9-]+$/i.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Invalid request header.");
    if (["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "accept-encoding", "upgrade", "te", "trailer"].includes(name.toLowerCase())) continue;
    headers[name.toLowerCase()] = value;
  }
  headers["accept-encoding"] = "identity";
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded";
  for (let count = 0; count < 6; count++) {
    const response = await request(url, { headers, body });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      const next = allowedRemote(new URL(response.headers.location, url).href);
      if (next.origin !== url.origin && body !== undefined && [307, 308].includes(response.status)) throw new Error("Refusing to forward a request body to another origin.");
      if (next.origin !== url.origin) { delete headers.authorization; delete headers.cookie; }
      if ([301, 302, 303].includes(response.status)) { body = undefined; delete headers["content-type"]; }
      url = next;
      continue;
    }
    return { body: response.body, status: response.status, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])) };
  }
  throw new Error("Too many remote redirects.");
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function localRequest(request, lanHosts) {
  if (!loopback.has(request.socket.remoteAddress) || request.method !== "POST" || request.headers["x-pob-local"] !== "1" || !request.headers["content-type"]?.startsWith("application/json")) return false;
  try {
    const origin = new URL(request.headers.origin);
    const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.protocol === "http:";
    const lan = request.socket.encrypted && origin.protocol === "https:" && lanHosts.includes(origin.hostname);
    return (localhost || lan) && origin.host === devRequestHost(request.headers);
  } catch { return false; }
}

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequest) throw new Error("Local request exceeded the size limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sameState(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createLocalServices({ remoteRequest, callbackPorts = [49082, 49083, 49084], lanHosts = /** @type {string[]} */([]) } = {}) {
  const sessions = new Map(); let activeRequests = 0;
  async function startOAuth({ url: value, timeoutMs = 60_000 }) {
    const url = allowedRemote(value);
    const state = url.searchParams.get("state");
    if (url.origin !== "https://www.pathofexile.com" || url.pathname !== "/oauth/authorize" || url.searchParams.get("client_id") !== "pob" || url.searchParams.get("response_type") !== "code" || !state || state.length > 256 || url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge")) throw new Error("Invalid PoE OAuth authorization request.");
    if (sessions.size >= 4) throw new Error("An authorization session is already pending.");
    const id = randomBytes(24).toString("hex");
    const session = { state, done: false, result: undefined, server: undefined, timer: undefined, expiry: undefined, port: 0 };
    const finish = result => {
      if (session.done) return;
      session.done = true; session.result = { ...result, state, port: session.port };
      clearTimeout(session.timer); session.server.close();
      session.expiry = setTimeout(() => sessions.delete(id), 60_000); session.expiry.unref();
    };
    const server = http.createServer((request, response) => {
      let callback;
      try { callback = new URL(request.url, "http://localhost"); }
      catch { response.writeHead(400); response.end("Invalid authorization callback."); return; }
      if (!loopback.has(request.socket.remoteAddress) || request.method !== "GET" || callback.pathname !== "/" || !sameState(callback.searchParams.get("state"), state) || (!callback.searchParams.has("code") && !callback.searchParams.has("error"))) {
        response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); response.end("Invalid authorization callback."); return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
      response.end("Authorization received. Return to the local Path of Building window.");
      finish({ code: callback.searchParams.get("code") || undefined, error: callback.searchParams.get("error") || undefined });
    });
    server.requestTimeout = 5_000; server.headersTimeout = 5_000;
    session.server = server;
    for (let index = 0; index < callbackPorts.length; index++) {
      try {
        await new Promise((resolve, reject) => {
          const failed = error => { server.off("listening", listening); reject(error); };
          const listening = () => { server.off("error", failed); resolve(); };
          server.once("error", failed); server.once("listening", listening); server.listen(callbackPorts[index], "127.0.0.1");
        });
        break;
      } catch (error) { if (error.code !== "EADDRINUSE" || index === callbackPorts.length - 1) throw error; }
    }
    session.port = server.address().port;
    session.timer = setTimeout(() => finish({ error: "Authorization timed out." }), Math.max(1000, Math.min(300_000, Number(timeoutMs) || 60_000))); session.timer.unref();
    session.cancel = () => finish({ error: "Authorization cancelled." });
    sessions.set(id, session);
    // Keep the URI identical to PoEAPI.lua's later token exchange.
    url.searchParams.set("redirect_uri", `http://localhost:${session.port}`);
    return { id, url: url.href, state, port: session.port };
  }
  async function middleware(request, response, next) {
    const route = request.url?.split("?")[0];
    if (!["/fetch", "/oauth/start", "/oauth/poll", "/oauth/cancel"].includes(route)) { next(); return; }
    if (!localRequest(request, lanHosts)) { json(response, 403, { error: "Only the same-origin local editor can use this service." }); return; }
    if (route.startsWith("/oauth/") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.headers.origin).hostname)) {
      json(response, 403, { error: "Account OAuth requires the PC's localhost editor. Export a build code there and import it on this device." }); return;
    }
    if (activeRequests >= 16) { json(response, 429, { error: "Local request limit reached." }); return; }
    activeRequests++;
    try {
      const payload = await readJson(request);
      if (route === "/fetch") {
        try { json(response, 200, await fetchRemote(payload, remoteRequest)); }
        catch { json(response, 200, { body: "", headers: {}, error: "The local bridge could not complete this request. Check the destination and connection." }); }
      } else if (route === "/oauth/start") json(response, 200, await startOAuth(payload));
      else {
        const session = sessions.get(payload.id);
        if (!session) { json(response, 404, { error: "Authorization session not found." }); return; }
        if (route === "/oauth/cancel") session.cancel();
        json(response, 200, { done: session.done, result: session.result });
        if (session.done) { clearTimeout(session.expiry); sessions.delete(payload.id); }
      }
    } catch { json(response, 400, { error: "Invalid local service request." }); }
    finally { activeRequests--; }
  }
  function close() {
    for (const session of sessions.values()) { clearTimeout(session.timer); clearTimeout(session.expiry); session.server.close(); session.server.closeAllConnections(); }
    sessions.clear();
  }
  return { middleware, close };
}
