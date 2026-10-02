export type TelemetryEventNameV1 = "build_editor_open_v1" | "build_editor_ready_v1" | "build_editor_import_v1" | "build_editor_export_v1" | "build_editor_error_v1";
export type TelemetryDeviceV1 = "desktop" | "mobile" | "tablet" | "touch" | "unknown";
export type TelemetryErrorV1 = "asset-load" | "export" | "import" | "network" | "runtime" | "startup" | "storage" | "timeout" | "unknown" | "unsupported-browser";
export type TelemetryEventV1 = { eventName: TelemetryEventNameV1; sessionId: string; route: "GET /import/" | "GET /import2/"; appVersion: string; result: string; actionTarget?: string; deviceClass?: TelemetryDeviceV1; durationMs?: number; errorCode?: TelemetryErrorV1; buildPatchVersion?: string };
export declare const TELEMETRY_EVENTS_V1: readonly TelemetryEventNameV1[];
export declare function validateTelemetryEventV1(event: TelemetryEventV1): TelemetryEventV1;
export declare function createTelemetryV1(options?: { endpoint?: string; hostname?: string; pathname?: string; appVersion?: string; sessionId?: string; deviceClass?: TelemetryDeviceV1; buildPatchVersion?: string; send?: (url: string, body: string) => unknown }): { enabled: boolean; sessionId: string; route: string; emit(name: TelemetryEventNameV1, fields: Omit<TelemetryEventV1, "eventName" | "sessionId" | "route" | "appVersion" | "deviceClass" | "buildPatchVersion">): void };
