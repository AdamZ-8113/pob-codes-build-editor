import AdmZip from "adm-zip";
import { Buffer } from "node:buffer";
import { packageForPath, type PayloadManifest, sha256, validatePayloadManifest } from "../../../payload-manifest.ts";

/** Preserve the pinned legacy input policy, but make future omissions explicit. */
export function sourceKind(path: string): "image" | "data" | "excluded" {
  if (path.startsWith("Export/")) return "excluded"; // Offline source-generation tools.
  packageForPath(path);
  if (/\.(png|jpg|dds\.zst)$/.test(path)) return "image";
  if (/\.(lua|zip|part\d+|jsonc?)$/.test(path)) return "data";
  // These original-packer exclusions are migration limitations, not new filters.
  if (
    /^Assets\/ascendants\/[^/]+\.jpeg$/.test(path) ||
    /^TreeData\/[^/]+\/(ascendancy|bloodline)-\d+\.webp$/.test(path)
  ) return "excluded";
  throw new Error(`Unclassified desktop source file: ${path}`);
}

export async function createPackages(
  entries: { path: string; data: Uint8Array }[],
  sourceRevision: string,
  directories: string[] = [],
) {
  const startupIds = startupPackageIds(entries);
  const groups = new Map<string, typeof entries>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error("Duplicate payload path");
    seen.add(entry.path);
    const id = packageForPath(entry.path);
    const group = groups.get(id) ?? [];
    group.push(entry);
    groups.set(id, group);
  }
  const manifest: PayloadManifest = {
    schemaVersion: 2,
    sourceRevision,
    packages: [],
    directories: [...directories].sort(),
  };
  const archives = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [id, entries] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const zip = new AdmZip();
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const e of entries) zip.addFile(e.path, Buffer.from(e.data));
    // ZIP stores local calendar fields, not UTC; use the same fields in every timezone.
    for (const e of zip.getEntries()) e.header.time = new Date(2000, 0, 1);
    const bytes = new Uint8Array(zip.toBuffer());
    const hash = await sha256(bytes);
    archives.set(hash, bytes);
    manifest.packages.push({
      id,
      startup: startupIds.has(id),
      sha256: hash,
      bytes: bytes.length,
      uncompressedBytes: entries.reduce((n, e) => n + e.data.length, 0),
      files: entries.map((e) => ({ path: e.path, bytes: e.data.length })),
    });
  }
  validatePayloadManifest(manifest);
  return { manifest, archives };
}

/** Derive the boot set from PoB's own latest-tree declaration and path classifier. */
export function startupPackageIds(entries: { path: string; data: Uint8Array }[]): Set<string> {
  const gameVersions = entries.find((entry) => entry.path === "GameVersions.lua");
  if (!gameVersions) throw new Error("GameVersions.lua is required to derive desktop startup packages");
  const source = new TextDecoder().decode(gameVersions.data);
  const list = /treeVersionList\s*=\s*\{([\s\S]*?)\}/.exec(source)?.[1];
  const versions = list ? [...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]) : [];
  const latest = versions.at(-1);
  if (!latest) throw new Error("Could not derive latestTreeVersion from GameVersions.lua");
  const available = new Set(entries.map((entry) => packageForPath(entry.path)));
  const treeId = packageForPath(`TreeData/${latest}/tree.lua`);
  if (!available.has(treeId)) {
    throw new Error(`Latest tree package is missing: ${treeId}`);
  }
  const startup = new Set(["core", treeId]);
  for (const classifiedPath of [
    "Data/TimelessJewelData/LegionPassives.lua",
    "TreeData/legion/tree-legion.lua",
  ]) {
    const id = packageForPath(classifiedPath);
    if (available.has(id)) startup.add(id);
  }
  for (const entry of entries.filter((candidate) => packageForPath(candidate.path) === "core")) {
    const source = new TextDecoder().decode(entry.data);
    for (const match of source.matchAll(/require\(["']TreeData\.([a-z0-9_]+)\./g)) {
      const id = packageForPath(`TreeData/${match[1]}/tree.lua`);
      if (!available.has(id)) throw new Error(`Core references a missing startup tree package: ${id}`);
      startup.add(id);
    }
  }
  return startup;
}

