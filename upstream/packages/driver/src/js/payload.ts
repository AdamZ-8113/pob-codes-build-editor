import { Zip } from "@zenfs/archives";
import * as zenfs from "@zenfs/core";
import {
  type PayloadManifest,
  type PayloadPackage,
  sha256,
  validatePayloadManifest,
} from "../../../../payload-manifest.ts";
import { rejectWrites } from "./fs.ts";

export type PayloadProgressReason = "startup" | "demand" | "prefetch";
export type PayloadProgressPhase = "download" | "verify" | "ready" | "error";
export type PayloadProgress = {
  reason: PayloadProgressReason;
  label: string;
  loadedBytes: number;
  totalBytes: number;
  phase: PayloadProgressPhase;
  message?: string;
};

export type PayloadProfile = {
  loadedPackages: string[];
  packagesBeforeReady: number;
  bytesBeforeReady: number;
  packageOpens: string[];
};

type ProgressCallback = (progress: PayloadProgress) => void | Promise<void>;
type PackageSource = { package: LazyPackage; source?: zenfs.FileSystem; lazy: boolean };

const NO_PROGRESS_TIMEOUT_MS = 15_000;
const DEMAND_TIMEOUT_MS = 100_000;
const RETRY_BACKOFF_MS = [500, 1_000, 2_000];

class PayloadIntegrityError extends Error {}

export class PayloadLoadError extends Error {
  override name = "PobPayloadLoadError";
  constructor(readonly packageId: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Manifest-backed namespace whose lazy files become readable only after verification. */
export class PayloadFileSystem extends zenfs.IndexFS {
  private sources = new Map<string, PackageSource>();
  constructor(directories: string[] = []) {
    super(0x504f4250, "desktop-payload");
    this.addDirectory("/");
    for (const directory of directories) {
      const parts = directory.split("/");
      for (let i = 1; i <= parts.length; i++) this.addDirectory("/" + parts.slice(0, i).join("/"));
    }
    rejectWrites(this);
  }
  private addDirectory(path: string) {
    if (this.index.has(path)) return;
    const id = this.index._alloc();
    this.index.set(
      path,
      new zenfs.Inode({ mode: zenfs.constants.S_IFDIR | 0o555, size: 4096, ino: id, data: id + 1, nlink: 1 }),
    );
  }
  add(path: string, bytes: number, source: PackageSource) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.addDirectory("/" + parts.slice(0, i).join("/"));
    const id = this.index._alloc();
    this.index.set(
      "/" + path,
      new zenfs.Inode({
        mode: zenfs.constants.S_IFREG | 0o444,
        size: bytes,
        ino: id,
        data: id + 1,
        nlink: 1,
        flags: 0x2000,
      }),
    );
    this.sources.set("/" + path, source);
  }
  override async read(path: string, buffer: Uint8Array, start: number, end: number) {
    const entry = this.sources.get(path);
    if (!entry) throw new Error("Missing packaged file");
    await entry.package.ensure("demand");
    if (!entry.source) throw new Error("Packaged file was not mounted");
    await entry.source.read(path, buffer, start, end);
  }
  override readSync(path: string, buffer: Uint8Array, start: number, end: number) {
    const entry = this.sources.get(path);
    if (!entry) throw new Error("Missing packaged file");
    if (entry.lazy) throw new Error("Synchronous reads are forbidden for lazy payload packages");
    if (!entry.source) throw new Error("Packaged file was not mounted");
    entry.source.readSync(path, buffer, start, end);
  }
  protected override async remove(_path: string): Promise<void> {
    throw new Error("Read-only payload");
  }
  protected override removeSync(_path: string): void {
    throw new Error("Read-only payload");
  }
  override async write(_path: string, _data: Uint8Array, _offset: number): Promise<void> {
    throw new Error("Read-only payload");
  }
  override writeSync(_path: string, _data: Uint8Array, _offset: number): void {
    throw new Error("Read-only payload");
  }
}

class LazyPackage {
  readonly files: PackageSource[] = [];
  source: zenfs.FileSystem | undefined;
  inFlight: Promise<void> | undefined;
  activeReason: PayloadProgressReason = "prefetch";

  constructor(
    readonly entry: PayloadPackage,
    readonly initiallyLazy: boolean,
    private readonly prefix: string,
    private readonly fetcher: typeof fetch,
    private readonly emitProgress: (pkg: LazyPackage, loaded: number, phase: PayloadProgressPhase, message?: string) => void,
  ) {}

  async ensure(reason: PayloadProgressReason): Promise<void> {
    if (this.source) return;
    this.promote(reason);
    if (!this.inFlight) {
      this.inFlight = this.load().catch((error) => {
        if (this.activeReason === "prefetch") this.inFlight = undefined;
        throw error;
      });
    }
    return await this.inFlight;
  }

  private promote(reason: PayloadProgressReason) {
    const priority: Record<PayloadProgressReason, number> = { prefetch: 0, startup: 1, demand: 2 };
    if (priority[reason] > priority[this.activeReason]) this.activeReason = reason;
  }

  private async load(): Promise<void> {
    const deadline = performance.now() + (this.activeReason === "demand" ? DEMAND_TIMEOUT_MS : Number.POSITIVE_INFINITY);
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt) await delayWithinDeadline(RETRY_BACKOFF_MS[attempt - 1], deadline, this.entry.id);
      try {
        const data = await this.download(deadline);
        this.emitProgress(this, this.entry.bytes, "verify");
        if (await sha256(data) !== this.entry.sha256) throw new PayloadIntegrityError("package hash mismatch");
        const source = await zenfs.resolveMountConfig({ backend: Zip, data: data.buffer, name: this.entry.id });
        await verifyMembership(source, this.entry);
        this.source = source;
        for (const file of this.files) file.source = source;
        this.emitProgress(this, this.entry.bytes, "ready");
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof PayloadIntegrityError) break;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    const message = `${payloadLabel(this.entry.id)} could not be loaded: ${detail}`;
    this.emitProgress(this, 0, "error", message);
    throw new PayloadLoadError(this.entry.id, message, { cause: lastError });
  }

  private async download(deadline: number): Promise<Uint8Array<ArrayBuffer>> {
    const controller = new AbortController();
    this.emitProgress(this, 0, "download");
    const response = await withNoProgress(
      this.fetcher(`${this.prefix}/packages/${this.entry.sha256}.zip`, {
        cache: "force-cache",
        signal: controller.signal,
      }),
      Math.min(NO_PROGRESS_TIMEOUT_MS, deadline - performance.now()),
      controller,
      this.entry.id,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== this.entry.bytes) throw new PayloadIntegrityError("package size mismatch");
      this.emitProgress(this, bytes.length, "download");
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const result = await withNoProgress(
        reader.read(),
        Math.min(NO_PROGRESS_TIMEOUT_MS, deadline - performance.now()),
        controller,
        this.entry.id,
      );
      if (result.done) break;
      chunks.push(result.value);
      loaded += result.value.length;
      if (loaded > this.entry.bytes) throw new PayloadIntegrityError("package size mismatch");
      this.emitProgress(this, loaded, "download");
    }
    if (loaded !== this.entry.bytes) throw new PayloadIntegrityError("package size mismatch");
    const data = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return data;
  }
}

export class PayloadController {
  private readonly packages = new Map<string, LazyPackage>();
  private readonly paths = new Map<string, LazyPackage>();
  private readonly startupLoaded = new Map<string, number>();
  private readonly packageOpens: string[] = [];
  private readySnapshot: { packages: number; bytes: number } | undefined;
  private prefetchStarted = false;

  constructor(
    readonly filesystem: PayloadFileSystem,
    readonly manifest: PayloadManifest,
    prefix: string,
    fetcher: typeof fetch,
    eager: boolean,
    private readonly onProgress?: ProgressCallback,
  ) {
    for (const entry of manifest.packages) {
      // Even diagnostic eager mode must not inflate the complete Abyss dataset.
      const startup = !entry.id.startsWith("abyss-") && (eager || entry.startup);
      const pkg = new LazyPackage(entry, !startup, prefix, fetcher.bind(globalThis), (source, loaded, phase, message) =>
        this.progress(source, loaded, phase, message));
      pkg.activeReason = startup ? "startup" : "prefetch";
      this.packages.set(entry.id, pkg);
      for (const file of entry.files) {
        const source: PackageSource = { package: pkg, lazy: !startup };
        pkg.files.push(source);
        this.paths.set("/" + file.path, pkg);
        filesystem.add(file.path, file.bytes, source);
      }
    }
  }

  async loadStartup() {
    const packages = [...this.packages.values()].filter((pkg) => !pkg.initiallyLazy);
    let next = 0;
    await Promise.all([0, 1].map(async () => {
      while (next < packages.length) await packages[next++].ensure("startup");
    }));
  }

  async readVerifiedFile(rootPath: string, release = false): Promise<Uint8Array> {
    const path = normalizeRootPath(rootPath);
    const pkg = this.paths.get(path);
    if (!pkg) throw new PayloadLoadError("abyss-records", "Abyss file missing from manifest");
    await this.ensurePath(rootPath);
    try {
      const expected = pkg.entry.files.find(f => "/" + f.path === path)!;
      const bytes = new Uint8Array(expected.bytes);
      await pkg.source!.read(path, bytes, 0, bytes.length);
      return bytes;
    } finally {
      // Drop ZIP AND all mounted file-source references. The dedicated broker
      // LRU owns the verified raw block; no second unbounded archive cache.
      if (release) { pkg.source = undefined; pkg.inFlight = undefined; for (const file of pkg.files) file.source = undefined; }
    }
  }

  async ensurePath(rootPath: string) {
    const pkg = this.paths.get(normalizeRootPath(rootPath));
    if (!pkg) return;
    if (!this.packageOpens.includes(pkg.entry.id)) this.packageOpens.push(pkg.entry.id);
    await pkg.ensure("demand");
  }

  packageIdForPath(rootPath: string): string | undefined {
    return this.paths.get(normalizeRootPath(rootPath))?.entry.id;
  }

  markReady() {
    const loaded = [...this.packages.values()].filter((pkg) => pkg.source);
    this.readySnapshot = {
      packages: loaded.length,
      bytes: loaded.reduce((total, pkg) => total + pkg.entry.bytes, 0),
    };
  }

  startPrefetch() {
    if (this.prefetchStarted) return;
    this.prefetchStarted = true;
    const unloaded = [...this.packages.values()].filter((pkg) => !pkg.source && !pkg.entry.id.startsWith("abyss-"));
    unloaded.sort((a, b) => prefetchRank(a.entry.id) - prefetchRank(b.entry.id) || a.entry.id.localeCompare(b.entry.id));
    void (async () => {
      for (const pkg of unloaded) {
        try {
          await pkg.ensure("prefetch");
        } catch {
          // A prefetch miss stays retryable and becomes fatal only if demanded.
        }
      }
    })();
  }

  profile(): PayloadProfile {
    const loaded = [...this.packages.values()].filter((pkg) => pkg.source);
    const snapshot = this.readySnapshot ?? {
      packages: loaded.length,
      bytes: loaded.reduce((total, pkg) => total + pkg.entry.bytes, 0),
    };
    return {
      loadedPackages: loaded.map((pkg) => pkg.entry.id),
      packagesBeforeReady: snapshot.packages,
      bytesBeforeReady: snapshot.bytes,
      packageOpens: [...this.packageOpens],
    };
  }

  private progress(pkg: LazyPackage, loaded: number, phase: PayloadProgressPhase, message?: string) {
    let loadedBytes = loaded;
    let totalBytes = pkg.entry.bytes;
    if (pkg.activeReason === "startup") {
      this.startupLoaded.set(pkg.entry.id, loaded);
      loadedBytes = [...this.startupLoaded.values()].reduce((total, value) => total + value, 0);
      totalBytes = [...this.packages.values()].filter((candidate) => !candidate.initiallyLazy)
        .reduce((total, candidate) => total + candidate.entry.bytes, 0);
    }
    try {
      void Promise.resolve(this.onProgress?.({
        reason: pkg.activeReason,
        label: payloadLabel(pkg.entry.id),
        loadedBytes,
        totalBytes,
        phase,
        message,
      })).catch(() => {});
    } catch {
      // Progress reporting must never affect payload correctness.
    }
  }
}

export type LoadedPayload = {
  filesystem: zenfs.FileSystem;
  controller?: PayloadController;
};

export async function loadPayload(
  prefix: string,
  fetcher: typeof fetch = fetch,
  options: { legacy?: boolean; allowLegacyFallback?: boolean; eager?: boolean; onProgress?: ProgressCallback } = {},
): Promise<LoadedPayload> {
  const response = options.legacy
    ? new Response(null, { status: 404 })
    : await fetcher(`${prefix}/manifest.json`, { cache: "no-store" });
  if (options.legacy || (response.status === 404 && options.allowLegacyFallback !== false)) {
    const legacy = await fetcher(`${prefix}/root.zip`);
    if (!legacy.ok) throw new Error("Legacy desktop payload unavailable");
    const filesystem = await zenfs.resolveMountConfig({
      backend: Zip,
      data: await legacy.arrayBuffer(),
      name: "root.zip",
    });
    rejectWrites(filesystem);
    return { filesystem };
  }
  if (!response.ok) throw new Error("Desktop payload manifest unavailable");
  const manifest = validatePayloadManifest(await response.json());
  const filesystem = new PayloadFileSystem(manifest.directories);
  const controller = new PayloadController(
    filesystem,
    manifest,
    prefix,
    fetcher,
    options.eager ?? false,
    options.onProgress,
  );
  await controller.loadStartup();
  return { filesystem, controller };
}

async function verifyMembership(source: zenfs.FileSystem, entry: PayloadPackage) {
  const expected = new Map(entry.files.map((file) => ["/" + file.path, file.bytes]));
  const visit = async (directory: string): Promise<void> => {
    for (const name of await source.readdir(directory)) {
      const path = `${directory === "/" ? "" : directory}/${name}`;
      const stat = await source.stat(path);
      if ((stat.mode & zenfs.constants.S_IFMT) === zenfs.constants.S_IFDIR) await visit(path);
      else {
        if (expected.get(path) !== stat.size) throw new PayloadIntegrityError("archive membership mismatch");
        expected.delete(path);
      }
    }
  };
  await visit("/");
  if (expected.size) throw new PayloadIntegrityError("archive member missing");
}

function normalizeRootPath(path: string) {
  const rootPath = path === "/root" ? "/" : path.startsWith("/root/") ? path.slice("/root".length) : path;
  return rootPath.startsWith("/") ? rootPath : "/" + rootPath;
}

function prefetchRank(id: string) {
  if (id.startsWith("tree-")) return 0;
  if (id.startsWith("timeless-")) return 1;
  return 2;
}

export function payloadLabel(id: string) {
  if (id === "core") return "core data";
  const tree = /^tree-(.+)$/.exec(id)?.[1];
  if (tree) {
    return `${tree.replaceAll("_", ".").replace(".ruthless", " Ruthless").replace(".alternate", " alternate")} passive tree`;
  }
  const timeless = /^timeless-(.+?)(?:-zip(?:-part\d+)?)?$/.exec(id)?.[1];
  if (timeless) {
    const names: Record<string, string> = {
      brutalrestraint: "Brutal Restraint",
      eleganthubris: "Elegant Hubris",
      gloriousvanity: "Glorious Vanity",
      heroictragedy: "Heroic Tragedy",
      lethalpride: "Lethal Pride",
      militantfaith: "Militant Faith",
      abyssamanamu: "Amanamu",
      abysskurgal: "Kurgal",
      abysstecrod: "Tecrod",
      abyssulaman: "Ulaman",
      abysszorath: "Zorath",
      shared: "Timeless",
    };
    return `${names[timeless] ?? "Timeless"} data`;
  }
  return id.replaceAll("-", " ");
}

async function withNoProgress<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  packageId: string,
): Promise<T> {
  if (!(timeoutMs > 0)) throw new PayloadLoadError(packageId, "Payload demand deadline exceeded");
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Payload download made no progress"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function delayWithinDeadline(delayMs: number, deadline: number, packageId: string) {
  const remaining = deadline - performance.now();
  if (remaining <= delayMs) throw new PayloadLoadError(packageId, "Payload demand deadline exceeded");
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
