import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { scanPublicBoundary } from "../../scripts/check-public-boundary.mjs";
import { publicFileInventory } from "../../scripts/lib/public-files.mjs";

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

test("public boundary scan rejects personal home-directory paths without flagging URLs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-editor-home-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = join(root, "notes.md");
  // Assemble paths at runtime so this public test file holds no literal home path.
  for (const path of [["C:", "Users", "someone", "repo"].join("\\"), ["", "c", "Users", "someone", "repo"].join("/"), ["", "home", "someone", "repo"].join("/")]) {
    await writeFile(notes, `Built from ${path}\n`);
    assert.match(scanPublicBoundary(root).join("\n"), /^notes\.md: /u, path);
  }
  await writeFile(notes, "See https://example.com/home/page/ and https://api.github.com/users/someone/repos\n");
  assert.deepEqual(scanPublicBoundary(root), []);
});

test("Git boundary excludes local state, scans new public inputs, and rejects force-added local files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-editor-git-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, stdio: "pipe" });
  git("init");
  await writeFile(join(root, ".gitignore"), "private/\n");
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private/unfinished.mjs"), "unfinished module syntax (");
  await writeFile(join(root, "public.mjs"), "export const ready = true;\n");
  git("add", ".gitignore", "public.mjs");
  await writeFile(join(root, "new public.mjs"), "export const added = true;\n");
  assert.deepEqual(publicFileInventory(root).files, [".gitignore", "new public.mjs", "public.mjs"]);
  assert.deepEqual(scanPublicBoundary(root), []);

  await mkdir(join(root, "fixtures"));
  const fixture = join(root, "fixtures/new build.txt");
  await writeFile(fixture, encode('<PathOfBuilding><Import lastAccountHash="sensitive"/></PathOfBuilding>'));
  assert.deepEqual(scanPublicBoundary(root), ["fixtures/new build.txt: decoded fixture contains account/character hash fields"]);
  await writeFile(fixture, encode("<PathOfBuilding><Import/></PathOfBuilding>"));

  git("add", "-f", "private/unfinished.mjs");
  assert.deepEqual(scanPublicBoundary(root), ["private/unfinished.mjs: tracked file matches local ignore rules"]);
});
