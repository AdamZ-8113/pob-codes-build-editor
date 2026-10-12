import { assert, assertEquals, assertRejects } from "@std/assert";
import { configure, fs, InMemory } from "@zenfs/core";
import {
  allocateFolderName,
  BUILD_FOLDER_IMPORT_REGISTRY,
  BUILD_FOLDER_IMPORT_SENTINEL,
  BuildFolderImporter,
  BuildFolderImportError,
  LocalUserStorageLock,
  mapNativeBuildRoot,
  planBuildFolderImport,
  splitRelativePath,
  type BuildFolderImportFile,
  type BuildFolderImportFileSystem,
} from "../../src/js/build-folder-import.ts";

function selected(path: string, contents = path): BuildFolderImportFile {
  const bytes = new TextEncoder().encode(contents);
  return {
    name: path.split("/").at(-1)!,
    size: bytes.length,
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function selectedSize(path: string, size: number): BuildFolderImportFile {
  return {
    name: path.split("/").at(-1)!,
    size,
    webkitRelativePath: path,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function zenFileSystem(intercept?: (path: string, data: Uint8Array) => Promise<void>): BuildFolderImportFileSystem {
  return {
    exists: path => fs.promises.exists(path),
    mkdir: async path => { await fs.promises.mkdir(path); },
    readdir: path => fs.promises.readdir(path),
    readFile: async path => new Uint8Array(await fs.promises.readFile(path)),
    writeFile: async (path, data, exclusive = false) => {
      await intercept?.(path, data);
      await fs.promises.writeFile(path, data, { flag: exclusive ? "wx" : "w" });
    },
    unlink: async path => { await fs.promises.unlink(path); },
    rmdir: async path => { await fs.promises.rmdir(path); },
  };
}

async function fixtureRoot() {
  await configure({ mounts: { "/": InMemory } });
  await fs.promises.mkdir("/user/Path of Building/Builds/Ruthless", { recursive: true });
}

Deno.test("folder selection validates one safe root and exact lower-case XML files", () => {
  const plan = planBuildFolderImport([
    selected("League Builds/one.xml"),
    selected("League Builds/Nested/two.xml"),
    selected("League Builds/ignored.XML"),
    selected("League Builds/notes.txt"),
  ]);
  assertEquals(plan.rootName, "League Builds");
  assertEquals(plan.files.map(file => file.relativePath), ["one.xml", "Nested/two.xml"]);
  assertEquals(plan.ignoredCount, 2);
  for (const path of ["/absolute/file.xml", "Root/../file.xml", "Root\\file.xml", "Root//file.xml", "Root/./file.xml", "Root/a\0.xml"]) {
    assertRejects(async () => planBuildFolderImport([selected(path)]), BuildFolderImportError);
  }
  assertRejects(async () => planBuildFolderImport([selected("A/a.xml"), selected("B/b.xml")]), BuildFolderImportError);
  assertRejects(async () => planBuildFolderImport([selected("A/a.XML")]), BuildFolderImportError);
  assertEquals(splitRelativePath("Nested/Build.xml"), ["Nested", "Build.xml"]);
});

Deno.test("folder selection enforces the measured file and memory guardrails", () => {
  const atFileCap = Array.from({ length: 500 }, (_, index) => selected(`Root/${index}.xml`));
  assertEquals(planBuildFolderImport(atFileCap).files.length, 500);
  assertRejects(
    async () => planBuildFolderImport([...atFileCap, selected("Root/overflow.xml")]),
    BuildFolderImportError,
  );
  assertRejects(
    async () => planBuildFolderImport([selectedSize("Root/large.xml", 32 * 1024 * 1024 + 1)]),
    BuildFolderImportError,
  );
  assertRejects(
    async () => planBuildFolderImport([
      selectedSize("Root/one.xml", 64 * 1024 * 1024 + 1),
      selectedSize("Root/two.xml", 64 * 1024 * 1024),
    ], { files: 500, fileBytes: 128 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 }),
    BuildFolderImportError,
  );
});

Deno.test("native build paths map only into local user storage", () => {
  assertEquals(
    mapNativeBuildRoot("/app/user/Path of Building/Builds/", "Ruthless/"),
    "/user/Path of Building/Builds/Ruthless",
  );
  for (const path of ["/app/root/Builds/", "/tmp/Builds/", "/app/user/../root/", "/app/user//Builds/"]) {
    assertRejects(async () => mapNativeBuildRoot(path, ""), BuildFolderImportError);
  }
  assertRejects(
    async () => mapNativeBuildRoot("/app/user/Path of Building/Builds/Cloud/", "", "/user/Path of Building/Builds/Cloud"),
    BuildFolderImportError,
  );
});

Deno.test("import reserves suffixes, preserves bytes, and finalizes its private manifest", async () => {
  await fixtureRoot();
  await fs.promises.mkdir("/user/Path of Building/Builds/Ruthless/League Builds");
  const importer = new BuildFolderImporter({
    fs: zenFileSystem(),
    withLock: operation => operation(),
    liveDirectoryExists: path => fs.promises.exists(path),
    randomToken: () => "1".repeat(32),
  });
  const result = await importer.import([
    selected("League Builds/one.xml", "one"),
    selected("League Builds/Nested/two.xml", "two"),
    selected("League Builds/readme.txt", "ignored"),
  ], "/app/user/Path of Building/Builds/", "Ruthless/");
  assertEquals(result.folderName, "League Builds[2]");
  assertEquals(result.logicalDestination, "Builds > Ruthless > League Builds[2]");
  assertEquals(new TextDecoder().decode(await fs.promises.readFile(
    "/user/Path of Building/Builds/Ruthless/League Builds[2]/Nested/two.xml",
  )), "two");
  assertEquals(await fs.promises.exists(
    `/user/Path of Building/Builds/Ruthless/League Builds[2]/${BUILD_FOLDER_IMPORT_SENTINEL}`,
  ), false);
  assert(await fs.promises.exists(`${BUILD_FOLDER_IMPORT_REGISTRY}/${result.token}.json`));
  await importer.finalize(result.token);
  assertEquals(await fs.promises.exists(`${BUILD_FOLDER_IMPORT_REGISTRY}/${result.token}.json`), false);
});

Deno.test("failed imports retain unknown entries behind the ownership marker", async () => {
  await fixtureRoot();
  const destination = "/user/Path of Building/Builds/Interrupted";
  const importer = new BuildFolderImporter({
    fs: zenFileSystem(async path => {
      if (path.endsWith("/second.xml")) {
        await fs.promises.writeFile(`${destination}/unknown.txt`, "preserve");
        throw new Error("injected test failure");
      }
    }),
    withLock: operation => operation(),
    liveDirectoryExists: path => fs.promises.exists(path),
    randomToken: () => "2".repeat(32),
  });
  await assertRejects(
    () => importer.import([
      selected("Interrupted/first.xml"),
      selected("Interrupted/second.xml"),
    ], "/app/user/Path of Building/Builds/", ""),
    BuildFolderImportError,
  );
  assert(await fs.promises.exists(`${destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`));
  assert(await fs.promises.exists(`${destination}/unknown.txt`));
  const recovered = await importer.recover("/app/user/Path of Building/Builds/");
  assertEquals(recovered.quarantined, 1);
  assert(await fs.promises.exists(`${destination}/unknown.txt`));
});

Deno.test("reservation and marker failures never overwrite or expose owned partial data", async () => {
  await fixtureRoot();
  const buildRoot = "/user/Path of Building/Builds/Ruthless";
  await fs.promises.mkdir(`${buildRoot}/Race`);
  await fs.promises.writeFile(`${buildRoot}/Race/keep.xml`, "keep");
  const staleLookup = new BuildFolderImporter({
    fs: zenFileSystem(),
    withLock: operation => operation(),
    liveDirectoryExists: async () => false,
    randomToken: () => "6".repeat(32),
  });
  await assertRejects(
    () => staleLookup.import([selected("Race/new.xml")], "/app/user/Path of Building/Builds/", "Ruthless/"),
    BuildFolderImportError,
  );
  assertEquals(new TextDecoder().decode(await fs.promises.readFile(`${buildRoot}/Race/keep.xml`)), "keep");
  assertEquals(await fs.promises.exists(`${buildRoot}/Race/new.xml`), false);
  assertEquals(await fs.promises.readdir(BUILD_FOLDER_IMPORT_REGISTRY), []);

  const markerFailure = new BuildFolderImporter({
    fs: zenFileSystem(async path => {
      if (path.endsWith(`/${BUILD_FOLDER_IMPORT_SENTINEL}`)) throw new Error("marker unavailable");
    }),
    withLock: operation => operation(),
    liveDirectoryExists: path => fs.promises.exists(path),
    randomToken: () => "7".repeat(32),
  });
  await assertRejects(
    () => markerFailure.import([selected("Marker Failure/build.xml")], "/app/user/Path of Building/Builds/", "Ruthless/"),
    BuildFolderImportError,
  );
  assertEquals(await fs.promises.exists(`${buildRoot}/Marker Failure`), false);
  assertEquals(await fs.promises.readdir(BUILD_FOLDER_IMPORT_REGISTRY), []);
});

Deno.test("ready recovery reveals a complete folder and mismatched tokens quarantine", async () => {
  await fixtureRoot();
  const destination = "/user/Path of Building/Builds/Ready";
  const token = "3".repeat(32);
  await fs.promises.mkdir(BUILD_FOLDER_IMPORT_REGISTRY);
  await fs.promises.mkdir(destination);
  await fs.promises.writeFile(`${destination}/build.xml`, "build");
  await fs.promises.writeFile(`${destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`, token);
  await fs.promises.writeFile(`${BUILD_FOLDER_IMPORT_REGISTRY}/${token}.json`, JSON.stringify({
    version: 1, token, buildRoot: "/user/Path of Building/Builds", destination,
    files: ["build.xml"], state: "ready",
  }));
  const importer = new BuildFolderImporter({
    fs: zenFileSystem(), withLock: operation => operation(),
    liveDirectoryExists: path => fs.promises.exists(path), randomToken: () => "4".repeat(32),
  });
  assertEquals(await importer.recover("/app/user/Path of Building/Builds/"), {
    revealed: 1, cleaned: 0, quarantined: 0,
  });
  assertEquals(await fs.promises.exists(`${destination}/${BUILD_FOLDER_IMPORT_SENTINEL}`), false);

  const badDestination = "/user/Path of Building/Builds/Mismatch";
  await fs.promises.mkdir(badDestination);
  await fs.promises.writeFile(`${badDestination}/${BUILD_FOLDER_IMPORT_SENTINEL}`, "5".repeat(32));
  await fs.promises.writeFile(`${BUILD_FOLDER_IMPORT_REGISTRY}/${token}.json`, JSON.stringify({
    version: 1, token, buildRoot: "/user/Path of Building/Builds", destination: badDestination,
    files: ["missing.xml"], state: "writing",
  }));
  assertEquals((await importer.recover("/app/user/Path of Building/Builds/")).quarantined, 1);
  assert(await fs.promises.exists(badDestination));
});

Deno.test("live suffix allocation and the shared lock serialize concurrent operations", async () => {
  const allocated = await allocateFolderName("Builds", "/root", async path => path === "/root/Builds");
  assertEquals(allocated, "Builds[2]");
  let tail = Promise.resolve();
  const manager = {
    request: async <T>(_name: string, _options: { mode: "exclusive" }, callback: () => Promise<T>) => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await before;
      try { return await callback(); } finally { release(); }
    },
  };
  const lock = new LocalUserStorageLock(manager);
  const order: string[] = [];
  await Promise.all([
    lock.run(async () => { order.push("first-start"); await Promise.resolve(); order.push("first-end"); }),
    lock.run(async () => { order.push("second-start"); order.push("second-end"); }),
  ]);
  assertEquals(order, ["first-start", "first-end", "second-start", "second-end"]);
});
