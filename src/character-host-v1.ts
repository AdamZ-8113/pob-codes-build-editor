type CreateCharacterHostV1Options = { transport?: CharacterTransportV1; limits?: Partial<typeof CHARACTER_HOST_V1>; now?: () => number };

type CreatePobCodesCharacterTransportOptions = { origin: string; fetchImpl?: typeof fetch };

export type RealmV1 = "pc" | "xbox" | "sony";
export type CharacterOperationV1 = "get-characters" | "get-items" | "get-passive-skills";
export type CoreRequestV1 = { method: "POST"; path: "/api/poe/characters" | "/api/poe/import-character"; body: { contractVersion: 1; realm: RealmV1; account: string; character?: string } };
export type CoreEnvelopeV1<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export type CharacterTransportV1 = { enabled: boolean; request(request: CoreRequestV1, options: { signal: AbortSignal; maxResponseBytes?: number; timeoutMs?: number }): Promise<CoreEnvelopeV1<unknown>> };

import { fetchBoundedText } from "./bounded-response-v1.ts";

// Transport data remains untrusted; the host checks these fields before use.
type CharacterData = { characters?: unknown; items?: unknown; passiveSkills?: unknown };
type CharacterPair = {
  used: Set<string>;
  created: number;
  promise?: Promise<{ ok: true; data: CharacterData }>;
};
type CharacterFetchResult = { body: string; status: number | undefined; headers: Record<string, string>; error: string | undefined };

const OPERATIONS = new Set(["get-characters", "get-items", "get-passive-skills"]);
const REALMS = new Map<string, RealmV1>([["pc", "pc"], ["xbox", "xbox"], ["sony", "sony"], ["PC", "pc"], ["XBOX", "xbox"], ["SONY", "sony"]]);
const MANUAL_FALLBACK = "Character import is unavailable. Paste a build code or open a build file instead.";
const utf8 = new TextEncoder();

export const CHARACTER_HOST_V1: Readonly<{ version: 1; maxUrlBytes: number; maxBodyBytes: number; maxResponseBytes: number; timeoutMs: number; maxConcurrency: number }> = Object.freeze({ version: 1, maxUrlBytes: 2048, maxBodyBytes: 4096, maxResponseBytes: 16 * 1024 * 1024, timeoutMs: 12_000, maxConcurrency: 2 });

export function createDisabledCharacterTransport(): CharacterTransportV1 {
  return { enabled: false, async request() { throw new Error(MANUAL_FALLBACK); } };
}

export function createPobCodesCharacterTransport(options: CreatePobCodesCharacterTransportOptions): CharacterTransportV1;
export function createPobCodesCharacterTransport({ origin, fetchImpl = fetch }: Partial<CreatePobCodesCharacterTransportOptions> = {}): CharacterTransportV1 {
  const target = new URL(origin!);
  if (target.origin !== "https://pob.codes" || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Character import requires the https://pob.codes origin.");
  }
  return {
    enabled: true,
    async request(request, { signal, maxResponseBytes = CHARACTER_HOST_V1.maxResponseBytes, timeoutMs = CHARACTER_HOST_V1.timeoutMs }) {
      if (!["/api/poe/characters", "/api/poe/import-character"].includes(request.path)) {
        throw new Error("Blocked unsupported PoB Codes character operation.");
      }
      const accountName = request.body.account;
      const body = request.path === "/api/poe/characters"
        ? { accountName, realm: request.body.realm }
        : { accountName, characterName: request.body.character, realm: request.body.realm };
      const { response, text } = await fetchBoundedText(new URL(request.path, target), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        signal,
      }, { fetchImpl, maxBytes: maxResponseBytes, timeoutMs });
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error("PoB Codes returned an invalid character-import response."); }
      if (!response.ok) {
        return { ok: false, error: { code: String(payload?.code ?? `HTTP_${response.status}`), message: String(payload?.error ?? "Character import failed.") } };
      }
      if (request.path === "/api/poe/characters") {
        if (!Array.isArray(payload?.characters)) throw new Error("PoB Codes returned an invalid character list.");
        return { ok: true, data: { characters: payload.characters } };
      }
      try {
        const items = JSON.parse(payload?.itemsJson);
        const passiveSkills = JSON.parse(payload?.passiveSkillsJson);
        if (!items || typeof items !== "object" || !passiveSkills || typeof passiveSkills !== "object") throw new Error();
        return { ok: true, data: { items, passiveSkills } };
      } catch {
        throw new Error("PoB Codes returned invalid character data.");
      }
    },
  };
}

export function createCharacterHostV1({ transport = createDisabledCharacterTransport(), limits = {}, now = () => Date.now() }: CreateCharacterHostV1Options = {}): { onFetch(url: string, headers?: Record<string,string>, body?: string): Promise<{ body: string; status: number | undefined; headers: Record<string,string>; error: string | undefined }>; reset(): void; contract: typeof CHARACTER_HOST_V1 } {
  const policy = { ...CHARACTER_HOST_V1, ...limits };
  let epoch = 0;
  let active = 0;
  let listedAccount: string | undefined;
  const pairs = new Map<string, CharacterPair>();
  const controllers = new Set<AbortController>();
  const reset = () => { epoch++; listedAccount = undefined; pairs.clear(); for (const controller of controllers) controller.abort(new Error("Stale character import was cancelled.")); };

  async function boundedRequest(request: CoreRequestV1, capturedEpoch: number) {
    if (active >= policy.maxConcurrency) throw new Error("Character import is busy; try again.");
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("Character import timed out.")), policy.timeoutMs);
    try {
      const result = await transport.request(request, { signal: controller.signal, maxResponseBytes: policy.maxResponseBytes, timeoutMs: policy.timeoutMs });
      controller.signal.throwIfAborted();
      if (capturedEpoch !== epoch) throw new Error("Stale character import result was discarded.");
      const text = JSON.stringify(result);
      if (utf8.encode(text).byteLength > policy.maxResponseBytes) throw new Error("Character import response exceeded the size limit.");
      return result as CoreEnvelopeV1<CharacterData>;
    } finally { clearTimeout(timer); controllers.delete(controller); active--; }
  }

  async function onFetch(url: string, _headers: Record<string, string> = {}, body?: string): Promise<CharacterFetchResult> {
    try {
      if (utf8.encode(url).byteLength > policy.maxUrlBytes || utf8.encode(body ?? "").byteLength > policy.maxBodyBytes) throw new Error("Character import request exceeded the size limit.");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !["www.pathofexile.com", "pathofexile.com"].includes(parsed.hostname)) throw new Error("Blocked non-Path of Exile request.");
      // PoB asks for a profile link after listing characters. The guarded API
      // already owns account handling; satisfy that callback locally, without
      // exposing a general profile proxy or requesting OAuth credentials.
      const profile = /^\/account\/view-profile\/([^/]+)$/.exec(parsed.pathname);
      if (profile) {
        if (!transport.enabled || !listedAccount || parsed.search || parsed.hash || decodeURIComponent(profile[1]) !== listedAccount) {
          throw new Error("Blocked account profile outside the active character import.");
        }
        return { body: `/view-profile/${encodeURIComponent(listedAccount)}/characters`, status: 200, headers: { "content-type": "text/plain" }, error: undefined };
      }
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
        if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? "Character import failed.");
        if (!Array.isArray(envelope.data?.characters)) throw new Error("Invalid character-list envelope.");
        listedAccount = account;
        return ok(envelope.data.characters);
      }
      const key = `${epoch}\u0000${realm}\u0000${account}\u0000${character}`;
      let pair = pairs.get(key);
      if (pair && now() - pair.created >= policy.timeoutMs) {
        pairs.delete(key);
        pair = undefined;
      }
      if (!pair) {
        const captured = epoch;
        pair = { used: new Set(), created: now() };
        pairs.set(key, pair);
        const pendingPair = pair;
        pair.promise = boundedRequest({ method: "POST", path: "/api/poe/import-character", body: { contractVersion: 1, realm, account, character } }, captured)
          .then(envelope => {
            if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? "Character import failed.");
            if (!envelope.data?.items || typeof envelope.data.items !== "object" || !envelope.data?.passiveSkills || typeof envelope.data.passiveSkills !== "object") throw new Error("Invalid paired-character envelope.");
            return envelope;
          })
          .catch(error => {
            if (pairs.get(key) === pendingPair) pairs.delete(key);
            throw error;
          });
      }
      const envelope = await pair.promise!;
      pair.used.add(operation);
      if (pairs.get(key) === pair && (pair.used.size === 2 || now() - pair.created >= policy.timeoutMs)) pairs.delete(key);
      return ok(operation === "get-items" ? envelope.data.items : envelope.data.passiveSkills);
    } catch (error) {
      return { body: "", status: undefined, headers: {}, error: error instanceof Error ? error.message : MANUAL_FALLBACK };
    }
  }
  return { onFetch, reset, contract: policy };
}

function ok(value: unknown): CharacterFetchResult { return { body: JSON.stringify(value), status: 200, headers: { "content-type": "application/json" }, error: undefined }; }
