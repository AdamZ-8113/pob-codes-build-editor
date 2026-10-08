import { Driver } from "../upstream/packages/driver/src/js/driver.ts";
import { assertDriverCapabilities } from "../upstream/packages/driver/src/js/capability.ts";
import type { PayloadProgress } from "../upstream/packages/driver/src/js/payload.ts";
import "./style.css";
import { createCharacterHostV1, createDisabledCharacterTransport, createPobCodesCharacterTransport } from "./character-host-v1.ts";
import type { CharacterTransportV1 } from "./character-host-v1.ts";
import { createTelemetryV1 } from "./telemetry-v1.ts";
import { createConfigurationBridgeV1 } from "./configuration-v1.ts";
import type { ConfigurationRequestV1 } from "./configuration-v1.ts";
import { createBuildTransferV1 } from "./build-transfer-v1.ts";
import { bindAboutDialog } from "./about-dialog.ts";
import { createDebugReportV1, sanitizeDiagnosticV1 } from "./debug-report.ts";
import type { SanitizedDiagnosticV1 } from "./debug-report.ts";
import { runtimeStatusNotice } from "./runtime-status.ts";
import type { RuntimeStatusNotice } from "./runtime-status.ts";
declare const __IMPORT2_PREVIEW__: boolean;
declare const __IMPORT2_PAYLOAD_PREFIX__: string;
declare const __DESKTOP_DEV_LAN_HOSTS__: string[];
declare const __PUBLIC_PRODUCT_NAME__: string;
declare const __PUBLIC_REPOSITORY_URL__: string;
declare const __PUBLIC_SITE_ORIGIN__: string;
declare const __PUBLIC_API_BASE_URL__: string;
declare const __PUBLIC_TELEMETRY_ENDPOINT__: string;

const import2Preview = __IMPORT2_PREVIEW__;
const publicRuntime = Object.freeze({
  productName: __PUBLIC_PRODUCT_NAME__, repositoryUrl: __PUBLIC_REPOSITORY_URL__,
  siteOrigin: __PUBLIC_SITE_ORIGIN__, apiBaseUrl: __PUBLIC_API_BASE_URL__, telemetryEndpoint: __PUBLIC_TELEMETRY_ENDPOINT__,
});
const performancePrefix = "pob-import2";
const startupAt = performance.now();
const appVersion = __IMPORT2_PAYLOAD_PREFIX__.match(/[a-f0-9]{12,64}/)?.[0] ?? "";
const telemetry = createTelemetryV1({ endpoint: publicRuntime.telemetryEndpoint, appVersion });
telemetry.emit("build_editor_open_v1", { result: "opened", actionTarget: location.hash.includes("build=") ? "saved-build" : location.hash.includes("code=") ? "fragment" : "direct" });
if (import2Preview) performance.mark(`${performancePrefix}-shell-start`);

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Bind before startup so the legal notices stay reachable if PoB fails to start.
bindAboutDialog({ trigger: element<HTMLButtonElement>("about-legal"), dialog: element<HTMLDialogElement>("about-dialog") });
const status = element<HTMLOutputElement>("status");
const calculationStatus = element<HTMLOutputElement>("calculation-status");
const payloadProgress = createPayloadProgressOverlay();
let driver: Driver | undefined;
let configuration: ReturnType<typeof createConfigurationBridgeV1> | undefined;
let buildTransfer: ReturnType<typeof createBuildTransferV1> | undefined;
let ready = false;
let frames = 0;
let lastStats: unknown;
const frameSamples: { at: number; duration: number; render: number; reused: boolean }[] = [];
const errors: string[] = [];
const diagnostics: SanitizedDiagnosticV1[] = [];
let getDebugReport: (() => Promise<ReturnType<typeof createDebugReportV1>>) | undefined;
let statusTimer: number | undefined;
let statusRevision = 0;

function setHeaderStatus(message: string, tone: RuntimeStatusNotice["tone"] = "info", durationMs = 0) {
  const revision = ++statusRevision;
  clearTimeout(statusTimer);
  statusTimer = undefined;
  status.textContent = message;
  status.title = message;
  status.classList.toggle("status-warning", tone === "warning");
  status.classList.toggle("status-error", tone === "error");
  if (message && durationMs > 0) {
    statusTimer = setTimeout(() => {
      if (revision === statusRevision) setHeaderStatus("");
    }, durationMs);
  }
}

function report(error: unknown) {
  telemetry.emit("build_editor_error_v1", { result: "error", actionTarget: "runtime", errorCode: "runtime" });
  calculationStatus.hidden = true;
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  setHeaderStatus(message, "error");
  payloadProgress.error(message);
  console.error(error);
}

async function loadBuildFromCode(value: string, actionTarget: "code" | "saved-build" = "code") {
  const started = performance.now();
  telemetry.emit("build_editor_import_v1", { result: "started", actionTarget });
  try {
    await driver!.loadBuildFromCode(value);
    telemetry.emit("build_editor_import_v1", { result: "success", actionTarget, durationMs: Math.round(performance.now() - started) });
    if (import2Preview) performance.mark(`${performancePrefix}-imported-build-ready`);
  } catch (error) {
    telemetry.emit("build_editor_import_v1", { result: "error", actionTarget, errorCode: "import", durationMs: Math.round(performance.now() - started) });
    throw error;
  }
}

async function exportBuildCode() {
  const started = performance.now(); telemetry.emit("build_editor_export_v1", { result: "started", actionTarget: "code" });
  try { const code = await driver!.getBuildCode(); telemetry.emit("build_editor_export_v1", { result: "success", actionTarget: "code", durationMs: Math.round(performance.now() - started) }); return code; }
  catch (error) { telemetry.emit("build_editor_export_v1", { result: "error", actionTarget: "code", errorCode: "export", durationMs: Math.round(performance.now() - started) }); throw error; }
}

async function authorize(url: string, timeoutMs: number) {
  void timeoutMs;
  return { error: "OAuth is disabled in the public build editor. Use public account import, a build code, or a build file.", state: new URL(url).searchParams.get("state") ?? "", port: 0 };
}

async function main() {
  document.title = `${publicRuntime.productName} · ${import2Preview ? "browser" : "localhost"}`;
  const lanDevelopment = import.meta.env.DEV && location.protocol === "https:" && __DESKTOP_DEV_LAN_HOSTS__.includes(location.hostname);
  if (!import2Preview && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && !lanDevelopment) throw new Error("Use localhost or the HTTPS LAN address printed by dev:restart.");
  assertDriverCapabilities();
  if (!new OffscreenCanvas(1, 1).getContext("webgl2")) throw new Error("Path of Building requires WebGL2 graphics support.");
  let hasDrawn = false;
  payloadProgress.startup(0, "Downloading core data");
  const options = new URLSearchParams(location.search);
  const payloadPrefetchEnabled = import2Preview
    ? options.get("payloadPrefetch") === "1"
    : options.get("payloadPrefetch") !== "0";
  const contributorMock = import.meta.env.DEV && options.get("characterMock") === "1";
  const characterTransport: CharacterTransportV1 = contributorMock ? {
    enabled: true,
    async request(request: { path: string }) {
      return request.path === "/api/poe/leagues"
        ? { ok: true as const, data: { leagues: [{ id: "Fixture League", realm: "pc" }] } }
        : request.path === "/api/poe/characters"
        ? { ok: true as const, data: { characters: [{ name: "FixtureRanger", class: "Ranger", level: 91, league: "Fixture League" }] } }
        : { ok: true as const, data: { items: { items: [], character: { name: "FixtureRanger" } }, passiveSkills: { hashes: [1, 2, 3], hashes_ex: [], mastery_effects: {} } } };
    },
  } : import2Preview
    ? createPobCodesCharacterTransport({ origin: publicRuntime.siteOrigin })
    : createDisabledCharacterTransport();
  const characterHost = createCharacterHostV1({ transport: characterTransport });
  buildTransfer = createBuildTransferV1({ apiBaseUrl: publicRuntime.apiBaseUrl, getBuildCode: exportBuildCode });
  if (import2Preview && options.get("legacyPayload") === "1") {
    throw new Error("The legacy payload is unavailable in this browser-only preview.");
  }
  getDebugReport = async () => {
    const storage = await navigator.storage?.estimate().catch(() => undefined);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const navigatorMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return createDebugReportV1({
      generatedAt: new Date().toISOString(),
      uptimeMs: performance.now() - startupAt,
      productName: publicRuntime.productName,
      appVersion,
      mode: import2Preview ? "browser-preview" : "local-development",
      ready,
      errorCount: errors.length,
      browser: debugBrowserIdentity(navigator.userAgent, navigator.platform),
      capabilities: {
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGiB: navigatorMemory,
        crossOriginIsolated,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        jsHeapBytes: memory?.usedJSHeapSize,
        storageUsageBytes: storage?.usage,
        storageQuotaBytes: storage?.quota,
      },
      configuration: {
        calculationScheduling: options.get("synchronousCalculations") === "1" ? "synchronous" : "scheduled",
        renderReuse: options.get("renderReuse") !== "0",
        payloadPrefetch: payloadPrefetchEnabled,
      },
      runtimeProfile: await driver!.getRuntimeProfile(),
      renderStats: lastStats,
      frames: frameSamples,
      diagnostics,
    });
  };
  const handleDebugReport = async (action: "copy" | "download") => {
    try {
      const report = await getDebugReport!();
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (action === "copy") {
        await navigator.clipboard.writeText(text);
        setHeaderStatus("Sanitized debug report copied", "info", 4_000);
        return;
      }
      const blobUrl = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `pob-codes-debug-${report.generatedAt.replaceAll(/[:.]/g, "-")}.json`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      setHeaderStatus("Sanitized debug report downloaded", "info", 4_000);
    } catch (error) {
      setHeaderStatus("Could not create the debug report", "warning", 7_000);
      throw error;
    }
  };
  driver = new Driver("release", import2Preview ? __IMPORT2_PAYLOAD_PREFIX__ : `${location.origin}/payload`, {
    onError: report,
    onFrame: (at, duration, stats) => {
      frames++; lastStats = stats;
      frameSamples.push({ at, duration, render: stats?.lastFrameTime ?? 0, reused: stats?.reused ?? false });
      if (frameSamples.length > 600) frameSamples.shift();
      if ((stats?.backend.instances ?? 0) > 0 && !hasDrawn) {
        hasDrawn = true;
        if (import2Preview) performance.mark(`${performancePrefix}-first-pob-frame`);
      }
    },
    onFetch: async (url, headers, body) => await buildTransfer!.onFetch(url, headers, body) ?? characterHost.onFetch(url, headers, body),
    onOAuthAuthorize: authorize,
    onOAuthLogout: () => setHeaderStatus("Path of Exile disconnected", "warning", 7_000),
    onTitleChange: (title) => { document.title = `${title} · ${publicRuntime.productName}`; },
  }, {
    onDiagnostic: (event) => {
      diagnostics.push(sanitizeDiagnosticV1(event, performance.now() - startupAt));
      if (diagnostics.length > 100) diagnostics.shift();
      if (event.event === "calculations-pending") calculationStatus.hidden = !event.data?.pending;
      if (event.level === "error" || event.event === "destroy") calculationStatus.hidden = true;
      const notice = runtimeStatusNotice(event);
      if (notice) {
        setHeaderStatus(notice.message, notice.tone, notice.durationMs);
        const log = notice.tone === "info" ? console.info : notice.tone === "warning" ? console.warn : console.error;
        log("[PoB runtime]", notice.message, event.data ?? {});
      }
    },
    onPayloadProgress: (progress) => payloadProgress.update(progress),
    onDebugReport: handleDebugReport,
  });
  configuration = createConfigurationBridgeV1({
    getBuildCode: () => driver!.getBuildCode(), loadBuildFromCode: code => driver!.loadBuildFromCode(code),
    applyConfiguration: request => driver!.applyConfiguration(request),
  });
  const launchButton = element<HTMLButtonElement>("launch-build");
  launchButton.disabled = true;
  launchButton.title = publicRuntime.apiBaseUrl ? "Generate, share, and open this build on PoB.Codes" : "PoB.Codes launch is not configured for this release";
  launchButton.onclick = async () => {
    const launched = window.open("about:blank", "_blank");
    if (launched) {
      launched.opener = null;
      launched.document.title = "Opening PoB.Codes…";
      launched.document.body.textContent = "Opening build in PoB.Codes…";
    }
    launchButton.disabled = true; setHeaderStatus("Launching build in PoB.Codes...");
    try {
      const url = buildTransfer!.hasPendingShare ? await buildTransfer!.retry() : await buildTransfer!.share();
      if (launched && !launched.closed) launched.location.replace(url);
      else location.assign(url);
      setHeaderStatus("Build opened in PoB.Codes", "info", 4_000);
    } catch (error) {
      launched?.close();
      setHeaderStatus(error instanceof Error ? error.message : "PoB.Codes launch failed", "error");
    } finally { launchButton.disabled = !ready || !publicRuntime.apiBaseUrl; }
  };
  await driver.start({
    legacyPayload: options.get("legacyPayload") === "1",
    allowLegacyPayloadFallback: !import2Preview,
    eagerPayload: options.get("eagerPayload") === "1",
    userDirectory: import2Preview ? "PoB Codes Import2 Preview v1" : "Path of Building", settingsRootElement: "PathOfBuilding",
    cloudflareKvPrefix: "", cloudflareKvAccessToken: undefined, cloudflareKvUserNamespace: undefined,
  });
  payloadProgress.startup(84, "Starting Path of Building");
  if (options.get("synchronousCalculations") === "1") await driver.configureCalculationScheduling(false);
  if (options.get("renderReuse") === "0") await driver.configureRenderReuse(false);
  await driver.attachToDOM(element("window"), element("editor-accessibility"));
  const deadline = performance.now() + 90_000;
  while (!hasDrawn) {
    if (errors.length) throw new Error(errors[errors.length - 1]);
    if (performance.now() > deadline) throw new Error("PoB started but did not draw its interface. Check the runtime diagnostics.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ready = true;
  launchButton.disabled = !publicRuntime.apiBaseUrl;
  telemetry.emit("build_editor_ready_v1", { result: "ready", actionTarget: "cold", durationMs: Math.round(performance.now() - startupAt) });
  await driver.markPayloadReady();
  if (import2Preview) performance.mark(`${performancePrefix}-payload-ready`);
  payloadProgress.completeStartup();
  const beginBackgroundWork = () => {
    driver?.startHelpers();
    if (payloadPrefetchEnabled) void driver?.startPayloadPrefetch();
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(beginBackgroundWork);
  else setTimeout(beginBackgroundWork, 0);
  setHeaderStatus("");
  const initial = new URLSearchParams(location.hash.slice(1));
  const initialCode = initial.get("code");
  const initialBuild = initial.get("build");
  if (initialCode || initialBuild) {
    history.replaceState(null, "", location.pathname);
    await loadBuildFromCode(initialCode ?? await buildTransfer.resolve(initialBuild!), initialBuild ? "saved-build" : "code");
  }
}

// Local acceptance harness: these methods address the same displayed Lua instance.
Object.defineProperty(window, "__DESKTOP_POB__", { value: {
  publicRuntime,
  get ready() { return ready; }, get frames() { return frames; }, get stats() { return lastStats; },
  get errors() { return [...errors]; },
  getRuntimeProfile: (reset = false) => driver!.getRuntimeProfile(reset),
  getDebugReport: () => getDebugReport!(),
  configureCalculationScheduling: (enabled: boolean) => driver!.configureCalculationScheduling(enabled),
  configureRenderReuse: (enabled: boolean) => driver!.configureRenderReuse(enabled),
  get frameSamples() { return [...frameSamples]; },
  clearFrameSamples: () => { frameSamples.length = 0; },
  loadBuildFromCode,
  applyConfiguration: (request: ConfigurationRequestV1) => configuration!.apply(request),
  undoConfiguration: () => configuration!.undo(),
  resolveBuildInput: (input: string) => buildTransfer!.resolve(input),
  shareBuild: () => buildTransfer!.share(), retryShare: () => buildTransfer!.retry(),
  getBuildCode: exportBuildCode, flushInput: () => driver!.flushInput(),
} });
window.addEventListener("pagehide", () => { driver?.detachFromDOM(); driver?.destory(); });
void main().catch(report);

function debugBrowserIdentity(userAgent: string, platform: string) {
  const candidates: [string, RegExp][] = [
    ["Edge", /Edg\/(\d+)/],
    ["Chrome", /Chrome\/(\d+)/],
    ["Firefox", /Firefox\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari/],
  ];
  const match = candidates.map(([name, pattern]) => ({ name, match: userAgent.match(pattern) })).find((entry) => entry.match);
  const coarsePlatform = /android/i.test(userAgent) ? "Android" : /iphone|ipad/i.test(userAgent) ? "iOS"
    : /win/i.test(platform) ? "Windows" : /mac/i.test(platform) ? "macOS"
    : /linux/i.test(platform) ? "Linux" : "Other";
  return { name: match?.name ?? "Other", major: match?.match?.[1] ?? "unknown", platform: coarsePlatform };
}

function createPayloadProgressOverlay() {
  const squareCount = 15;
  const section = document.createElement("section");
  section.className = "panel payload-progress";
  section.setAttribute("aria-label", "Data loading progress");
  const label = document.createElement("div");
  label.className = "payload-progress-label";
  label.setAttribute("aria-live", "polite");
  const grid = document.createElement("div");
  grid.className = "payload-progress-grid";
  grid.setAttribute("role", "progressbar");
  grid.setAttribute("aria-label", "Data progress");
  grid.setAttribute("aria-valuemin", "0");
  grid.setAttribute("aria-valuemax", "100");
  const squares = Array.from({ length: squareCount }, () => {
    const square = document.createElement("span");
    square.className = "payload-progress-square";
    square.setAttribute("aria-hidden", "true");
    grid.append(square);
    return square;
  });
  const stage = document.createElement("div");
  stage.className = "payload-progress-stage";
  stage.setAttribute("aria-live", "polite");
  const alert = document.createElement("div");
  alert.className = "payload-progress-error";
  alert.setAttribute("role", "alert");
  alert.hidden = true;
  const alertMessage = document.createElement("span");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "btn btn-secondary";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => location.reload());
  alert.append(alertMessage, reload);
  section.append(label, grid, stage, alert);
  document.body.append(section);

  let demandTimer: number | undefined;
  let pendingDemand: (() => void) | undefined;
  let dismissTimer: number | undefined;
  let startupComplete = false;
  let demandVisible = false;

  const render = (progress: number, text: string, stageText: string, busy: boolean) => {
    const value = Math.max(0, Math.min(100, Math.round(progress)));
    section.hidden = false;
    label.textContent = text;
    grid.setAttribute("aria-valuenow", String(value));
    grid.setAttribute("aria-valuetext", `${stageText} (${value}%)`);
    stage.textContent = stageText;
    stage.hidden = !busy;
    alert.hidden = true;
    const filled = Math.floor(value * squareCount / 100);
    squares.forEach((square, index) => {
      square.toggleAttribute("data-filled", index < filled);
      square.toggleAttribute("data-active", busy && index === filled);
    });
  };

  const ready = () => {
    clearTimeout(dismissTimer);
    render(100, "PoB Data Ready", "PoB Data Ready", false);
    dismissTimer = setTimeout(() => {
      section.hidden = true;
      demandVisible = false;
    }, 1_000);
  };

  return {
    startup(progress: number, stageText: string) {
      render(progress, "Loading Path of Building..", stageText, true);
    },
    update(event: PayloadProgress) {
      if (event.reason === "prefetch") return;
      const ratio = event.totalBytes ? event.loadedBytes / event.totalBytes : 0;
      const loadingAtStartup = !startupComplete;
      const progress = loadingAtStartup
        ? event.phase === "download" ? ratio * 70 : event.phase === "verify" ? 76 : 80
        : event.phase === "download" ? ratio * 90 : event.phase === "verify" ? 95 : 100;
      const stageText = event.phase === "verify"
        ? `Verifying ${event.label}`
        : event.phase === "ready" ? `${event.label} ready`
        : `Downloading ${event.label} (${formatBytes(event.loadedBytes)} of ${formatBytes(event.totalBytes)})`;
      if (loadingAtStartup) {
        render(progress, "Loading Path of Building..", stageText, event.phase !== "ready");
        return;
      }
      if (event.phase === "error") {
        this.error(event.message ?? `${event.label} could not be loaded`);
        return;
      }
      clearTimeout(dismissTimer);
      pendingDemand = () => render(progress, "Loading PoB Data..", stageText, true);
      if (!demandVisible && demandTimer === undefined && event.phase !== "ready") {
        demandTimer = setTimeout(() => {
          demandTimer = undefined;
          demandVisible = true;
          pendingDemand?.();
        }, 150);
      } else if (demandVisible) {
        render(progress, "Loading PoB Data..", stageText, event.phase !== "ready");
      }
      if (event.phase === "ready") {
        clearTimeout(demandTimer);
        demandTimer = undefined;
        pendingDemand = undefined;
        if (demandVisible) ready();
      }
    },
    completeStartup() {
      startupComplete = true;
      ready();
    },
    error(message: string) {
      clearTimeout(demandTimer);
      clearTimeout(dismissTimer);
      section.hidden = false;
      label.textContent = "PoB data needs attention";
      grid.setAttribute("aria-valuetext", "PoB data needs attention");
      stage.hidden = true;
      squares.forEach((square) => square.removeAttribute("data-active"));
      alertMessage.textContent = message;
      alert.hidden = false;
    },
  };
}

function formatBytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
