import { createHash } from "node:crypto";
import { parseDriftPatch, transformDriftPatch } from "../build/drift-patch.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const blobHash = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

export function transformTreeConnectorCullingPatch(source, patch, path) {
  const sections = parseDriftPatch(patch.toString()).filter(section => section.path === path);
  if (sections.length !== 1) throw new Error("Tree connector culling patch inventory changed");
  return transformDriftPatch({ [path]: source }, sections)[path];
}

export function applyTreeConnectorCullingPatch(source, patch, pin, path) {
  if (sha256(patch) !== pin.patchSha256 || blobHash(source) !== pin.sourceBlobHashes[path]) {
    throw new Error("Tree connector culling patch/source identity changed");
  }
  const result = transformTreeConnectorCullingPatch(source, patch, path);
  if (blobHash(result) !== pin.resultBlobHashes[path]) throw new Error("Tree connector culling result identity changed");
  return result;
}
