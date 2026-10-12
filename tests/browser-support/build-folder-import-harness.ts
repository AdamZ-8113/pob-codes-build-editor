import { configure, fs, resolveMountConfig } from "@zenfs/core";
import {
  BUILD_FOLDER_IMPORT_REGISTRY,
  BUILD_FOLDER_IMPORT_SENTINEL,
  BuildFolderImporter,
  type BuildFolderImportFile,
  type BuildFolderImportFileSystem,
} from "../../upstream/packages/driver/src/js/build-folder-import.ts";
import { TruncatingWebAccess } from "../../upstream/packages/driver/src/js/web-access.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function selected(path: string, contents: string): BuildFolderImportFile {
  const bytes = encoder.encode(contents);
  return {
    name: path.split("/").at(-1)!,
    size: bytes.byteLength,
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function mountedFileSystem(
  intercept?: (path: string) => Promise<void>,
): BuildFolderImportFileSystem {
  return {
    exists: path => fs.promises.exists(path),
    mkdir: async path => { await fs.promises.mkdir(path); },
    readdir: path => fs.promises.readdir(path),
    readFile: async path => new Uint8Array(await fs.promises.readFile(path)),
    writeFile: async (path, data, exclusive = false) => {
      await intercept?.(path);
      await fs.promises.writeFile(path, data, { flag: exclusive ? "wx" : "w" });
    },
    unlink: async path => { await fs.promises.unlink(path); },
    rmdir: async path => { await fs.promises.rmdir(path); },
  };
}

export async function runBuildFolderImportOpfsProbe(): Promise<{
  committedBytes: string;
  failureEntries: string[];
  recoveryQuarantined: number;
}> {
  const opfs = await navigator.storage.getDirectory();
  const ownedName = `.pob-build-folder-import-test-${crypto.randomUUID()}`;
  const owned = await opfs.getDirectoryHandle(ownedName, { create: true });
  try {
    const backend = await resolveMountConfig({
      backend: TruncatingWebAccess,
      handle: owned,
      disableAsyncCache: true,
    });
    await configure({ mounts: { "/": backend } });
    await fs.promises.mkdir("/user/Builds", { recursive: true });

    const importer = new BuildFolderImporter({
      fs: mountedFileSystem(),
      withLock: operation => operation(),
      liveDirectoryExists: path => fs.promises.exists(path),
      randomToken: () => "a".repeat(32),
    });
    const success = await importer.import([
      selected("Complete/one.xml", "one"),
      selected("Complete/Nested/two.xml", "two"),
    ], "/app/user/Builds/", "");
    if (await fs.promises.exists(`/user/Builds/Complete/${BUILD_FOLDER_IMPORT_SENTINEL}`)) {
      throw new Error("Committed OPFS folder retained its visibility marker");
    }
    const committedBytes = decoder.decode(await fs.promises.readFile("/user/Builds/Complete/Nested/two.xml"));
    await importer.finalize(success.token);
    if (await fs.promises.exists(`${BUILD_FOLDER_IMPORT_REGISTRY}/${success.token}.json`)) {
      throw new Error("Committed OPFS manifest was not finalized");
    }

    const destination = "/user/Builds/Interrupted";
    const failing = new BuildFolderImporter({
      fs: mountedFileSystem(async path => {
        if (!path.endsWith("/second.xml")) return;
        await fs.promises.writeFile(`${destination}/unknown.txt`, encoder.encode("preserve"));
        throw new Error("browser-only injected failure");
      }),
      withLock: operation => operation(),
      liveDirectoryExists: path => fs.promises.exists(path),
      randomToken: () => "b".repeat(32),
    });
    try {
      await failing.import([
        selected("Interrupted/first.xml", "first"),
        selected("Interrupted/second.xml", "second"),
      ], "/app/user/Builds/", "");
      throw new Error("Injected OPFS failure unexpectedly committed");
    } catch (error) {
      if (error instanceof Error && error.message === "Injected OPFS failure unexpectedly committed") throw error;
    }
    const failureEntries = (await fs.promises.readdir(destination)).sort();
    if (!failureEntries.includes(BUILD_FOLDER_IMPORT_SENTINEL) || !failureEntries.includes("unknown.txt") ||
        failureEntries.includes("first.xml")) {
      throw new Error("OPFS cleanup did not preserve exactly the unowned entry and visibility marker");
    }
    const recovery = await failing.recover("/app/user/Builds/");
    return { committedBytes, failureEntries, recoveryQuarantined: recovery.quarantined };
  } finally {
    await opfs.removeEntry(ownedName, { recursive: true });
  }
}
