export const BUILD_FOLDER_IMPORT_LOCK = "pob-codes-local-user-storage-v1";
export const BUILD_FOLDER_IMPORT_SENTINEL = ".pob-codes-import.pending";
export const BUILD_FOLDER_IMPORT_REGISTRY = "/user/.pob-codes-build-imports-v1";

// These conservative limits are validated against the real OPFS browser harness.
export const BUILD_FOLDER_IMPORT_LIMITS = Object.freeze({
  files: 500,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
});

export type BuildListState = {
  mode: string;
  subPath: string;
  buildPath: string;
  virtualWidth: number;
  virtualHeight: number;
  uiScale: number;
  pixelRatio: number;
};

export type BuildFolderImportFile = Pick<File, "name" | "size" | "arrayBuffer"> & {
  webkitRelativePath: string;
};

export type BuildFolderImportCode =
  | "unsupported"
  | "invalid-selection"
  | "no-builds"
  | "limit"
  | "quota"
  | "destination-changed"
  | "storage";

export class BuildFolderImportError extends Error {
  constructor(readonly code: BuildFolderImportCode, message: string) {
    super(message);
    this.name = "BuildFolderImportError";
  }
}

export type PlannedBuildFile = {
  file: BuildFolderImportFile;
  relativePath: string;
  segments: string[];
};

export type BuildFolderImportPlan = {
  rootName: string;
  files: PlannedBuildFile[];
  ignoredCount: number;
  totalBytes: number;
};

export type BuildFolderImportResult = {
  folderName: string;
  acceptedCount: number;
  ignoredCount: number;
  logicalDestination: string;
};

export type InternalBuildFolderImportResult = BuildFolderImportResult & { token: string };

type ManifestState = "writing" | "ready";
type RecoveryManifest = {
  version: 1;
  token: string;
  buildRoot: string;
  destination: string;
  files: string[];
  state: ManifestState;
};

export type BuildFolderImportFileSystem = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, exclusive?: boolean): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
};

export type BuildFolderImportDependencies = {
  fs: BuildFolderImportFileSystem;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  liveDirectoryExists(path: string): Promise<boolean>;
  estimateStorage?(): Promise<{ quota?: number; usage?: number }>;
  randomToken(): string;
};

export type BuildFolderRecoveryResult = {
  revealed: number;
  cleaned: number;
  quarantined: number;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function assertSegment(segment: string): void {
  if (!segment || segment === "." || segment === ".." || segment.includes("/") ||
      segment.includes("\\") || CONTROL_CHARACTERS.test(segment)) {
    throw new BuildFolderImportError("invalid-selection", "The selected folder contains an unsupported path.");
  }
}

export function splitRelativePath(path: string): string[] {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || CONTROL_CHARACTERS.test(path)) {
    throw new BuildFolderImportError("invalid-selection", "The selected folder contains an unsupported path.");
  }
  const segments = path.split("/");
  for (const segment of segments) assertSegment(segment);
  return segments;
}

export function planBuildFolderImport(
  selection: readonly BuildFolderImportFile[],
  limits = BUILD_FOLDER_IMPORT_LIMITS,
): BuildFolderImportPlan {
  if (!selection.length) {
    throw new BuildFolderImportError("invalid-selection", "No folder was selected.");
  }
  let rootName: string | undefined;
  let ignoredCount = 0;
  let totalBytes = 0;
  const files: PlannedBuildFile[] = [];
  for (const file of selection) {
    const segments = splitRelativePath(file.webkitRelativePath);
    if (segments.length < 2 || file.name !== segments.at(-1)) {
      throw new BuildFolderImportError("invalid-selection", "The browser did not provide a usable folder selection.");
    }
    rootName ??= segments[0];
    if (segments[0] !== rootName) {
      throw new BuildFolderImportError("invalid-selection", "Select one folder at a time.");
    }
    if (!file.name.endsWith(".xml")) {
      ignoredCount++;
      continue;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.fileBytes) {
      throw new BuildFolderImportError("limit", "One or more build files exceed the import size limit.");
    }
    totalBytes += file.size;
    if (totalBytes > limits.totalBytes || files.length + 1 > limits.files) {
      throw new BuildFolderImportError("limit", "The selected folder exceeds the import limits.");
    }
    const relativeSegments = segments.slice(1);
    files.push({ file, segments: relativeSegments, relativePath: relativeSegments.join("/") });
  }
  if (!rootName) throw new BuildFolderImportError("invalid-selection", "The browser did not provide a folder path.");
  if (!files.length) throw new BuildFolderImportError("no-builds", "The selected folder contains no lower-case .xml build files.");
  return { rootName, files, ignoredCount, totalBytes };
}

function normalizeAbsolutePath(path: string): string[] {
  if (!path.startsWith("/") || path.includes("\\") || CONTROL_CHARACTERS.test(path)) {
    throw new BuildFolderImportError("invalid-selection", "The configured build path is unavailable to this browser.");
  }
  const body = path.slice(1).replace(/\/$/, "");
  if (!body || body.includes("//")) {
    throw new BuildFolderImportError("invalid-selection", "The configured build path is unavailable to this browser.");
  }
  const segments = body.split("/");
  for (const segment of segments) assertSegment(segment);
  return segments;
}

export function mapNativeBuildRoot(buildPath: string, subPath: string, cloudDirectory?: string): string {
  const nativeSegments = normalizeAbsolutePath(buildPath);
  if (nativeSegments[0] !== "app" || nativeSegments[1] !== "user" || nativeSegments.length < 3) {
    throw new BuildFolderImportError("invalid-selection", "The configured build path is outside browser-local storage.");
  }
  const subSegments = subPath ? splitRelativePath(subPath.replace(/\/$/, "")) : [];
  const destination = `/${["user", ...nativeSegments.slice(2), ...subSegments].join("/")}`;
  if (destination === "/user" || !destination.startsWith("/user/")) {
    throw new BuildFolderImportError("invalid-selection", "The configured build path is outside browser-local storage.");
  }
  if (cloudDirectory && (destination === cloudDirectory || destination.startsWith(`${cloudDirectory}/`))) {
    throw new BuildFolderImportError("invalid-selection", "Folder import is unavailable for the cloud build directory.");
  }
  return destination;
}

export function buildLogicalDestination(subPath: string, folderName: string): string {
  const parts = subPath ? splitRelativePath(subPath.replace(/\/$/, "")) : [];
  return ["Builds", ...parts, folderName].join(" > ");
}

export async function allocateFolderName(
  rootName: string,
  buildRoot: string,
  liveDirectoryExists: (path: string) => Promise<boolean>,
): Promise<string> {
  for (let suffix = 1; suffix <= 100_000; suffix++) {
    const name = suffix === 1 ? rootName : `${rootName}[${suffix}]`;
    if (!(await liveDirectoryExists(`${buildRoot}/${name}`))) return name;
  }
  throw new BuildFolderImportError("storage", "Could not reserve a destination folder.");
}

function joinPath(root: string, relative: string): string {
  return relative ? `${root}/${relative}` : root;
}

function parentDirectories(files: readonly PlannedBuildFile[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    for (let length = 1; length < file.segments.length; length++) {
      directories.add(file.segments.slice(0, length).join("/"));
    }
  }
  return [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function manifestPath(token: string): string {
  return `${BUILD_FOLDER_IMPORT_REGISTRY}/${token}.json`;
}

function encodeManifest(manifest: RecoveryManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

function decodeManifest(bytes: Uint8Array): RecoveryManifest | undefined {
  if (bytes.byteLength > 2 * 1024 * 1024) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RecoveryManifest>;
    if (value.version !== 1 || !TOKEN_PATTERN.test(value.token ?? "") ||
        (value.state !== "writing" && value.state !== "ready") ||
        typeof value.buildRoot !== "string" || typeof value.destination !== "string" ||
        !Array.isArray(value.files) || value.files.some(path => typeof path !== "string")) return undefined;
    normalizeAbsolutePath(value.buildRoot);
    normalizeAbsolutePath(value.destination);
    for (const file of value.files) splitRelativePath(file);
    return value as RecoveryManifest;
  } catch {
    return undefined;
  }
}

async function ensureDirectory(fs: BuildFolderImportFileSystem, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}

async function cleanupOwnedImport(
  fs: BuildFolderImportFileSystem,
  manifest: RecoveryManifest,
): Promise<boolean> {
  const marker = `${manifest.destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`;
  if (!(await fs.exists(marker))) return false;
  const markerToken = new TextDecoder().decode(await fs.readFile(marker));
  if (markerToken !== manifest.token) return false;

  for (const relativePath of manifest.files) {
    const path = joinPath(manifest.destination, relativePath);
    if (await fs.exists(path)) await fs.unlink(path);
  }
  const directories = [...new Set(manifest.files.flatMap(path => {
    const segments = path.split("/");
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  }))].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
  for (const directory of directories) {
    const path = joinPath(manifest.destination, directory);
    if (await fs.exists(path) && (await fs.readdir(path)).length === 0) await fs.rmdir(path);
  }
  const remaining = (await fs.readdir(manifest.destination)).filter(name => name !== BUILD_FOLDER_IMPORT_SENTINEL);
  if (remaining.length) return false;
  await fs.unlink(marker);
  await fs.rmdir(manifest.destination);
  return true;
}

export class BuildFolderImporter {
  constructor(private readonly dependencies: BuildFolderImportDependencies) {}

  async import(
    selection: readonly BuildFolderImportFile[],
    buildPath: string,
    subPath: string,
    cloudDirectory?: string,
  ): Promise<InternalBuildFolderImportResult> {
    const plan = planBuildFolderImport(selection);
    const buildRoot = mapNativeBuildRoot(buildPath, "", cloudDirectory);
    const destinationRoot = mapNativeBuildRoot(buildPath, subPath, cloudDirectory);
    const estimate = await this.dependencies.estimateStorage?.();
    if (estimate?.quota !== undefined && estimate.usage !== undefined &&
        estimate.quota - estimate.usage < plan.totalBytes + 8 * 1024 * 1024) {
      throw new BuildFolderImportError("quota", "There is not enough browser storage available for this folder.");
    }

    return await this.dependencies.withLock(async () => {
      const folderName = await allocateFolderName(plan.rootName, destinationRoot, this.dependencies.liveDirectoryExists);
      const destination = `${destinationRoot}/${folderName}`;
      const token = this.dependencies.randomToken();
      if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid import ownership token");
      const manifest: RecoveryManifest = {
        version: 1,
        token,
        buildRoot,
        destination,
        files: plan.files.map(file => file.relativePath),
        state: "writing",
      };
      let registered = false;
      let destinationCreated = false;
      let markerWritten = false;
      try {
        await ensureDirectory(this.dependencies.fs, BUILD_FOLDER_IMPORT_REGISTRY);
        await this.dependencies.fs.writeFile(manifestPath(token), encodeManifest(manifest), true);
        registered = true;
        await this.dependencies.fs.mkdir(destination);
        destinationCreated = true;
        await this.dependencies.fs.writeFile(
          `${destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`,
          new TextEncoder().encode(token),
          true,
        );
        markerWritten = true;
        for (const directory of parentDirectories(plan.files)) {
          await ensureDirectory(this.dependencies.fs, joinPath(destination, directory));
        }
        for (const planned of plan.files) {
          const source = new Uint8Array(await planned.file.arrayBuffer());
          const path = joinPath(destination, planned.relativePath);
          await this.dependencies.fs.writeFile(path, source, true);
          const stored = await this.dependencies.fs.readFile(path);
          if (!bytesEqual(source, stored)) throw new Error("Stored build verification failed");
        }
        manifest.state = "ready";
        await this.dependencies.fs.writeFile(manifestPath(token), encodeManifest(manifest));
        await this.dependencies.fs.unlink(`${destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`);
        return {
          token,
          folderName,
          acceptedCount: plan.files.length,
          ignoredCount: plan.ignoredCount,
          logicalDestination: buildLogicalDestination(subPath, folderName),
        };
      } catch (error) {
        if (registered) {
          try {
            if (destinationCreated && !markerWritten) {
              try {
                await this.dependencies.fs.writeFile(
                  `${destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`,
                  new TextEncoder().encode(token),
                  true,
                );
                markerWritten = true;
              } catch {
                // If even the marker cannot be written, only remove an empty
                // directory. rmdir remains authoritative if another writer won.
                if ((await this.dependencies.fs.readdir(destination)).length === 0) {
                  await this.dependencies.fs.rmdir(destination);
                }
              }
            }
            if ((!destinationCreated || !(await this.dependencies.fs.exists(destination))) ||
                (markerWritten && await cleanupOwnedImport(this.dependencies.fs, manifest))) {
              await this.dependencies.fs.unlink(manifestPath(token));
            }
          } catch {
            // Leave the tokened marker and manifest for bounded reload recovery.
          }
        }
        if (error instanceof BuildFolderImportError) throw error;
        throw new BuildFolderImportError("storage", "The folder could not be copied into browser storage.");
      }
    });
  }

  async finalize(token: string): Promise<void> {
    if (!TOKEN_PATTERN.test(token)) return;
    await this.dependencies.withLock(async () => {
      const path = manifestPath(token);
      if (!(await this.dependencies.fs.exists(path))) return;
      const manifest = decodeManifest(await this.dependencies.fs.readFile(path));
      if (manifest?.token === token && manifest.state === "ready" &&
          !(await this.dependencies.fs.exists(`${manifest.destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`))) {
        await this.dependencies.fs.unlink(path);
      }
    });
  }

  async recover(buildPath: string, cloudDirectory?: string): Promise<BuildFolderRecoveryResult> {
    const buildRoot = mapNativeBuildRoot(buildPath, "", cloudDirectory);
    return await this.dependencies.withLock(async () => {
      const result = { revealed: 0, cleaned: 0, quarantined: 0 };
      if (!(await this.dependencies.fs.exists(BUILD_FOLDER_IMPORT_REGISTRY))) return result;
      for (const name of await this.dependencies.fs.readdir(BUILD_FOLDER_IMPORT_REGISTRY)) {
        if (!name.endsWith(".json")) continue;
        const path = `${BUILD_FOLDER_IMPORT_REGISTRY}/${name}`;
        const manifest = decodeManifest(await this.dependencies.fs.readFile(path));
        if (!manifest || manifest.buildRoot !== buildRoot ||
            !manifest.destination.startsWith(`${buildRoot}/`)) {
          result.quarantined++;
          continue;
        }
        if (!(await this.dependencies.fs.exists(manifest.destination))) {
          await this.dependencies.fs.unlink(path);
          result.cleaned++;
          continue;
        }
        const marker = `${manifest.destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`;
        if (!(await this.dependencies.fs.exists(marker))) {
          if (manifest.state === "ready") {
            await this.dependencies.fs.unlink(path);
            result.cleaned++;
          } else {
            result.quarantined++;
          }
          continue;
        }
        const markerToken = new TextDecoder().decode(await this.dependencies.fs.readFile(marker));
        if (markerToken !== manifest.token) {
          result.quarantined++;
          continue;
        }
        let complete = manifest.state === "ready";
        for (const file of manifest.files) {
          if (!(await this.dependencies.fs.exists(joinPath(manifest.destination, file)))) {
            complete = false;
            break;
          }
        }
        if (complete) {
          await this.dependencies.fs.unlink(marker);
          await this.dependencies.fs.unlink(path);
          result.revealed++;
        } else if (await cleanupOwnedImport(this.dependencies.fs, manifest)) {
          await this.dependencies.fs.unlink(path);
          result.cleaned++;
        } else {
          result.quarantined++;
        }
      }
      return result;
    });
  }
}

type LockManagerLike = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
};

export class LocalUserStorageLock {
  constructor(
    private readonly locks: LockManagerLike | undefined =
      (navigator as Navigator & { locks?: LockManagerLike }).locks,
  ) {}

  get available(): boolean {
    return this.locks !== undefined;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.locks) return await operation();
    return await this.locks.request(BUILD_FOLDER_IMPORT_LOCK, { mode: "exclusive" }, operation);
  }
}
