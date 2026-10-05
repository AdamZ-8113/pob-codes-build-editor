export type ConfigurationOwnerV1 = "automatic" | "manual";
export type ConfigurationWriteV1 = { key: string; owner: ConfigurationOwnerV1; operation: "clear" } | { key: string; owner: ConfigurationOwnerV1; operation: "set"; value: boolean | number | string };
export type ConfigurationRequestV1 = { version: 1; writes: ConfigurationWriteV1[] };
export type NativeConfigurationBridgeV1 = { getBuildCode(): Promise<string>; loadBuildFromCode(code: string): Promise<unknown>; applyConfiguration(request: { version: 1; expectedGeneration: number; writes: Array<{ key: string; operation: "clear" | "set"; value?: boolean | number | string }> }): Promise<{ ok: boolean; error?: string }> };

export const CONFIGURATION_V1: Readonly<{ version: 1; maxWrites: number; maxKeyLength: number; maxStringLength: number; maxSnapshotBytes: number; maxUndo: number }> = Object.freeze({ version: 1, maxWrites: 64, maxKeyLength: 64, maxStringLength: 4096, maxSnapshotBytes: 8 * 1024 * 1024, maxUndo: 20 });

export function createConfigurationBridgeV1(native: NativeConfigurationBridgeV1, limits: Partial<typeof CONFIGURATION_V1> = {}): { apply(request: ConfigurationRequestV1): Promise<{ ok: true; generation: number; applied: string[]; skipped: string[] }>; undo(): Promise<boolean>; readonly generation: number; ownership(key: string): ConfigurationOwnerV1 | undefined; readonly busy: boolean } {
  const policy = { ...CONFIGURATION_V1, ...limits };
  let busy = false;
  let generation = 0;
  const ownership = new Map<string, ConfigurationOwnerV1>();
  const undo: Array<{ snapshot: string; ownership: Map<string, ConfigurationOwnerV1> }> = [];

  async function apply(request: ConfigurationRequestV1): Promise<{ ok: true; generation: number; applied: string[]; skipped: string[] }> {
    if (busy) throw new Error("A configuration transaction is already running.");
    if (request?.version !== 1 || !Array.isArray(request.writes) || request.writes.length < 1 || request.writes.length > policy.maxWrites) throw new Error("Invalid configuration transaction.");
    const writes = request.writes.map(validateWrite);
    const accepted = writes.filter(write => !(write.owner === "automatic" && ownership.get(write.key) === "manual"));
    const skipped = writes.filter(write => !accepted.includes(write)).map(write => write.key);
    if (!accepted.length) return { ok: true, generation, applied: [], skipped };
    busy = true;
    try {
      const previousOwnership = new Map(ownership);
      const snapshot = await native.getBuildCode();
      if (new TextEncoder().encode(snapshot).byteLength > policy.maxSnapshotBytes) throw new Error("Build snapshot exceeds the transaction limit.");
      try {
        const result = await native.applyConfiguration({ version: 1, expectedGeneration: generation, writes: accepted.map(({ key, operation, value }) => ({ key, operation, ...(operation === "set" ? { value } : {}) })) });
        if (!result?.ok) throw new Error(result?.error ?? "Native configuration transaction failed.");
      } catch (error) {
        await native.loadBuildFromCode(snapshot);
        throw error;
      }
      for (const write of accepted) ownership.set(write.key, write.owner);
      undo.push({ snapshot, ownership: previousOwnership });
      if (undo.length > policy.maxUndo) undo.shift();
      generation++;
      return { ok: true, generation, applied: accepted.map(write => write.key), skipped };
    } finally { busy = false; }
  }

  async function undoLast() {
    if (busy) throw new Error("A configuration transaction is already running.");
    const state = undo.at(-1);
    if (!state) return false;
    busy = true;
    try {
      await native.loadBuildFromCode(state.snapshot);
      undo.pop();
      ownership.clear();
      for (const [key, owner] of state.ownership) ownership.set(key, owner);
      generation++;
      return true;
    }
    finally { busy = false; }
  }

  function validateWrite(write: ConfigurationWriteV1) {
    if (!write || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(write.key) || write.key.length > policy.maxKeyLength) throw new Error("Invalid configuration key.");
    if (!["automatic", "manual"].includes(write.owner) || !["set", "clear"].includes(write.operation)) throw new Error("Invalid configuration ownership or operation.");
    if (write.operation === "set") {
      if (!["boolean", "number", "string"].includes(typeof write.value) || (typeof write.value === "number" && !Number.isFinite(write.value)) || (typeof write.value === "string" && write.value.length > policy.maxStringLength)) throw new Error("Invalid configuration value.");
    } else if ("value" in write) throw new Error("Clear operations cannot include a value.");
    return { key: write.key, owner: write.owner, operation: write.operation, ...(write.operation === "set" ? { value: write.value } : {}) };
  }
  return { apply, undo: undoLast, get generation() { return generation; }, ownership: key => ownership.get(key), get busy() { return busy; } };
}
