const MAX_CODE_BYTES = 8 * 1024 * 1024;
const MAX_LINK_BYTES = 4096;
const utf8 = new TextEncoder();
const BUILD_ID = /^[A-Za-z0-9_-]{5,90}$/;
const IMPORT_HOSTS = new Set(["maxroll.gg", "planners.maxroll.gg", "pobb.in", "pob.codes", "poe.ninja", "pastebin.com", "poedb.tw"]);
const APP_HEADERS = Object.freeze({ "content-type": "text/plain; charset=utf-8", "x-pobcodes-client": "web" });

export function createBuildTransferV1({ apiBaseUrl, fetchImpl = fetch, getBuildCode, timeoutMs = 12_000 } = {}) {
  const api = apiOrigin(apiBaseUrl);
  let pendingShare;
  let sharing = false;

  async function resolve(input) {
    if (typeof input !== "string" || !input) throw new Error("Invalid build input.");
    const trimmed = input.trim();
    if (!looksLikeBuildLink(trimmed)) return validateCode(trimmed);
    if (utf8.encode(trimmed).byteLength > MAX_LINK_BYTES) throw new Error("Build link is too long.");
    if (!api) throw new Error("Build-link resolution is not configured. Paste the build code instead.");

    const ownedId = ownedBuildId(trimmed);
    if (ownedId) return fetchRawBuild(ownedId);

    const response = await boundedFetch(`${api}/pob`, {
      method: "POST",
      headers: { ...APP_HEADERS, accept: "application/json" },
      body: trimmed,
    });
    const envelope = await response.json().catch(() => undefined);
    if (response.status !== 201 || !response.ok || typeof envelope?.id !== "string" || !BUILD_ID.test(envelope.id)) {
      throw new Error(typeof envelope?.error === "string" ? envelope.error : "Build link could not be resolved.");
    }
    return fetchRawBuild(envelope.id);
  }

  async function fetchRawBuild(id) {
    const response = await boundedFetch(`${api}/${encodeURIComponent(id)}/raw`, { method: "GET", headers: { accept: "text/plain" } });
    if (response.status === 404) throw new Error("Saved build was not found.");
    if (!response.ok) throw new Error("Saved build could not be resolved.");
    return validateCode(await response.text());
  }

  async function share() {
    if (sharing) throw new Error("A share request is already running.");
    if (!api) throw new Error("Sharing is not configured.");
    pendingShare = validateCode(await getBuildCode());
    return sendPending();
  }

  async function retry() {
    if (!pendingShare) throw new Error("There is no failed share to retry.");
    return sendPending();
  }

  async function sendPending() {
    if (sharing) throw new Error("A share request is already running.");
    sharing = true;
    try {
      const id = await uploadPlain(pendingShare);
      pendingShare = undefined;
      return `https://pob.codes/b/${id}`;
    } finally { sharing = false; }
  }

  async function uploadPlain(code) {
    const response = await boundedFetch(`${api}/pob/plain`, {
      method: "POST",
      headers: { ...APP_HEADERS, accept: "text/plain" },
      body: validateCode(code),
    });
    const id = (await response.text()).trim();
    if (!response.ok || response.status !== 200 || !BUILD_ID.test(id) || response.headers.get("cache-control")?.toLowerCase() !== "no-store") {
      throw new Error("Build sharing failed; retry keeps the exported snapshot.");
    }
    return id;
  }

  async function onFetch(url, _headers = {}, body) {
    let parsed;
    try { parsed = new URL(url); }
    catch { return undefined; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return undefined;
    try {
      if (body !== undefined && parsed.origin === api && parsed.pathname === "/pob/plain" && !parsed.search) {
        return fetchResult(await uploadPlain(body));
      }
      const rawMatch = /^\/([A-Za-z0-9_-]{5,90})\/raw$/.exec(parsed.pathname);
      if (body === undefined && parsed.origin === api && rawMatch && !parsed.search && BUILD_ID.test(rawMatch[1])) {
        return fetchResult(await fetchRawBuild(rawMatch[1]));
      }
      if (body === undefined && isSupportedImportUrl(parsed)) {
        return fetchResult(await resolve(parsed.href));
      }
      return undefined;
    } catch (error) {
      return { body: "", status: undefined, headers: {}, error: error instanceof Error ? error.message : "Build transfer failed." };
    }
  }

  async function boundedFetch(url, init) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...init, signal: controller.signal, credentials: "omit", redirect: "error" }); }
    finally { clearTimeout(timer); }
  }
  return { resolve, share, retry, onFetch, get hasPendingShare() { return Boolean(pendingShare); }, get sharing() { return sharing; } };
}

function apiOrigin(value) {
  if (!value) return "";
  const url = new URL(value);
  const worker = url.hostname === "api.pob.codes" && url.pathname === "/";
  if (url.protocol !== "https:" || !worker || url.search || url.hash) throw new Error("PUBLIC_API_BASE_URL must be https://api.pob.codes.");
  return url.origin;
}
function validateCode(code) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(code) || utf8.encode(code).byteLength > MAX_CODE_BYTES) throw new Error("Invalid Path of Building code.");
  return code;
}

function looksLikeBuildLink(value) {
  return /^(?:https?:\/\/|pob:\/\/|www\.)/i.test(value) || [...IMPORT_HOSTS].some(host => value.toLowerCase().startsWith(host));
}

function ownedBuildId(value) {
  let url;
  try { url = new URL(value); }
  catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname !== "pob.codes" || url.search || url.hash || url.username || url.password) return undefined;
  const match = /^\/b\/([A-Za-z0-9_-]{5,90})\/?$/.exec(url.pathname);
  return match && BUILD_ID.test(match[1]) ? match[1] : undefined;
}

function isSupportedImportUrl(url) {
  return IMPORT_HOSTS.has(url.hostname.replace(/^www\./i, ""));
}

function fetchResult(body) {
  return { body, status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, error: undefined };
}
