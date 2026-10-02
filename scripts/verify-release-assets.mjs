import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const numericId = (value, name) => {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`${name} must be a numeric GitHub Release asset ID`);
  return Number(value);
};

export function bindPredecessorAssets(release, { tag, archiveAssetId, inventoryAssetId }) {
  if (release.tag_name !== tag) throw new Error("GitHub Release tag metadata does not match the requested predecessor tag");
  const byId = new Map((release.assets ?? []).map((asset) => [asset.id, asset]));
  const archive = byId.get(numericId(archiveAssetId, "archive asset ID"));
  const inventory = byId.get(numericId(inventoryAssetId, "inventory asset ID"));
  const records = (release.assets ?? []).filter((asset) => asset.name === "release-record.json");
  if (!archive || !archive.name.endsWith(".tar.gz")) throw new Error("Archive asset ID is not a tar.gz asset of the requested GitHub Release");
  if (!inventory || inventory.name !== "release-inventory.json") throw new Error("Inventory asset ID is not release-inventory.json of the requested GitHub Release");
  if (records.length !== 1 || !Number.isInteger(records[0].id)) throw new Error("Requested GitHub Release must contain exactly one release-record.json asset");
  if (new Set([archive.id, inventory.id, records[0].id]).size !== 3) throw new Error("Predecessor recovery assets must have distinct GitHub asset IDs");
  return { archive, inventory, record: records[0] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const metadataFile = resolve(value("metadata") ?? (() => { throw new Error("--metadata is required"); })());
  const bound = bindPredecessorAssets(JSON.parse(await readFile(metadataFile, "utf8")), {
    tag: value("tag"),
    archiveAssetId: value("archive-asset-id"),
    inventoryAssetId: value("inventory-asset-id"),
  });
  process.stdout.write(String(bound.record.id));
}
