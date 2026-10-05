import { createHash } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const blobHash = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

export function applyPreferredExportSitePatch(source, patch, pin) {
  const path = "src/Classes/ImportTab.lua";
  if (sha256(patch) !== pin.patchSha256 || blobHash(source) !== pin.sourceBlobHashes[path]) {
    throw new Error("Preferred export-site input mismatch");
  }
  const result = transformPreferredExportSitePatch(source, patch);
  if (blobHash(result) !== pin.resultBlobHashes[path]) throw new Error("Preferred export-site result mismatch");
  return result;
}

export function transformPreferredExportSitePatch(source, patch) {
  const text = patch.toString().replaceAll("\r\n", "\n");
  const hunks = text.split(/^@@[^\n]*@@[^\n]*\n/m).slice(1);
  if (hunks.length !== 1) throw new Error("Preferred export-site patch changed");
  const lines = hunks[0].trimEnd().split("\n");
  const before = lines.filter(line => line[0] !== "+").map(line => line.slice(1)).join("\n") + "\n";
  const after = lines.filter(line => line[0] !== "-").map(line => line.slice(1)).join("\n") + "\n";
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + 1) >= 0) throw new Error("Preferred export-site context mismatch");
  const result = source.slice(0, at) + after + source.slice(at + before.length);
  return result;
}
