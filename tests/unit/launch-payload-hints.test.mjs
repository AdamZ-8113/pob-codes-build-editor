import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { payloadHintsForBuildCode, payloadHintsForXml } from "../../src/launch-payload-hints.ts";

const xml = `<?xml version="1.0"?><PathOfBuilding>
<Build level="100" className="Marauder"/>
<Tree activeSpec="1"><Spec treeVersion="3_25" nodes="1,2"/><Spec treeVersion="3_29" nodes="3"/></Tree>
<Notes>Glorious Vanity would be nice</Notes>
<Items><Item id="1">Rarity: UNIQUE
Lethal Pride
Timeless Jewel</Item></Items>
</PathOfBuilding>`;

test("hints tree versions and timeless tables named in item text only", () => {
  assert.deepEqual(payloadHintsForXml(xml), [
    "/TreeData/3_25/",
    "/TreeData/3_29/",
    "/Data/TimelessJewelData/LethalPride.zip",
  ]);
});

test("ignores malformed tree versions and builds without items", () => {
  assert.deepEqual(payloadHintsForXml('<Spec treeVersion="../x"/><Notes>Lethal Pride</Notes>'), []);
});

test("decodes a URL-safe build code before hinting", async () => {
  const code = deflateSync(Buffer.from(xml)).toString("base64url");
  assert.deepEqual(await payloadHintsForBuildCode(code), payloadHintsForXml(xml));
});

test("rejects input that is not a compressed build", async () => {
  await assert.rejects(payloadHintsForBuildCode("bm90LWEtYnVpbGQtY29kZQ"));
});
