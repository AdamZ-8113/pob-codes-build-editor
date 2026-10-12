import { createHash } from "node:crypto";
import { parseDriftPatch, transformDriftPatch } from "../build/drift-patch.mjs";

const path = "src/Classes/TreeTab.lua";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const blobHash = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

export function transformPowerNodeDepthPatch(source, patch) {
  const sections = parseDriftPatch(patch.toString()).filter(section => section.path === path);
  if (sections.length !== 1) throw new Error("Power-node depth patch inventory changed");
  return transformDriftPatch({ [path]: source }, sections)[path];
}

export function applyPowerNodeDepthPatch(source, patch, pin) {
  if (sha256(patch) !== pin.patchSha256 || blobHash(source) !== pin.sourceBlobHashes[path]) {
    throw new Error("Power-node depth patch/source identity changed");
  }
  const result = transformPowerNodeDepthPatch(source, patch);
  if (blobHash(result) !== pin.resultBlobHashes[path]) throw new Error("Power-node depth result identity changed");
  return result;
}
