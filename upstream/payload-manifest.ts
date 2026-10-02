export type PayloadPackage = {
  id: string;
  startup: boolean;
  sha256: string;
  bytes: number;
  uncompressedBytes: number;
  files: { path: string; bytes: number }[];
};
export type PayloadManifest = {
  schemaVersion: 1 | 2;
  sourceRevision: string;
  packages: PayloadPackage[];
  directories?: string[];
};

export function packageForPath(path: string): string {
  if (
    !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    throw new Error("Invalid payload path");
  }
  const tree = /^TreeData\/([^/]+)\//.exec(path);
  if (tree) {
    if (!/^\d+_\d+(?:_ruthless)?(?:_alternate)?$/.test(tree[1]) && tree[1] !== "legion") {
      throw new Error("Unknown tree family");
    }
    return `tree-${tree[1]}`;
  }
  if (path === "Data/TimelessJewelData/AbyssRecords/index.json") return "core";
  const abyssRecord = /^Data\/TimelessJewelData\/AbyssRecords\/(7|8|9|10|11)-(\d+)-(\d+)\.bin$/.exec(path);
  if (abyssRecord) return `abyss-${abyssRecord[1]}-${abyssRecord[2]}-${abyssRecord[3]}`;
  if (path.startsWith("Data/TimelessJewelData/AbyssRecords/")) throw new Error("Unknown Abyss record path");
  if (path.startsWith("Data/TimelessJewelData/")) {
    const file = path.slice("Data/TimelessJewelData/".length);
    if (
      /\.(zip|part\d+)$/.test(file) &&
      !/^(?:BrutalRestraint|ElegantHubris|GloriousVanity|HeroicTragedy|LethalPride|MilitantFaith|Abyss(?:Amanamu|Kurgal|Tecrod|Ulaman|Zorath))\.zip(?:\.part\d+)?$/
        .test(file)
    ) {
      throw new Error("Unknown Timeless family");
    }
    return /\.(zip|part\d+)$/.test(path)
      ? `timeless-${path.split("/").at(-1)!.replaceAll(".", "-").toLowerCase()}`
      : "timeless-shared";
  }
  const roots = new Set(["Assets", "Classes", "Data", "Modules", "TreeData", "lua"]);
  const files = new Set([
    ".image.tsv",
    "GameVersions.lua",
    "HeadlessWrapper.lua",
    "LICENSE.md",
    "Launch.lua",
    "LaunchInstall.lua",
    "LaunchServer.lua",
    "UpdateApply.lua",
    "UpdateCheck.lua",
    "_SimpleGraphic.def.lua",
    "changelog.txt",
    "help.txt",
    "installed.cfg",
    "manifest.xml",
  ]);
  if (!(path.includes("/") ? roots.has(path.split("/")[0]) : files.has(path))) {
    throw new Error("Unclassified payload path");
  }
  return "core";
}

/** Only hashes owned by the older generation and absent from both retained generations. */
export function stalePackageHashes(
  current: PayloadManifest,
  previous?: PayloadManifest,
  predecessor?: PayloadManifest,
): string[] {
  for (const m of [current, previous, predecessor]) if (m) validatePayloadManifest(m);
  const retained = new Set([...current.packages, ...(previous?.packages ?? [])].map((p) => p.sha256));
  return [...new Set((predecessor?.packages ?? []).map((p) => p.sha256))].filter((hash) => !retained.has(hash));
}

export function validatePayloadManifest(value: unknown): PayloadManifest {
  const m = value as PayloadManifest;
  if (
    !m || ![1, 2].includes(m.schemaVersion) || !/^[a-f0-9]{40}$/.test(m.sourceRevision) || !Array.isArray(m.packages) ||
    !m.packages.length
  ) {
    throw new Error("Unsupported desktop payload manifest");
  }
  const paths = new Set<string>(), ids = new Set<string>();
  for (const p of m.packages) {
    if (
      !p || !/^[a-z0-9_-]+$/.test(p.id) || ids.has(p.id) || !/^[a-f0-9]{64}$/.test(p.sha256) ||
      !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || !Array.isArray(p.files) || !p.files.length ||
      (m.schemaVersion === 2 && typeof p.startup !== "boolean")
    ) throw new Error("Invalid payload package");
    ids.add(p.id);
    let total = 0;
    for (const f of p.files) {
      if (
        !f || typeof f.path !== "string" || packageForPath(f.path) !== p.id || paths.has(f.path) ||
        !Number.isSafeInteger(f.bytes) || f.bytes < 0
      ) throw new Error("Invalid payload membership");
      paths.add(f.path);
      total += f.bytes;
    }
    if (!Number.isSafeInteger(total) || total !== p.uncompressedBytes) throw new Error("Invalid payload size");
  }
  if (!ids.has("core")) throw new Error("Missing core payload");
  if (m.directories !== undefined) {
    if (!Array.isArray(m.directories)) throw new Error("Invalid payload directories");
    const directories = new Set<string>();
    for (const directory of m.directories) {
      if (typeof directory !== "string" || directories.has(directory) || paths.has(directory)) {
        throw new Error("Invalid payload directory");
      }
      packageForPath(directory + "/__directory__");
      directories.add(directory);
      const parts = directory.split("/");
      while (parts.pop() && parts.length) {
        if (paths.has(parts.join("/"))) throw new Error("Payload file/directory collision");
      }
    }
  }
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.pop() && parts.length) {
      if (paths.has(parts.join("/"))) throw new Error("Payload file/directory collision");
    }
  }
  return {
    ...m,
    packages: m.packages.map((p) => ({ ...p, startup: m.schemaVersion === 1 ? true : p.startup })),
  };
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

