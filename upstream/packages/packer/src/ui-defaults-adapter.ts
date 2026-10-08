import { createHash } from "node:crypto";

const mainPath = "src/Modules/Main.lua";

function blobHash(source: string): string {
  return createHash("sha1")
    .update(`blob ${new TextEncoder().encode(source).byteLength}\0`)
    .update(source)
    .digest("hex");
}

/** Default animations off only in the packaged browser app. */
export function disableAnimationsByDefault(
  source: string,
  adapter: { sourceBlobHashes: Record<string, string>; resultBlobHashes: Record<string, string> },
): string {
  if (blobHash(source) !== adapter.sourceBlobHashes[mainPath]) {
    throw new Error("Browser UI defaults adapter: Main.lua source identity changed");
  }
  const original = "\tself.showAnimations = true";
  if (source.split(original).length !== 2) {
    throw new Error("Browser UI defaults adapter: animation default changed");
  }
  const result = source.replace(original, "\tself.showAnimations = false");
  if (blobHash(result) !== adapter.resultBlobHashes[mainPath]) {
    throw new Error("Browser UI defaults adapter: Main.lua result identity changed");
  }
  return result;
}
