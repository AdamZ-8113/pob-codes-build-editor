import { createHash } from "node:crypto";

const mainPath = "src/Modules/Main.lua";

function blobHash(source: string): string {
  return createHash("sha1")
    .update(`blob ${new TextEncoder().encode(source).byteLength}\0`)
    .update(source)
    .digest("hex");
}

/** Apply browser-only UI defaults and repair desktop-only saved paths. */
export function disableAnimationsByDefault(
  source: string,
  adapter: { sourceBlobHashes: Record<string, string>; resultBlobHashes: Record<string, string> },
): string {
  if (blobHash(source) !== adapter.sourceBlobHashes[mainPath]) {
    throw new Error("Browser UI defaults adapter: Main.lua source identity changed");
  }
  const result = transformBrowserUiDefaults(source);
  const resultHash = blobHash(result);
  if (resultHash !== adapter.resultBlobHashes[mainPath]) {
    throw new Error(`Browser UI defaults adapter: Main.lua result identity changed (expected ${adapter.resultBlobHashes[mainPath]}, received ${resultHash})`);
  }
  return result;
}

/** Exact-anchor transform for candidate identity generation; packing stays hash checked. */
export function transformBrowserUiDefaults(source: string): string {
  const original = "\tself.showAnimations = true";
  if (source.split(original).length !== 2) {
    throw new Error("Browser UI defaults adapter: animation default changed");
  }
  const loadSettings = "\tself:LoadSettings(ignoreBuild)\n\tself:LoadSharedItems()";
  if (source.split(loadSettings).length !== 2) {
    throw new Error("Browser UI defaults adapter: settings load sequence changed");
  }
  const onFrame = "function main:OnFrame()\n\tself.screenW, self.screenH = GetVirtualScreenSize()";
  if (source.split(onFrame).length !== 2) {
    throw new Error("Browser UI defaults adapter: frame entry changed");
  }
  const repairBuildPath = `\tself:LoadSettings(ignoreBuild)
\tlocal browserStorageMounted = type(self.userPath) == "string" and self.userPath:sub(1, 10) == "/app/user/"
\tif browserStorageMounted then
\t\tlocal browserBuildPathValid = type(self.buildPath) == "string"
\t\t\tand #self.buildPath > 10
\t\t\tand self.buildPath:sub(1, 10) == "/app/user/"
\t\t\tand not self.buildPath:find("\\\\", 1, true)
\t\t\tand not self.buildPath:find("//", 1, true)
\t\t\tand not self.buildPath:find("%c")
\t\tif browserBuildPathValid then
\t\t\tfor segment in self.buildPath:gmatch("[^/]+") do
\t\t\t\tif segment == "." or segment == ".." then
\t\t\t\t\tbrowserBuildPathValid = false
\t\t\t\t\tbreak
\t\t\t\tend
\t\t\tend
\t\tend
\t\tif not browserBuildPathValid then
\t\t\tself.buildPath = self.defaultBuildPath
\t\t\tself.browserBuildPathNeedsSave = true
\t\tend
\tend
\tself:LoadSharedItems()`;
  const persistBuildPath = `function main:OnFrame()
\tif self.browserBuildPathNeedsSave and self.mode then
\t\tself.browserBuildPathNeedsSave = nil
\t\tself:SaveSettings()
\tend
\tself.screenW, self.screenH = GetVirtualScreenSize()`;
  const result = source
    .replace(original, "\tself.showAnimations = false")
    .replace(loadSettings, repairBuildPath)
    .replace(onFrame, persistBuildPath);
  return result;
}
