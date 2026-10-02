export type RealmV1 = "pc" | "xbox" | "sony";
export type CharacterOperationV1 = "get-characters" | "get-items" | "get-passive-skills";
export type CoreRequestV1 = { method: "POST"; path: "/api/poe/characters" | "/api/poe/import-character"; body: { contractVersion: 1; realm: RealmV1; account: string; character?: string } };
export type CoreEnvelopeV1<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export type CharacterTransportV1 = { enabled: boolean; request(request: CoreRequestV1, options: { signal: AbortSignal }): Promise<CoreEnvelopeV1<unknown>> };
export declare const CHARACTER_HOST_V1: Readonly<{ version: 1; maxUrlBytes: number; maxBodyBytes: number; maxResponseBytes: number; timeoutMs: number; maxConcurrency: number }>;
export declare function createDisabledCharacterTransport(): CharacterTransportV1;
export declare function createPobCodesCharacterTransport(options: { origin: string; fetchImpl?: typeof fetch }): CharacterTransportV1;
export declare function createCharacterHostV1(options?: { transport?: CharacterTransportV1; limits?: Partial<typeof CHARACTER_HOST_V1>; now?: () => number }): { onFetch(url: string, headers?: Record<string,string>, body?: string): Promise<{ body: string; status: number | undefined; headers: Record<string,string>; error: string | undefined }>; reset(): void; contract: typeof CHARACTER_HOST_V1 };
