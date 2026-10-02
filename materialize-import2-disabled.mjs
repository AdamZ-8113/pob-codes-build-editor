import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(appDir, ".runtime");
const releaseDir = join(runtimeDir, "import2-release");
const staging = join(runtimeDir, "import2-disabled.next");
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
        if (size > MAX_FILE_BYTES) throw new Error(`Import2 rollback asset exceeds 25 MiB: ${relative(root, path)}`);
      }
    }
  };
  await visit(root);
  return { files, bytes, largest };
}

export async function materializeImport2Disabled() {
  await rm(staging, { recursive: true, force: true });
  const import2Root = join(staging, "import2");
  await mkdir(join(import2Root, "releases"), { recursive: true });
  const unavailable = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex,nofollow\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Preview unavailable</title><body><main><h1>Preview unavailable</h1><p>This private performance preview is disabled. Your browser-stored builds have not been changed. Return to <a href=\"https://pob.codes/\">PoB Codes</a>.</p></main></body></html>\n";
  await writeFile(join(staging, "404.html"), unavailable);
  await writeFile(join(import2Root, "404.html"), unavailable);
  await writeFile(join(import2Root, "index.html"), unavailable);
  await writeFile(join(import2Root, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    mode: "disabled",
    current: null,
    retained: [],
  }, null, 2)}\n`);
  await writeFile(join(staging, "_redirects"), "/import2 /import2/ 308\n");
  await writeFile(join(staging, "_headers"), [
    "/*",
    "  X-Robots-Tag: noindex, nofollow",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "  Cross-Origin-Resource-Policy: same-origin",
    "  X-Content-Type-Options: nosniff",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
  ].join("\n"));
  const inventoryFile = join(import2Root, "asset-inventory.json");
  await writeFile(inventoryFile, "{}\n");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const measured = await inventory(staging);
    await writeFile(inventoryFile, `${JSON.stringify(measured, null, 2)}\n`);
  }
  const measured = await inventory(staging);
  await rm(releaseDir, { recursive: true, force: true });
  try {
    await rename(staging, releaseDir);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EXDEV") throw error;
    await cp(staging, releaseDir, { recursive: true });
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`Import2 disabled rollback: ${measured.files} files, ${measured.bytes} bytes`);
  return { directory: releaseDir, ...measured };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await materializeImport2Disabled();
}
