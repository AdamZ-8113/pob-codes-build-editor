const OPERATIONS = new Set(["get-characters", "get-items", "get-passive-skills"]);
const REALMS = new Map([["pc", "pc"], ["xbox", "xbox"], ["sony", "sony"], ["PC", "pc"], ["XBOX", "xbox"], ["SONY", "sony"]]);
const MANUAL_FALLBACK = "Character import is unavailable. Paste a build code or open a build file instead.";
const utf8 = new TextEncoder();

export const CHARACTER_HOST_V1 = Object.freeze({ version: 1, maxUrlBytes: 2048, maxBodyBytes: 4096, maxResponseBytes: 16 * 1024 * 1024, timeoutMs: 12_000, maxConcurrency: 2 });

export function createDisabledCharacterTransport() {
  return { enabled: false, async request() { throw new Error(`${MANUAL_FALLBACK} Production account transport is disabled pending an approved GGG policy contract.`); } };
}

export function createCharacterHostV1({ transport = createDisabledCharacterTransport(), limits = {}, now = () => Date.now() } = {}) {
  const policy = { ...CHARACTER_HOST_V1, ...limits };
  let epoch = 0;
  let active = 0;
  const pairs = new Map();
  const controllers = new Set();
  const reset = () => { epoch++; pairs.clear(); for (const controller of controllers) controller.abort(new Error("Stale character import was cancelled.")); };

  async function boundedRequest(request, capturedEpoch) {
    if (active >= policy.maxConcurrency) throw new Error("Character import is busy; try again.");
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("Character import timed out.")), policy.timeoutMs);
    try {
      const result = await transport.request(request, { signal: controller.signal });
      if (capturedEpoch !== epoch) throw new Error("Stale character import result was discarded.");
      const text = JSON.stringify(result);
      if (utf8.encode(text).byteLength > policy.maxResponseBytes) throw new Error("Character import response exceeded the size limit.");
      return result;
    } finally { clearTimeout(timer); controllers.delete(controller); active--; }
  }

  async function onFetch(url, _headers = {}, body) {
    try {
      if (utf8.encode(url).byteLength > policy.maxUrlBytes || utf8.encode(body ?? "").byteLength > policy.maxBodyBytes) throw new Error("Character import request exceeded the size limit.");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !["www.pathofexile.com", "pathofexile.com"].includes(parsed.hostname)) throw new Error("Blocked non-Path of Exile request.");
      const match = /^\/character-window\/(get-characters|get-items|get-passive-skills)$/.exec(parsed.pathname);
      if (!match || !OPERATIONS.has(match[1])) throw new Error("Blocked unsupported Path of Exile operation.");
      const operation = match[1];
      const account = parsed.searchParams.get("accountName") ?? parsed.searchParams.get("account") ?? "";
      const character = parsed.searchParams.get("character") ?? "";
      const realm = REALMS.get(parsed.searchParams.get("realm") ?? "pc");
      if (!realm || !/^[^\u0000-\u001f<>]{1,64}$/.test(account) || (operation !== "get-characters" && !/^[^\u0000-\u001f<>]{1,64}$/.test(character))) throw new Error("Invalid character import input.");
      if (!transport.enabled) throw new Error(MANUAL_FALLBACK);
      if (operation === "get-characters") {
        reset();
        const captured = epoch;
        const envelope = await boundedRequest({ method: "POST", path: "/api/poe/characters", body: { contractVersion: 1, realm, account } }, captured);
        if (envelope?.ok !== true || !Array.isArray(envelope.data?.characters)) throw new Error("Invalid character-list envelope.");
        return ok(envelope.data.characters);
      }
      const key = `${epoch}\u0000${realm}\u0000${account}\u0000${character}`;
      let pair = pairs.get(key);
      if (!pair) {
        const captured = epoch;
        pair = { used: new Set(), created: now(), promise: boundedRequest({ method: "POST", path: "/api/poe/import-character", body: { contractVersion: 1, realm, account, character } }, captured) };
        pairs.set(key, pair);
      }
      const envelope = await pair.promise;
      if (envelope?.ok !== true || typeof envelope.data?.items !== "object" || typeof envelope.data?.passiveSkills !== "object") throw new Error("Invalid paired-character envelope.");
      pair.used.add(operation);
      if (pair.used.size === 2 || now() - pair.created > policy.timeoutMs) pairs.delete(key);
      return ok(operation === "get-items" ? envelope.data.items : envelope.data.passiveSkills);
    } catch (error) {
      return { body: "", status: undefined, headers: {}, error: error instanceof Error ? error.message : MANUAL_FALLBACK };
    }
  }
  return { onFetch, reset, contract: policy };
}

function ok(value) { return { body: JSON.stringify(value), status: 200, headers: { "content-type": "application/json" }, error: undefined }; }
