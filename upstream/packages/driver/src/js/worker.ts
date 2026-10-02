import * as Comlink from "comlink";
import { type ClipboardAction, PasteBuffer } from "./clipboard.ts";
import { observeOwnedPromise } from "./promise-owner.ts";
import type { DriverDiagnostic } from "./diagnostic.ts";
import { cloneableError, markEnvironmentError, markKnownUpstreamError } from "./error.ts";
import { ImageRepository } from "./image.ts";
import type { PoBKey } from "./keyboard.ts";
import { log, tag } from "./logger.ts";
import type { MouseState } from "./mouse-handler.ts";
import type { PoeOAuthAuthorization } from "./poe-oauth.ts";
import { loadFonts, Renderer, type RenderStats, TextMetrics, WebGL2Backend } from "./renderer/index.ts";
import { createRpcClient } from "./rpc.ts";
import { registerSentryWasm } from "./sentry-wasm.ts";
import { startRuntime } from "./startup.ts";
import { InputFrameBoundary } from "./input-frame.ts";
import { FrameDemand } from "./frame-demand.ts";
import type { UniqueJob } from './helper-pool.ts';

const setSentryWasmCodeFile = registerSentryWasm(self);
const debugWasmUrl = new URL("../../dist/debug/driver.wasm", import.meta.url).href;
const releaseWasmUrl = new URL("../../dist/release/driver.wasm", import.meta.url).href;
const mouseButtons = ["LEFTBUTTON", "MIDDLEBUTTON", "RIGHTBUTTON", "MOUSE4", "MOUSE5"] as PoBKey[];

declare const __BPTC_SUPPORT_OVERRIDE__: boolean | undefined;

interface DriverModule extends EmscriptenModule {
  cwrap: typeof cwrap;
  rpcCall: ReturnType<typeof createRpcClient>;
  takePasteText: () => string | undefined;
}

import { selectDevicePolicy, type DevicePolicy } from "../../../../../src/device-profile.ts";

type OnFetchFunction = (
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
) => Promise<{
  body: string;
  status: number | undefined;
  headers: Record<string, string>;
  error: string | undefined;
}>;

export type HostCallbacks = {
  onError: (error: unknown) => void;
  onFrame: (at: number, time: number, stats?: RenderStats) => void;
  onFetch: OnFetchFunction;
  onOAuthAuthorize: (url: string, timeoutMs: number) => Promise<PoeOAuthAuthorization>;
  onOAuthLogout: () => void;
  onTitleChange: (title: string) => void;
};

type MainCallbacks = {
  copy: (text: string) => void;
  openUrl: (url: string) => void;
};

type Imports = {
  init: () => number;
  start: () => number;
  loadBuildFromCode: (code: string) => number;
  getBuildCode: () => string;
  flushCalculations: () => number;
  configureCalculationScheduling: (enabled: number) => number;
  onFrame: () => number;
  sentryTestCrash: () => void;
  onKeyUp: (name: string, doubleClick: number) => void;
  onKeyDown: (name: string, doubleClick: number) => void;
  onChar: (char: string, doubleClick: number) => void;
  onDownloadPageResult: (result: string) => void;
  onSubScriptFinished: (id: number, data: number) => number;
  onSubScriptError: (id: number, message: string) => number;
};

export class DriverWorker {
  private mobile = false;
  private lastMobileState = "";
  private uniqueHelpersEnabled = 0;
  configureUniqueHelpers(count: number) { this.uniqueHelpersEnabled = count; }
  private imageRepo: ImageRepository | undefined;
  private textMetrics: TextMetrics | undefined;
  private renderer: Renderer | undefined;
  private screenSize: { width: number; height: number; pixelRatio: number } = {
    width: 800,
    height: 600,
    pixelRatio: 1,
  };
  private mouseState: MouseState = { x: 0, y: 0 };
  private pressedKeys: Set<PoBKey> = new Set();
  private pasteBuffer = new PasteBuffer();
  private clipboardControlPending = false;
  private hostCallbacks: Omit<HostCallbacks, "onFetch" | "onOAuthAuthorize"> | undefined;
  private mainCallbacks: MainCallbacks | undefined;
  private imports: Imports | undefined;
  private readonly frameDemand = new FrameDemand();
  private _frameScheduled = false;
  private visible = false;
  private onDiagnostic: ((diagnostic: DriverDiagnostic) => void) | undefined;
  private startupError: Error | undefined;
  private readonly inputFrame = new InputFrameBoundary(() => this.renderFrame());
  private module: DriverModule | undefined;
  private bridgeCounts: Record<string, number> | undefined;
  private readonly startupPhases: Record<string, number> = {};
  private readonly memoryCapacities: { at: number; bytes: number }[] = [];

  private sampleMemory() {
    const bytes = this.module?.HEAPU8.byteLength;
    if (bytes && this.memoryCapacities.at(-1)?.bytes !== bytes) {
      if (this.memoryCapacities.length >= 128) this.memoryCapacities.shift();
      this.memoryCapacities.push({ at: performance.now(), bytes });
    }
  }

  requestMobileAction(action: string) {
    this.imports?.flushCalculations();
    const status = this.module?.cwrap("request_mobile_action", "number", ["string"])(action);
    if (status) throw new Error("Mobile action failed");
    this.invalidate();
  }

  getRuntimeProfile(reset = false) {
    if (!this.module) throw new Error("Runtime not ready");
    const profile = this.module.cwrap("get_runtime_profile", "string", ["number"])(Number(reset));
    if (!profile) throw new Error("Runtime profiling unavailable");
    const samples = JSON.parse(profile);
    this.sampleMemory();
    const result = { samples, bridge: { ...this.bridgeCounts }, wasmBytes: this.module.HEAPU8.byteLength,
      observedMemoryCapacities: [...this.memoryCapacities], images: this.imageRepo?.getProfile(),
      startupPhases: { ...this.startupPhases },
      draw: JSON.parse(this.module.cwrap("get_draw_profile", "string", [])()) };
    if (!this.bridgeCounts) {
      for (const [name, fn] of Object.entries(this.exports(this.module))) {
        Object.assign(this.module, {
          [name]: (...args: unknown[]) => {
            this.bridgeCounts![name] = (this.bridgeCounts![name] ?? 0) + 1;
            return (fn as (...args: unknown[]) => unknown)(...args);
          },
        });
      }
    }
    if (reset || !this.bridgeCounts) this.bridgeCounts = {};
    return result;
  }

  async start(
    build: "debug" | "release",
    assetPrefix: string,
    rpcPort: MessagePort,
    eventPort: MessagePort,
    onError: HostCallbacks["onError"],
    onFrame: HostCallbacks["onFrame"],
    onOAuthLogout: HostCallbacks["onOAuthLogout"],
    onTitleChange: HostCallbacks["onTitleChange"],
    onDiagnostic: (diagnostic: DriverDiagnostic) => void,
    copy: MainCallbacks["copy"],
    openUrl: MainCallbacks["openUrl"],
    filesystemReady: () => Promise<void>,
    sortRequest: (job: UniqueJob | null) => Promise<unknown[] | null>,
    gcPause = 400,
    itemTooltipCacheMode = 1,
    nativeTextWidthCacheEnabled = true,
    devicePolicy: DevicePolicy = selectDevicePolicy({}),
  ) {
    this.onDiagnostic = onDiagnostic;
    this.mobile = devicePolicy.kind === "mobile";
    this.diagnostic("worker", "start");
    this.imageRepo = new ImageRepository(`${assetPrefix}/root/`);

    this.hostCallbacks = {
      onError,
      onFrame,
      onOAuthLogout,
      onTitleChange,
    };
    this.mainCallbacks = {
      copy,
      openUrl,
    };

    const wasmUrl = build === "release" ? releaseWasmUrl : debugWasmUrl;
    setSentryWasmCodeFile(wasmUrl);
    const rpcCall = createRpcClient(rpcPort);
    let module: DriverModule;
    const startupAt = performance.now();
    try {
      [module] = await Promise.all([
        import(`../../dist/${build}/driver.mjs`).then((driver) => {
          // The pinned Emscripten loader streams compilation and falls back to
          // ArrayBuffer on unsupported MIME/streaming; retain its error path.
          return (driver.default({ print: console.log, printErr: console.warn, rpcCall }) as Promise<DriverModule>)
            .then((module) => { this.startupPhases.wasmReadyMs = performance.now() - startupAt; return module; });
        }),
        loadFonts().then(() => { this.startupPhases.fontsReadyMs = performance.now() - startupAt; }),
      ]);
    } catch (error) {
      throw markEnvironmentError(error, "assetLoad");
    }
    this.textMetrics = new TextMetrics();
    this.renderer = new Renderer(this.imageRepo, this.textMetrics, this.screenSize);
    this.module = module;
    let sortSequence = 0;
    const sortReplies = new Map<number, string>();
    Object.assign(module, {
      runtimeGCPause: gcPause,
      runtimeMobile: devicePolicy.kind === "mobile",
      runtimeItemTooltipCacheMode: itemTooltipCacheMode,
      nativeTextWidthCacheEnabled,
      uniqueSortAvailable: () => this.uniqueHelpersEnabled,
      cancelUniqueSort: () => {
        sortSequence++; sortReplies.clear();
        void sortRequest(null).catch(() => {});
      },
      beginUniqueSort: (text: string) => {
        const id = ++sortSequence; sortReplies.clear();
        void sortRequest({ ...JSON.parse(text), uiBytes: module.HEAPU8.buffer.byteLength }).then(values => {
          if (id === sortSequence) { sortReplies.set(id, JSON.stringify(values)); this.invalidate(); }
        }, () => { if (id === sortSequence) { sortReplies.set(id, 'null'); this.invalidate(); } });
        return id;
      },
      pollUniqueSort: (id: number) => {
        if (id !== sortSequence) return 'null';
        const value = sortReplies.get(id);
        if (value !== undefined) sortReplies.delete(id);
        return value;
      },
    });
    this.sampleMemory();
    Object.assign(module, this.exports(module));
    this.imports = this.resolveImports(module);
    eventPort.onmessage = ({
      data,
    }: MessageEvent<{
      type: "subscript_finished" | "subscript_error";
      id: number;
      data?: Uint8Array;
      message?: string;
    }>) => {
      if (data.type === "subscript_finished") {
        const result = data.data ?? new Uint8Array();
        const wasmData = module._malloc(result.length);
        module.HEAPU8.set(result, wasmData);
        this.imports?.onSubScriptFinished(data.id, wasmData);
        module._free(wasmData);
      } else {
        const message = data.message ?? "Subscript failed";
        this.imports?.onSubScriptError(data.id, message);
        this.hostCallbacks?.onError(new Error(`Subscript failed: ${message}`));
      }
      this.invalidate();
    };
    eventPort.start();

    await filesystemReady();
    this.startupPhases.filesystemReadyMs = performance.now() - startupAt;
    startRuntime(this.imports, () => this.startupError);
    this.startupPhases.luaReadyMs = performance.now() - startupAt;
    this.invalidate();
  }

  destroy() {
    this.diagnostic("worker", "calculations-pending", { pending: false });
    this.visible = false;
    this.frameDemand.clear();
    this.imports = undefined;
    this.module?.cwrap("destroy_runtime", null, [])();
    this.module = undefined;
  }

  setCanvas(canvas: OffscreenCanvas) {
    this.diagnostic("canvas", "transferred", { width: canvas.width, height: canvas.height });
    const backend = new WebGL2Backend(canvas, (event, data) => {
      this.renderer?.invalidateReuse();
      this.diagnostic("webgl", event, data);
    });
    this.imageRepo?.setBptcSupport(__BPTC_SUPPORT_OVERRIDE__ ?? backend.supportsBptc);
    if (this.renderer) {
      this.renderer.backend = backend;
    }
    log.info(tag.backend, "Using WebGL2 backend");
    this.diagnostic("webgl", "context-created", { contextLost: backend.contextLost });
  }

  resize(size: { width: number; height: number; pixelRatio: number }) {
    this.screenSize = size;
    this.renderer?.resize(size);
    this.diagnostic("canvas", "worker-resize", size);
    this.invalidate();
  }

  invalidate() {
    this.frameDemand.request(3);
    this.scheduleFrame();
  }

  private requestFrames(count: number) {
    // The running frame was consumed at entry, so Lua requests count future frames.
    this.frameDemand.request(count);
    this.scheduleFrame();
  }

  private scheduleFrame() {
    if (!this._frameScheduled) {
      this._frameScheduled = true;
      requestAnimationFrame(() => this.tick());
    }
  }

  updateMouseState(mouseState: MouseState) {
    this.inputFrame.flush();
    if (mouseState.x !== this.mouseState.x || mouseState.y !== this.mouseState.y) this.inputFrame.markMotion();
    this.mouseState = mouseState;
  }

  updateKeyboardState(keys: Set<PoBKey>) {
    this.inputFrame.flush();
    if (mouseButtons.some((button) => this.pressedKeys.has(button) && !keys.has(button))) {
      // PoB stops dragging as soon as the held-button state changes. Apply the
      // latest coalesced position first, including a release before the next RAF.
      this.inputFrame.flushMotion();
    }
    this.pressedKeys = keys;
  }

  handleMouseMove(mouseState: MouseState) {
    this.updateMouseState(mouseState);
    this.frameDemand.request(1);
    this.scheduleFrame();
  }

  handleKeyDown(name: string, doubleClick: number) {
    this.imports?.onKeyDown(name, doubleClick);
    this.inputFrame.markPending();
    this.invalidate();
  }

  handleKeyUp(name: string, doubleClick: number) {
    this.imports?.onKeyUp(name, doubleClick);
    this.inputFrame.markPending();
    this.invalidate();
  }

  handleChar(char: string, doubleClick: number) {
    this.imports?.onChar(char, doubleClick);
    this.inputFrame.markPending();
    this.invalidate();
  }

  flushInput() {
    this.inputFrame.flush();
    if (this.imports?.flushCalculations()) throw new Error("Could not finish pending calculations");
  }

  configureCalculationScheduling(enabled: boolean) {
    this.flushInput();
    if (this.imports?.configureCalculationScheduling(Number(enabled))) throw new Error("Could not configure calculations");
  }

  configureRenderReuse(enabled: boolean) {
    this.renderer?.configureReuse(enabled);
    this.invalidate();
  }

  handleVisibilityChange(visible: boolean) {
    if (!visible) this.flushInput();
    this.visible = visible;
    if (visible) {
      this.invalidate();
    }
  }

  async loadBuildFromCode(code: string) {
    const status = this.imports?.loadBuildFromCode(code);
    if (status !== undefined && status !== 0) {
      throw new Error(`loadBuildFromCode failed (status=${status})`);
    }
    this.invalidate();
  }

  async getBuildCode(): Promise<string> {
    this.flushInput();
    const code = this.imports?.getBuildCode();
    if (!code) {
      throw new Error("getBuildCode failed");
    }
    return code;
  }

  setLayerVisible(layer: number, sublayer: number, visible: boolean) {
    this.renderer?.setLayerVisible(layer, sublayer, visible);
    this.invalidate();
  }

  triggerSentryTestCrash() {
    this.imports?.sentryTestCrash();
  }

  private async tick() {
    this._frameScheduled = false;

    if (this.visible && this.frameDemand.pending > 0) {
      try {
        this.renderFrame();
      } catch (error) {
        this.diagnostic("frame", "error", { error: String(error) }, "error");
        this.pasteBuffer.clear();
        this.clipboardControlPending = false;
        this.hostCallbacks?.onError(cloneableError(error));
        this.frameDemand.clear();
        return;
      }
    }

    if (this.visible && this.frameDemand.pending > 0) {
      this.scheduleFrame();
    }
  }

  private renderFrame(): void {
    // Also applies to synchronous frames used to preserve discrete input ordering.
    this.frameDemand.consume();
    const start = performance.now();
    try {
      const status = this.imports?.onFrame();
      if (status !== undefined && status !== 0) throw new Error(`PoB frame failed (status=${status})`);
    } finally {
      this.inputFrame.clear();
      this.pasteBuffer.clear();
      this.clipboardControlPending = false;
    }
    if (this.mobile && this.module) {
      const state = this.module.cwrap("get_mobile_action_state", "string", [])();
      if (state !== this.lastMobileState) {
        this.lastMobileState = state;
        this.diagnostic("frame", "mobile-actions", JSON.parse(state));
      }
    }
    const time = performance.now() - start;
    this.sampleMemory();
    const stats = this.renderer?.getStats();
    this.hostCallbacks?.onFrame(start, time, stats);
    if ((stats?.frameCount ?? 0) <= 3 || (stats?.frameCount ?? 0) % 60 === 0 || time > 100) {
      this.diagnostic("frame", "complete", {
        duration: time,
        frameCount: stats?.frameCount,
        instances: stats?.backend.instances,
        instanceBytes: stats?.backend.instanceBytes,
        dispatches: stats?.backend.dispatches,
      });
    }
  }

  private diagnostic(
    phase: DriverDiagnostic["phase"],
    event: string,
    data?: Record<string, unknown>,
    level: DriverDiagnostic["level"] = "info",
  ) {
    this.onDiagnostic?.({ phase, event, data, level });
  }

  private resolveImports(module: DriverModule): Imports {
    return {
      init: module.cwrap("init", "number", []),
      start: module.cwrap("start", "number", []),
      loadBuildFromCode: module.cwrap("load_build_from_code", "number", ["string"]),
      getBuildCode: module.cwrap("get_build_code", "string", []),
      flushCalculations: module.cwrap("flush_calculations", "number", []),
      configureCalculationScheduling: module.cwrap("configure_calculation_scheduling", "number", ["number"]),
      onFrame: module.cwrap("on_frame", "number", []),
      sentryTestCrash: module.cwrap("sentry_test_crash", null, []),
      onKeyUp: module.cwrap("on_key_up", "number", ["string", "number"]),
      onKeyDown: module.cwrap("on_key_down", "number", ["string", "number"]),
      onChar: module.cwrap("on_char", "number", ["string", "number"]),
      onDownloadPageResult: module.cwrap("on_download_page_result", "number", ["string"]),
      onSubScriptFinished: module.cwrap("on_subscript_finished", "number", ["number", "number"]),
      onSubScriptError: module.cwrap("on_subscript_error", "number", ["number", "string"]),
    };
  }

  private exports(module: DriverModule) {
    return {
      onCalculationPending: (pending: boolean) => this.diagnostic("worker", "calculations-pending", { pending }),
      onError: (message: string) => {
        this.diagnostic("worker", "calculations-pending", { pending: false });
        const error = markKnownUpstreamError(new Error(`Error in lua: ${message}`));
        this.startupError ??= error;
        this.hostCallbacks?.onError(error);
      },
      onOAuthLogout: () => this.hostCallbacks?.onOAuthLogout(),
      requestFrames: (count: number) => this.requestFrames(count),
      setWindowTitle: (title: string) => this.hostCallbacks?.onTitleChange(title),
      getScreenWidth: () => this.screenSize.width,
      getScreenHeight: () => this.screenSize.height,
      getScreenScale: () => this.screenSize.pixelRatio,
      getCursorPosX: () => this.mouseState.x,
      getCursorPosY: () => this.mouseState.y,
      isKeyDown: (name: string) =>
        this.pressedKeys.has(name as PoBKey) || (name === "CTRL" && this.clipboardControlPending),
      takePasteText: () => this.pasteBuffer.take(),
      imageLoad: (handle: number, filename: string, flags: number) => {
        const load = this.imageRepo?.load(handle, filename, flags);
        if (!load) return;
        observeOwnedPromise(
          load,
          (available) => {
            if (available) this.requestFrames(1);
          },
          (error) => {
            this.diagnostic(
              "worker",
              "image-load-error",
              { errorName: error instanceof Error && error.name ? error.name : "Error" },
              "error",
            );
            this.hostCallbacks?.onError(cloneableError(error));
          },
        );
      },
      drawCommit: (bufferPtr: number, size: number) => {
        this.renderer?.render(new DataView(module.HEAPU8.buffer, bufferPtr, size));
      },
      getStringWidth: (size: number, font: number, text: string) => this.textMetrics?.measure(size, font, text) ?? 0,
      getStringCursorIndex: (size: number, font: number, text: string, cursorX: number, cursorY: number) =>
        this.textMetrics?.measureCursorIndex(size, font, text, cursorX, cursorY) ?? 0,
      copy: (text: string) => this.mainCallbacks?.copy(text),
      openUrl: (url: string) => this.mainCallbacks?.openUrl(url),
    };
  }

  handleClipboardAction(action: ClipboardAction) {
    this.flushInput();
    const key = action.type === "copy" ? "c" : "v";
    if (action.type === "paste") this.pasteBuffer.push(action.text);

    this.clipboardControlPending = true;
    this.imports?.onKeyDown(key, 0);
    this.imports?.onKeyUp(key, 0);
    this.inputFrame.markPending();
    this.invalidate();
  }
}

const worker = new DriverWorker();
Comlink.expose(worker);
