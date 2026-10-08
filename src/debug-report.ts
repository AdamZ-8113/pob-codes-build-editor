import type { DriverDiagnostic } from "../upstream/packages/driver/src/js/diagnostic.ts";

type JsonRecord = Record<string, unknown>;

export type SanitizedDiagnosticV1 = {
  atMs: number;
  phase: DriverDiagnostic["phase"];
  event: string;
  level: "info" | "error";
  data?: Record<string, string | number | boolean | number[]>;
};

export type DebugReportInputV1 = {
  generatedAt: string;
  uptimeMs: number;
  productName: string;
  appVersion: string;
  mode: "browser-preview" | "local-development";
  ready: boolean;
  errorCount: number;
  browser: { name: string; major: string; platform: string };
  capabilities: {
    hardwareConcurrency?: number;
    deviceMemoryGiB?: number;
    crossOriginIsolated: boolean;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
    jsHeapBytes?: number;
    storageUsageBytes?: number;
    storageQuotaBytes?: number;
  };
  configuration: {
    calculationScheduling: "scheduled" | "synchronous";
    renderReuse: boolean;
    payloadPrefetch: boolean;
  };
  runtimeProfile: unknown;
  renderStats: unknown;
  frames: { at: number; duration: number; render: number; reused: boolean }[];
  diagnostics: SanitizedDiagnosticV1[];
};

const DIAGNOSTIC_DATA_KEYS = new Set([
  "pending",
  "kind",
  "count",
  "reason",
  "operation",
  "errorName",
  "build",
  "contextLost",
  "width",
  "height",
  "renderingWidth",
  "renderingHeight",
  "pixelRatio",
  "duration",
  "frameCount",
  "instances",
  "instanceBytes",
  "dispatches",
  "helperMaximumBytes",
  "uiMaximumBytes",
  "helperBytes",
]);

export function sanitizeDiagnosticV1(
  diagnostic: DriverDiagnostic,
  atMs: number,
): SanitizedDiagnosticV1 {
  const data: SanitizedDiagnosticV1["data"] = {};
  for (const [key, value] of Object.entries(diagnostic.data ?? {})) {
    if (!DIAGNOSTIC_DATA_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
    else if (typeof value === "boolean") data[key] = value;
    else if (typeof value === "string" && /^[a-z0-9 ._-]{1,64}$/i.test(value)) {
      data[key] = value;
    } else if (key === "helperBytes" && Array.isArray(value)) {
      data[key] = value.filter((entry): entry is number =>
        typeof entry === "number" && Number.isFinite(entry)
      ).slice(0, 3);
    }
  }
  return {
    atMs: Math.max(0, Math.round(atMs)),
    phase: diagnostic.phase,
    event: /^[a-z0-9-]{1,64}$/i.test(diagnostic.event)
      ? diagnostic.event
      : "unknown",
    level: diagnostic.level === "error" ? "error" : "info",
    ...(Object.keys(data).length ? { data } : {}),
  };
}

export function createDebugReportV1(input: DebugReportInputV1) {
  const profile = asRecord(input.runtimeProfile);
  const samples = asRecord(profile.samples);
  const helpers = asRecord(profile.helpers);
  const helperMemory = asRecord(helpers.memory);
  const filesystem = asRecord(profile.filesystem);
  const payload = asRecord(filesystem.payload);
  const render = asRecord(input.renderStats);
  const backend = asRecord(render.backend);
  const glyphAtlas = asRecord(render.glyphAtlas);
  const frames = input.frames.slice(-120).filter((frame) =>
    [frame.at, frame.duration, frame.render].every((value) =>
      Number.isFinite(value)
    )
  );

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    app: {
      productName: input.productName,
      version: input.appVersion || "development",
      mode: input.mode,
      ready: input.ready,
      uptimeMs: rounded(input.uptimeMs),
      errorCount: Math.max(0, Math.floor(input.errorCount)),
    },
    environment: {
      browser: {
        name: safeToken(input.browser.name),
        major: safeToken(input.browser.major),
      },
      platform: safeToken(input.browser.platform),
      capabilities: finiteValues(input.capabilities),
    },
    configuration: input.configuration,
    memory: {
      wasmBytes: finite(profile.wasmBytes),
      luaKiB: finite(samples.luaKiB),
      observedWasmCapacityCount: Array.isArray(profile.observedMemoryCapacities)
        ? profile.observedMemoryCapacities.length
        : 0,
      peakObservedWasmBytes: peakCapacity(profile.observedMemoryCapacities),
    },
    runtime: {
      startupPhasesMs: finiteNumberRecord(profile.startupPhases),
      calculations: {
        summary: calculationSummary(samples.summary),
        scheduler: finiteBooleanRecord(samples.scheduler),
        heatmapPending: boolean(samples.heatmapPending),
      },
      helpers: {
        requested: finite(helpers.requested),
        ready: finite(helpers.ready),
        state: safeToken(helpers.state),
        armed: boolean(helpers.armed),
        booting: boolean(helpers.booting),
        starts: finite(helpers.starts),
        startupMs: finite(helpers.startupMs),
        bytes: finiteNumberArray(helpers.bytes, 3),
        lastRetiredBytes: finiteNumberArray(helpers.lastRetiredBytes, 3),
        completed: finite(helpers.completed),
        recycled: finite(helpers.recycled),
        gcPause: finite(helpers.gcPause),
        recentErrorKinds: helperErrorKinds(helpers.errors),
        memoryLimits: {
          hardBytes: finite(helperMemory.hardBytes),
          admissionBytes: finite(helperMemory.admissionBytes),
          uiMaximumBytes: finite(helperMemory.uiMaximum),
          helperMaximumBytes: finite(helperMemory.helperMaximum),
          maximumCount: finite(helperMemory.maximumCount),
        },
      },
      filesystem: {
        operations: finiteNumberRecord(filesystem.operations),
        writes: finiteNumberRecord(filesystem.writes),
        payload: {
          loadedPackageCount: Array.isArray(payload.loadedPackages)
            ? payload.loadedPackages.length
            : 0,
          packagesBeforeReady: finite(payload.packagesBeforeReady),
          bytesBeforeReady: finite(payload.bytesBeforeReady),
          packageOpenCount: Array.isArray(payload.packageOpens)
            ? payload.packageOpens.length
            : 0,
        },
      },
      images: finiteNumberRecord(profile.images),
      bridgeCalls: finiteNumberRecord(profile.bridge),
      draw: finiteNumberRecord(profile.draw),
    },
    rendering: {
      backend: safeToken(backend.name),
      frameCount: finite(render.frameCount),
      totalLayers: finite(render.totalLayers),
      lastFrameMs: finite(render.lastFrameTime),
      layerIndexMs: finite(render.layerIndexTime),
      compileSubmitMs: finite(render.compileSubmitTime),
      instances: finite(backend.instances),
      instanceBytes: finite(backend.instanceBytes),
      dispatches: finite(backend.dispatches),
      glyphs: finite(glyphAtlas.glyphQuads),
      atlasPages: finite(glyphAtlas.pages),
      recentFrames: frameSummary(frames),
    },
    diagnostics: input.diagnostics.slice(-100),
    privacy: {
      excluded: [
        "build codes and XML",
        "account and character names",
        "clipboard and saved-file contents",
        "URLs, query strings, and fragments",
        "filesystem paths and filenames",
        "raw exception messages",
        "full user agent and GPU identifiers",
      ],
    },
  };
}

function frameSummary(frames: DebugReportInputV1["frames"]) {
  const duration = frames.map((frame) => frame.duration);
  const render = frames.map((frame) => frame.render);
  return {
    count: frames.length,
    windowMs: frames.length > 1 ? rounded(frames.at(-1)!.at - frames[0].at) : 0,
    averageWorkerMs: average(duration),
    maximumWorkerMs: maximum(duration),
    averageRenderMs: average(render),
    maximumRenderMs: maximum(render),
    reusedFrames: frames.filter((frame) => frame.reused).length,
  };
}

function calculationSummary(value: unknown) {
  const source = asRecord(value);
  return Object.fromEntries(["MAIN", "CALCS", "heatmap"].map((name) => {
    const entry = asRecord(source[name]);
    return [name, {
      count: finite(entry.count),
      totalMs: finite(entry.totalMs),
      maxMs: finite(entry.maxMs),
    }];
  }));
}

function helperErrorKinds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((entry) => {
      const text = typeof entry === "string" ? entry.toLowerCase() : "";
      if (
        text.includes("memory") || text.includes("reserve")
      ) return "memory-reserve";
      if (text.includes("timeout")) return "timeout";
      if (text.includes("invalid")) return "invalid-result";
      if (text.includes("boot") || text.includes("start")) return "startup";
      if (
        text.includes("stopped") || text.includes("crash")
      ) return "worker-stopped";
      return "other";
    })),
  ].slice(0, 5);
}

function peakCapacity(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  return maximum(value.map((entry) => finite(asRecord(entry).bytes) ?? 0));
}

function finiteValues(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) =>
      typeof entry === "boolean" ||
      typeof entry === "number" && Number.isFinite(entry)
    ),
  );
}

function finiteBooleanRecord(value: unknown): JsonRecord {
  const source = asRecord(value);
  return Object.fromEntries(
    Object.entries(source).filter(([, entry]) =>
      typeof entry === "boolean" ||
      typeof entry === "number" && Number.isFinite(entry)
    ),
  );
}

function finiteNumberRecord(value: unknown): Record<string, number> {
  const source = asRecord(value);
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1])
    ),
  );
}

function finiteNumberArray(value: unknown, limit: number): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number =>
      typeof entry === "number" && Number.isFinite(entry)
    ).slice(0, limit)
    : [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function safeToken(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9 ._+()-]{1,64}$/i.test(value)
    ? value
    : "unknown";
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number {
  return values.length
    ? rounded(values.reduce((total, value) => total + value, 0) / values.length)
    : 0;
}

function maximum(values: number[]): number {
  return values.length ? rounded(Math.max(...values)) : 0;
}
