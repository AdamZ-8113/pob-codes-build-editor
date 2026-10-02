import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicConfig } from "./public-config.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(appDir, ".runtime");
const payloadDir = join(runtimeDir, "payload");
const releaseDir = join(runtimeDir, "import2-release");
const MAX_BYTES = 1_275 * 1024 * 1024;
const MAX_FILES = 18_500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const publicRuntime = publicConfig();
const publicDirectory = publicRuntime.basePath.slice(1);

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function fileHash(path) {
  return hash(await readFile(path));
}

async function walkFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files;
}

async function releaseFingerprint() {
  const manifest = JSON.parse(await readFile(join(payloadDir, "manifest.json"), "utf8"));
  const inputs = [
    "source-pin.json",
    "index.html",
    "src/main.ts",
    "src/style.css",
    "upstream/deno.lock",
    "upstream/vite.import2.config.ts",
    "upstream/packages/driver/dist/release/driver.mjs",
    "upstream/packages/driver/dist/release/driver.wasm",
  ];
  const identity = {
    files: Object.fromEntries(await Promise.all(inputs.map(async (path) => [path, await fileHash(join(appDir, path))]))),
    payloadManifest: await fileHash(join(payloadDir, "manifest.json")),
    payloadProvenance: await fileHash(join(payloadDir, "provenance.json")),
    packages: manifest.packages.map((entry) => entry.sha256),
    shellSources: Object.fromEntries(await Promise.all((await Promise.all([
      join(appDir, "src"),
      join(appDir, "upstream/packages/dds/src"),
      join(appDir, "upstream/packages/game/src"),
      join(appDir, "upstream/packages/driver/src/js"),
      join(appDir, "upstream/packages/driver/public"),
    ].map(walkFiles))).flat().sort().map(async (path) => [relative(appDir, path).replaceAll("\\", "/"), await fileHash(path)]))),
  };
  return hash(JSON.stringify(identity)).slice(0, 24);
}

function run(command, args, cwd = appDir, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} exited ${result.status}`);
}

async function copyPayload(target, manifest) {
  await mkdir(join(target, "packages"), { recursive: true });
  await cp(join(payloadDir, "root"), join(target, "root"), { recursive: true, force: true });
  for (const entry of manifest.packages) {
    const name = `${entry.sha256}.zip`;
    const source = join(payloadDir, "packages", name);
    if (await fileHash(source) !== entry.sha256) throw new Error(`Payload package hash mismatch: ${name}`);
    await cp(source, join(target, "packages", name));
  }
  for (const name of ["manifest.json", "provenance.json"]) await cp(join(payloadDir, name), join(target, name));
}

async function inventory(root) {
  let files = 0;
  let bytes = 0;
  let largest = { path: "", bytes: 0 };
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const size = (await stat(path)).size;
        files += 1;
        bytes += size;
        if (size > largest.bytes) largest = { path: relative(root, path).replaceAll("\\", "/"), bytes: size };
        if (size > MAX_FILE_BYTES) throw new Error(`Import2 asset exceeds 25 MiB: ${relative(root, path)} (${size} bytes)`);
      }
    }
  };
  await visit(root);
  if (files >= MAX_FILES) throw new Error(`Import2 release has ${files} files; limit is below ${MAX_FILES}`);
  if (bytes > MAX_BYTES) throw new Error(`Import2 release is ${(bytes / 1024 / 1024).toFixed(1)} MiB; limit is 1275 MiB`);
  return { files, bytes, largest };
}

export async function materializeImport2({ retainDirectory } = {}) {
  for (const required of [
    join(payloadDir, "manifest.json"),
    join(payloadDir, "provenance.json"),
    join(appDir, "upstream/packages/driver/dist/release/driver.wasm"),
  ]) {
    if (!(await exists(required))) throw new Error(`Missing Import2 build input: ${required}`);
  }
  const release = await releaseFingerprint();
  const vite = join(appDir, "upstream/node_modules/vite/bin/vite.js");
  if (!(await exists(vite))) throw new Error("Run npm run prepare:runtime first");
  run(process.execPath, [vite, "build", "--config", join(appDir, "upstream/vite.import2.config.ts")], appDir, {
    ...process.env,
    POB_IMPORT2_RELEASE: release,
  });

  const shellDir = join(runtimeDir, `import2-shell-${release}`);
  const staging = join(runtimeDir, `import2-release-${release}.next`);
  const import2Root = join(staging, publicDirectory);
  const immutableRoot = join(import2Root, "releases", release);
  await rm(staging, { recursive: true, force: true });
  await mkdir(immutableRoot, { recursive: true });
  await cp(shellDir, join(immutableRoot, "shell"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(payloadDir, "manifest.json"), "utf8"));
  await copyPayload(join(immutableRoot, "payload"), manifest);
  await mkdir(join(immutableRoot, "legal"), { recursive: true });
  await cp(join(appDir, "LICENSE"), join(immutableRoot, "legal", "LICENSE"));
  await cp(join(appDir, "THIRD_PARTY_NOTICES.md"), join(immutableRoot, "legal", "THIRD_PARTY_NOTICES.md"));
  await cp(join(appDir, "upstream", "LICENSE"), join(immutableRoot, "legal", "POB_WEB_LICENSE"));
  await cp(join(appDir, "upstream", "NOTICE.md"), join(immutableRoot, "legal", "POB_WEB_NOTICE.md"));
  await cp(join(appDir, "upstream", "PROVENANCE.md"), join(immutableRoot, "legal", "PROVENANCE.md"));
  await cp(join(shellDir, "index.html"), join(import2Root, "index.html"));

  const retained = [];
  if (retainDirectory) {
    const previous = JSON.parse(await readFile(join(retainDirectory, publicDirectory, "release.json"), "utf8"));
    if (previous.current === release) throw new Error("Retained Import2 release is the current release");
    if (!/^[a-f0-9]{24}$/.test(previous.current)) throw new Error("Retained Import2 release identity is invalid");
    await cp(
      join(retainDirectory, publicDirectory, "releases", previous.current),
      join(import2Root, "releases", previous.current),
      { recursive: true },
    );
    retained.push(previous.current);
  }

  const releaseMetadata = {
    schemaVersion: 1,
    contractVersion: 1,
    current: release,
    retained,
    predecessor: retained[0] ?? null,
    publicCommit: process.env.GITHUB_SHA ?? (() => {
      try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim(); }
      catch { return "uncommitted-snapshot"; }
    })(),
    sourceRevision: JSON.parse(await readFile(join(appDir, "source-pin.json"), "utf8")).revision,
    pobLedgerSha256: await fileHash(join(appDir, "source-pin.json")),
    binaryIdentities: {
      driverMjsSha256: await fileHash(join(appDir, "upstream/packages/driver/dist/release/driver.mjs")),
      driverWasmSha256: await fileHash(join(appDir, "upstream/packages/driver/dist/release/driver.wasm")),
    },
    payloadManifestSha256: await fileHash(join(payloadDir, "manifest.json")),
    payloadProvenanceSha256: await fileHash(join(payloadDir, "provenance.json")),
    deployment: { resource: "pob-codes-import2", route: "pob.codes/import2*", basePath: publicRuntime.basePath },
  };
  await writeFile(join(import2Root, "release.json"), `${JSON.stringify(releaseMetadata, null, 2)}\n`);
  const unavailable = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Preview unavailable</title><body><main><h1>Preview unavailable</h1><p>This private performance preview URL is unavailable. Return to <a href=\"https://pob.codes/\">PoB Codes</a>.</p></main></body></html>\n";
  await writeFile(join(staging, "404.html"), unavailable);
  await writeFile(join(import2Root, "404.html"), unavailable);
  await writeFile(join(staging, "_redirects"), `${publicRuntime.basePath} ${publicRuntime.basePath}/ 308\n`);
  await writeFile(join(staging, "_headers"), [
    "/*",
    "  X-Robots-Tag: noindex, nofollow",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "  Cross-Origin-Resource-Policy: same-origin",
    "  X-Content-Type-Options: nosniff",
    "",
    `${publicRuntime.basePath}/`,
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    `${publicRuntime.basePath}/releases/*`,
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n"));

  const inventoryFile = join(import2Root, "asset-inventory.json");
  await writeFile(inventoryFile, "{}\n");
  let measured;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    measured = await inventory(staging);
    await writeFile(inventoryFile, `${JSON.stringify({ ...measured, limits: {
      maxBytes: MAX_BYTES, maxFilesExclusive: MAX_FILES, maxFileBytes: MAX_FILE_BYTES,
    } }, null, 2)}\n`);
  }
  measured = await inventory(staging);
  await rm(releaseDir, { recursive: true, force: true });
  try {
    await rename(staging, releaseDir);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EXDEV") throw error;
    await cp(staging, releaseDir, { recursive: true });
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`Import2 release ${release}: ${measured.files} files, ${(measured.bytes / 1024 / 1024).toFixed(1)} MiB`);
  return { release, directory: releaseDir, ...measured };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const retainAt = process.argv.indexOf("--retain");
  const retainDirectory = retainAt >= 0 ? resolve(process.argv[retainAt + 1] ?? "") : undefined;
  await materializeImport2({ retainDirectory });
}
