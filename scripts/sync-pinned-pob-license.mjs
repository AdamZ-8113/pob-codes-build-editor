import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = process.argv.find((argument) => argument.startsWith("--repository="))?.slice(13);
if (!repository) throw new Error("--repository=<local Path of Building checkout> is required");

const sourcePin = JSON.parse(await readFile(resolve(appDir, "source-pin.json"), "utf8"));
const provenanceFile = resolve(appDir, "PATH_OF_BUILDING_LICENSE.provenance.json");
const provenance = JSON.parse(await readFile(provenanceFile, "utf8"));
if (provenance.revision !== sourcePin.revision) {
  throw new Error("License provenance revision must match source-pin.json before synchronization");
}

const bytes = execFileSync("git", ["-C", resolve(repository), "show", `${sourcePin.revision}:${provenance.sourcePath}`], {
  encoding: null,
  maxBuffer: 1024 * 1024,
  windowsHide: true,
});
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== provenance.sha256) throw new Error(`Pinned Path of Building license hash mismatch: ${digest}`);
await writeFile(resolve(appDir, "PATH_OF_BUILDING_LICENSE.md"), bytes);
console.log(`Synchronized ${provenance.sourcePath} from Path of Building ${sourcePin.revision} (${digest}).`);
