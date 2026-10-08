import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { disableAnimationsByDefault } from "../../upstream/packages/packer/src/ui-defaults-adapter.ts";

const pin = JSON.parse(await readFile("source-pin.json", "utf8"));
const sourcePath = `.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/src/Modules/Main.lua`;
const source = await readFile(sourcePath, "utf8").catch(() => null);

test("browser package defaults Show Animations off without changing saved-setting behavior", { skip: source === null }, () => {
  const result = disableAnimationsByDefault(source, pin.adapters.browserUiDefaults);
  assert.match(result, /\tself\.showAnimations = false/);
  assert.doesNotMatch(result, /\tself\.showAnimations = true/);
  assert.match(result, /self\.showAnimations = node\.attrib\.showAnimations == "true"/);
  assert.match(result, /controls\.showAnimations\.state = self\.showAnimations/);
  assert.throws(() => disableAnimationsByDefault(`${source}\n`, pin.adapters.browserUiDefaults), /source identity changed/);
  assert.throws(() => disableAnimationsByDefault(result, pin.adapters.browserUiDefaults), /source identity changed/);
});
