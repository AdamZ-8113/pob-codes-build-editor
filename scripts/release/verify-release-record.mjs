import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileSha256, inventoryFiles, jsonBytes, sha256 } from "./release-common.mjs";

const value = (name, fallback) => resolve(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const root = value("root", ".runtime/import2-release");
const recordFile = value("record", ".runtime/release-record.json");
const inventoryFile = value("inventory", ".runtime/release-inventory.json");
const record = JSON.parse(await readFile(recordFile, "utf8"));
const inventoryBytes = await readFile(inventoryFile);
const inventory = JSON.parse(inventoryBytes);
if (record.inventorySha256 !== sha256(inventoryBytes)) throw new Error("Release inventory hash does not match the release record");
if (inventory.generation !== record.generation) throw new Error("Release generation and inventory disagree");
if (record.deployment.configSha256 !== await fileSha256("wrangler.import2.jsonc")) throw new Error("Deployment configuration differs from the release record");
if (![1, 2].includes(record.contractVersion)) throw new Error("Unsupported release-record contract version");
if (record.contractVersion >= 2 &&
    (record.pob?.license?.sha256 !== await fileSha256("PATH_OF_BUILDING_LICENSE.md") ||
     record.pob?.license?.provenanceSha256 !== await fileSha256("PATH_OF_BUILDING_LICENSE.provenance.json"))) {
  throw new Error("Pinned Path of Building license differs from the release record");
}
const actual = await inventoryFiles(root);
if (JSON.stringify(actual) !== JSON.stringify(inventory.files)) throw new Error("Release file inventory is incomplete or contains changed bytes");
const release = JSON.parse(await readFile(join(root, "import2/release.json"), "utf8"));
if (release.current !== record.generation || (release.retained[0] ?? null) !== record.predecessor) throw new Error("Release pointer metadata disagrees with the release record");
if (record.contractVersion >= 2) {
  const currentLegal = join(root, "import2/releases", record.generation, "legal");
  if (record.pob.license.sha256 !== await fileSha256(join(currentLegal, "PATH_OF_BUILDING_LICENSE.md")) ||
      record.pob.license.provenanceSha256 !== await fileSha256(join(currentLegal, "PATH_OF_BUILDING_LICENSE.provenance.json"))) {
    throw new Error("Deployable Path of Building license differs from the release record");
  }
}
if (record.archive) {
  const archive = process.argv.find((arg) => arg.startsWith("--archive="))?.slice(10);
  if (archive && record.archive.sha256 !== await fileSha256(resolve(archive))) throw new Error("Release archive hash mismatch");
}
console.log(`Verified complete release record ${record.generation} (${actual.length} files).`);
