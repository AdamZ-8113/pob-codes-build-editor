type CreateTelemetryV1Options = { endpoint?: string; hostname?: string; pathname?: string; appVersion?: string; sessionId?: string; deviceClass?: TelemetryDeviceV1; buildPatchVersion?: string; send?: (url: string, body: string) => unknown };

export type TelemetryEventNameV1 = "build_editor_open_v1" | "build_editor_ready_v1" | "build_editor_import_v1" | "build_editor_export_v1" | "build_editor_error_v1";
export type TelemetryDeviceV1 = "desktop" | "mobile" | "tablet" | "touch" | "unknown";
export type TelemetryErrorV1 = "asset-load" | "export" | "import" | "network" | "runtime" | "startup" | "storage" | "timeout" | "unknown" | "unsupported-browser";
export type TelemetryEventV1 = { eventName: TelemetryEventNameV1; sessionId: string; route: "GET /import/" | "GET /import2/"; appVersion: string; result: string; actionTarget?: string; deviceClass?: TelemetryDeviceV1; durationMs?: number; errorCode?: TelemetryErrorV1; buildPatchVersion?: string };

export const TELEMETRY_EVENTS_V1: readonly TelemetryEventNameV1[] = Object.freeze([
  "build_editor_open_v1", "build_editor_ready_v1", "build_editor_import_v1", "build_editor_export_v1", "build_editor_error_v1",
]);
const RESULTS = Object.freeze({
  build_editor_open_v1: new Set(["opened"]), build_editor_ready_v1: new Set(["ready", "unsupported", "error"]),
  build_editor_import_v1: new Set(["started", "success", "error", "cancelled"]), build_editor_export_v1: new Set(["started", "success", "error", "cancelled"]),
  build_editor_error_v1: new Set(["error"]),
});
const TARGETS = Object.freeze({
  build_editor_open_v1: new Set(["direct", "fragment", "saved-build"]), build_editor_ready_v1: new Set(["cold", "warm"]),
  build_editor_import_v1: new Set(["character", "code", "saved-build", "xml"]), build_editor_export_v1: new Set(["code", "xml"]),
  build_editor_error_v1: new Set(["export", "import", "network", "runtime", "startup", "storage", "unsupported"]),
});
const DEVICES = new Set(["desktop", "mobile", "tablet", "touch", "unknown"]);
const ERRORS = new Set(["asset-load", "export", "import", "network", "runtime", "startup", "storage", "timeout", "unknown", "unsupported-browser"]);

export function validateTelemetryEventV1(event: TelemetryEventV1): TelemetryEventV1 {
  if (!TELEMETRY_EVENTS_V1.includes(event?.eventName)) throw new Error("Invalid telemetry eventName");
  if (!/^pobcs_[a-z0-9_-]{16,80}$/i.test(event.sessionId)) throw new Error("Invalid telemetry sessionId");
  if (!["GET /import/", "GET /import2/"].includes(event.route)) throw new Error("Invalid telemetry route");
  if (!/^[a-f0-9]{12,64}$/.test(event.appVersion)) throw new Error("Invalid telemetry appVersion");
  if (!RESULTS[event.eventName].has(event.result)) throw new Error("Invalid telemetry result");
  if (event.actionTarget !== undefined && !TARGETS[event.eventName].has(event.actionTarget)) throw new Error("Invalid telemetry actionTarget");
  if (event.deviceClass !== undefined && !DEVICES.has(event.deviceClass)) throw new Error("Invalid telemetry deviceClass");
  if (event.durationMs !== undefined && (!Number.isInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > 86_400_000)) throw new Error("Invalid telemetry durationMs");
  const requiresError = event.eventName === "build_editor_error_v1" || event.result === "error";
  if (requiresError !== (event.errorCode !== undefined) || (event.errorCode !== undefined && !ERRORS.has(event.errorCode))) throw new Error("Invalid telemetry errorCode");
  if (event.buildPatchVersion !== undefined && !/^[a-z0-9][a-z0-9._-]{0,23}$/.test(event.buildPatchVersion)) throw new Error("Invalid telemetry buildPatchVersion");
  const allowed = new Set(["eventName", "sessionId", "route", "appVersion", "result", "actionTarget", "deviceClass", "durationMs", "errorCode", "buildPatchVersion"]);
  if (Object.keys(event).some(key => !allowed.has(key))) throw new Error("Unknown telemetry field");
  return event;
}

export function createTelemetryV1(options: CreateTelemetryV1Options = {}): { enabled: boolean; sessionId: string; route: string; emit(name: TelemetryEventNameV1, fields: Omit<TelemetryEventV1, "eventName" | "sessionId" | "route" | "appVersion" | "deviceClass" | "buildPatchVersion">): void } {
  const { endpoint, hostname = globalThis.location?.hostname ?? "", pathname = globalThis.location?.pathname ?? "/import/", appVersion, sessionId = randomSessionId(), deviceClass = "unknown", buildPatchVersion, send = (url, body) => fetch(url, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).catch(() => {}) } = options;
  const route = pathname === "/import2" || pathname.startsWith("/import2/") ? "GET /import2/" : "GET /import/";
  const enabled = telemetryEndpointAllowed(endpoint) && hostname === "pob.codes" && /^[a-f0-9]{12,64}$/.test(appVersion ?? "");
  return { enabled, sessionId, route, emit(eventName, fields) {
    if (!enabled) return;
    try {
      const event = validateTelemetryEventV1({ eventName, sessionId, route, appVersion: appVersion!, deviceClass, ...(buildPatchVersion ? { buildPatchVersion } : {}), ...fields });
      void send(endpoint!, JSON.stringify(event));
    } catch { /* telemetry is always fail-open */ }
  } };
}

function telemetryEndpointAllowed(endpoint: string | undefined): endpoint is "https://api.pob.codes/analytics/events" {
  return endpoint === "https://api.pob.codes/analytics/events";
}

function randomSessionId() {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return `pobcs_${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}
