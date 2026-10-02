const MAX_CODE_BYTES = 8 * 1024 * 1024;
const utf8 = new TextEncoder();

export function createBuildTransferV1({ apiBaseUrl, fetchImpl = fetch, getBuildCode, timeoutMs = 12_000 } = {}) {
  const api = apiOrigin(apiBaseUrl);
  let pendingShare;
  let sharing = false;

  async function resolve(input) {
    if (typeof input !== "string" || !input || utf8.encode(input).byteLength > MAX_CODE_BYTES) throw new Error("Invalid build input.");
    if (!/^https?:\/\//i.test(input)) return validateCode(input);
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname !== "pob.codes" || url.search || url.hash) throw new Error("Only owned pob.codes build links are supported.");
    const match = /^\/b\/([A-Za-z0-9_-]{6,128})\/?$/.exec(url.pathname);
    if (!match) throw new Error("Unsupported build link.");
    if (!api) throw new Error("Saved-build resolution is not configured. Paste the build code instead.");
    const response = await boundedFetch(`https://api.pob.codes/${encodeURIComponent(match[1])}/raw`, { method: "GET", headers: { accept: "text/plain" } });
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
      const response = await boundedFetch(`${api}/pob`, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8", accept: "application/json" }, body: pendingShare });
      const envelope = await response.json();
      if (response.status !== 201 || !response.ok || typeof envelope?.id !== "string" || typeof envelope?.shortUrl !== "string" || response.headers.get("cache-control")?.toLowerCase() !== "no-store") throw new Error("Build sharing failed; retry keeps the exported snapshot.");
      const url = new URL(envelope.shortUrl, "https://pob.codes");
      if (url.origin !== "https://pob.codes" || !/^\/b\/[A-Za-z0-9_-]{6,128}$/.test(url.pathname) || url.search || url.hash) throw new Error("Build sharing returned an invalid link.");
      pendingShare = undefined;
      return `https://pob.codes${url.pathname}`;
    } finally { sharing = false; }
  }

  async function boundedFetch(url, init) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...init, signal: controller.signal, credentials: "omit", redirect: "error" }); }
    finally { clearTimeout(timer); }
  }
  return { resolve, share, retry, get hasPendingShare() { return Boolean(pendingShare); }, get sharing() { return sharing; } };
}

function apiOrigin(value) {
  if (!value) return "";
  const url = new URL(value);
  const worker = url.hostname === "api.pob.codes" && url.pathname === "/";
  const site = url.hostname === "pob.codes" && ["/api", "/api/"].includes(url.pathname);
  if (url.protocol !== "https:" || (!worker && !site) || url.search || url.hash) throw new Error("PUBLIC_API_BASE_URL must be an owned API base.");
  return site ? `${url.origin}/api` : url.origin;
}
function validateCode(code) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(code) || utf8.encode(code).byteLength > MAX_CODE_BYTES) throw new Error("Invalid Path of Building code.");
  return code;
}
