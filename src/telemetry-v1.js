export const TELEMETRY_EVENTS_V1 = Object.freeze(["editor_open_v1", "editor_ready_v1", "editor_import_v1", "editor_export_v1", "editor_error_v1"]);
export function createTelemetryV1({ endpoint, hostname = location.hostname, release = "unknown", send = (url, body) => fetch(url, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).catch(() => {}) } = {}) {
  const enabled = Boolean(endpoint) && hostname === "pob.codes";
  return { enabled, emit(name, outcome = "ok") {
    if (!enabled || !TELEMETRY_EVENTS_V1.includes(name) || !["ok", "error", "cancelled"].includes(outcome)) return;
    try { void send(endpoint, JSON.stringify({ contractVersion: 1, name, outcome, release })); } catch { /* fail open */ }
  } };
}
