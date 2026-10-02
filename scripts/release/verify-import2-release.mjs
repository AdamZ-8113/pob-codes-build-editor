import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicConfig } from "../lib/public-config.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const publicRuntime = publicConfig();
const publicDirectory = publicRuntime.basePath.slice(1);

export async function verifyImport2Config(configFile = join(appDir, "wrangler.import2.jsonc")) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  if (config.name !== "pob-codes-import2") throw new Error("Unexpected Import2 deployment name");
  for (const forbidden of ["main", "services", "vars", "kv_namespaces", "r2_buckets", "analytics_engine_datasets", "observability"]) {
    if (forbidden in config) throw new Error(`Scriptless Import2 config cannot contain ${forbidden}`);
  }
  if (config.assets?.binding || config.assets?.run_worker_first) throw new Error("Import2 assets cannot have a Worker binding or worker-first routes");
  if (config.assets?.not_found_handling !== "404-page") throw new Error("Import2 misses must terminate in the static 404 layer");
  if (config.routes?.length !== 1 || config.routes[0].pattern !== "pob.codes/import2*") {
    throw new Error("Import2 must own the reviewed prefix route, including query variants");
  }
  return config;
}

async function walk(root) {
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

export async function verifyImport2Release(root = join(appDir, ".runtime/import2-release"), { configFile } = {}) {
  const config = await verifyImport2Config(configFile);
  const release = JSON.parse(await readFile(join(root, publicDirectory, "release.json"), "utf8"));
  const mode = release.mode ?? "full";
  if (!Array.isArray(release.retained) || release.retained.length > 1) throw new Error("Invalid Import2 release retention metadata");
  if (mode === "full" && !/^[a-f0-9]{24}$/.test(release.current)) throw new Error("Invalid current Import2 release identity");
  if (mode === "full" && release.contractVersion !== 1) throw new Error("Unsupported Build Editor release contract");
  if (mode === "full" && release.predecessor !== (release.retained[0] ?? null)) throw new Error("Predecessor metadata does not match retained generation");
  if (mode === "full" && (!release.pobLedgerSha256 || !release.binaryIdentities?.driverWasmSha256 || !release.payloadProvenanceSha256)) throw new Error("Release identity metadata is incomplete");
  if (mode === "full" && JSON.stringify(release.publicConfig) !== JSON.stringify(publicRuntime)) throw new Error("Release public configuration does not match verification inputs");
  if (mode === "disabled" && (release.current !== null || release.retained.length !== 0)) throw new Error("Disabled Import2 release cannot retain runtime generations");
  if (!new Set(["full", "disabled"]).has(mode)) throw new Error(`Unknown Import2 release mode: ${mode}`);
  const generations = mode === "full" ? [release.current, ...release.retained].sort() : [];
  const actualGenerations = (await readdir(join(root, publicDirectory, "releases"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(actualGenerations) !== JSON.stringify(generations)) throw new Error("Import2 output contains an unowned runtime generation");

  const files = await walk(root);
  const relativeFiles = new Set(files.map((path) => relative(root, path).replaceAll("\\", "/")));
  const requiredControls = ["404.html", "_headers", "_redirects", `${publicDirectory}/404.html`, `${publicDirectory}/index.html`];
  if (mode === "full") requiredControls.push("import/index.html");
  for (const required of requiredControls) {
    if (!relativeFiles.has(required)) throw new Error(`Missing Import2 control asset: ${required}`);
  }
  for (const path of relativeFiles) {
    if (path.endsWith("root.zip") || path.endsWith(".map")) throw new Error(`Forbidden Import2 asset: ${path}`);
  }

  const index = await readFile(join(root, publicDirectory, "index.html"), "utf8");
  if (!/noindex,\s*nofollow/i.test(index)) throw new Error("Import2 pointer is indexable");
  if (mode === "full") {
    const landing = await readFile(join(root, "import/index.html"), "utf8");
    if (/noindex/i.test(landing) || !landing.includes(`${publicRuntime.siteOrigin}/import/`) || !/<noscript>/i.test(landing) || !landing.includes("/guided-import")) {
      throw new Error("Indexable /import/ landing contract is incomplete");
    }
    for (const generation of generations) {
      const generationRoot = join(root, publicDirectory, "releases", generation);
      const manifestBytes = await readFile(join(generationRoot, "payload/manifest.json"));
      if (generation === release.current && sha256(manifestBytes) !== release.payloadManifestSha256) {
        throw new Error("Import2 payload manifest identity mismatch");
      }
      const manifest = JSON.parse(manifestBytes);
      for (const entry of manifest.packages) {
        const packageFile = join(generationRoot, "payload/packages", `${entry.sha256}.zip`);
        if (sha256(await readFile(packageFile)) !== entry.sha256) throw new Error(`Import2 package identity mismatch: ${generation}/${entry.id}`);
      }
      for (const required of ["shell/index.html", "payload/provenance.json", "legal/LICENSE", "legal/THIRD_PARTY_NOTICES.md", "legal/POB_WEB_LICENSE", "legal/POB_WEB_NOTICE.md", "legal/PROVENANCE.md"]) {
        if (!relativeFiles.has(`${publicDirectory}/releases/${generation}/${required}`)) throw new Error(`Incomplete Build Editor generation: ${generation}/${required}`);
      }
      if (generation === release.current) {
        for (const required of ["legal/PATH_OF_BUILDING_LICENSE.md", "legal/PATH_OF_BUILDING_LICENSE.provenance.json"]) {
          if (!relativeFiles.has(`${publicDirectory}/releases/${generation}/${required}`)) throw new Error(`Current Build Editor generation is missing ${required}`);
        }
        const sourcePin = JSON.parse(await readFile(join(appDir, "source-pin.json"), "utf8"));
        const licenseProvenance = JSON.parse(await readFile(join(generationRoot, "legal/PATH_OF_BUILDING_LICENSE.provenance.json"), "utf8"));
        const licenseBytes = await readFile(join(generationRoot, "legal/PATH_OF_BUILDING_LICENSE.md"));
        const pinnedLicenseProvenance = JSON.parse(await readFile(join(appDir, "PATH_OF_BUILDING_LICENSE.provenance.json"), "utf8"));
        const pinnedLicenseBytes = await readFile(join(appDir, "PATH_OF_BUILDING_LICENSE.md"));
        if (licenseProvenance.revision !== sourcePin.revision ||
            JSON.stringify(licenseProvenance) !== JSON.stringify(pinnedLicenseProvenance) ||
            pinnedLicenseProvenance.sha256 !== sha256(pinnedLicenseBytes) ||
            pinnedLicenseProvenance.sha256 !== sha256(licenseBytes)) {
          throw new Error("Pinned Path of Building license provenance mismatch");
        }
      }
    }
    if (!index.includes(`${publicRuntime.basePath}/releases/${release.current}/shell/`)) throw new Error("Build Editor pointer does not target the current immutable shell");
    for (const match of index.matchAll(new RegExp(`(?:src|href)="(${publicRuntime.basePath.replaceAll("/", "\\/")}\\/[^"?#]+)`, "g"))) {
      if (!relativeFiles.has(match[1].slice(1))) throw new Error(`Import2 HTML references a missing asset: ${match[1]}`);
    }
  } else {
    if (!/Build Editor temporarily unavailable/i.test(index) || /<script\b|modulepreload/i.test(index)) {
      throw new Error("Import2 disabled page must be scriptless");
    }
  }
  const headers = await readFile(join(root, "_headers"), "utf8");
  const headerRequirements = ["Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Embedder-Policy: require-corp", "X-Robots-Tag: noindex, nofollow"];
  if (mode === "full") headerRequirements.push("max-age=31536000, immutable");
  for (const requirement of headerRequirements) {
    if (!headers.includes(requirement)) throw new Error(`Import2 headers are missing: ${requirement}`);
  }
  const redirects = await readFile(join(root, "_redirects"), "utf8");
  if (mode === "full" && !redirects.includes("/import /import/ 308")) throw new Error("Build Editor landing slash redirect is missing");
  if (!redirects.includes(`${publicRuntime.basePath} ${publicRuntime.basePath}/ 308`)) throw new Error("Build Editor slash redirect is missing");
  const scriptText = (await Promise.all(files.filter((path) => path.endsWith(".js")).map((path) => readFile(path, "utf8")))).join("\n");
  for (const forbidden of ["/local-api/", "/payload/root.zip"]) {
    if (scriptText.includes(forbidden)) throw new Error(`Import2 shell contains forbidden runtime path: ${forbidden}`);
  }
  if (publicRuntime.telemetryEndpoint && !scriptText.includes(publicRuntime.telemetryEndpoint)) {
    throw new Error("Import2 shell is missing the configured telemetry endpoint");
  }
  const totalBytes = (await Promise.all(files.map(async (path) => (await stat(path)).size))).reduce((sum, size) => sum + size, 0);
  const inventory = JSON.parse(await readFile(join(root, publicDirectory, "asset-inventory.json"), "utf8"));
  if (files.length !== inventory.files || totalBytes !== inventory.bytes) throw new Error("Import2 asset inventory is stale");
  return { config, release, files: files.length, bytes: totalBytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyImport2Release(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`Verified scriptless Import2 ${result.release.mode ?? "full"} release ${result.release.current ?? "disabled"}: ${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
}
