import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileSha256, jsonBytes } from "./release-common.mjs";

const value = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const archive = resolve(value("archive") ?? (() => { throw new Error("--archive is required"); })());
const archiveAssetId = value("archive-asset-id");
const inventoryAssetId = value("inventory-asset-id");
if (!/^\d+$/.test(archiveAssetId ?? "") || !/^\d+$/.test(inventoryAssetId ?? "")) throw new Error("Numeric archive and inventory asset IDs are required");
const recordFile = resolve(value("record") ?? ".runtime/release-record.json");
const record = JSON.parse(await readFile(recordFile, "utf8"));
record.archive = {
  assetId: Number(archiveAssetId),
  inventoryAssetId: Number(inventoryAssetId),
  fileName: archive.split(/[\\/]/).at(-1),
  sha256: await fileSha256(archive),
  format: "tar+gzip",
};
await writeFile(recordFile, jsonBytes(record));
console.log(`Finalized release record for archive asset ${archiveAssetId}.`);
