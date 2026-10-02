import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { scanPublicBoundary } from "./scripts/check-public-boundary.mjs";

const encode = (xml) => deflateSync(Buffer.from(xml)).toString("base64url");

test("public boundary scan decodes build fixtures and rejects identifying hash fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-editor-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "fixtures"), { recursive: true });
  const fixture = join(root, "fixtures/build.txt");
  await writeFile(fixture, `${encode('<PathOfBuilding><Import lastAccountHash="sensitive" lastCharacterHash="also-sensitive"/></PathOfBuilding>')}\n`);
  assert.deepEqual(scanPublicBoundary(root).map((value) => value.replaceAll("\\", "/")), ["fixtures/build.txt: decoded fixture contains account/character hash fields"]);
  await writeFile(fixture, `${encode("<PathOfBuilding><Import/></PathOfBuilding>")}\n`);
  assert.deepEqual(scanPublicBoundary(root), []);
});
