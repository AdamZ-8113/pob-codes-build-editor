import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

test("candidate record binds the exact exported archive before public upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "editor-archive-test-"));
  try {
    await mkdir(join(root, ".runtime/import2-release"), { recursive: true });
    await writeFile(join(root, ".runtime/import2-release/404.html"), "example");
    await writeFile(join(root, ".runtime/release-inventory.json"), "{}");
    await writeFile(join(root, ".runtime/release-record.json"), JSON.stringify({ generation: "a".repeat(24), archive: null }));
    const result = spawnSync(process.execPath, [resolve("scripts/release/archive-release.mjs")], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(await readFile(join(root, ".runtime/release-record.json"), "utf8"));
    const bytes = await readFile(join(root, ".runtime/release-assets", record.archive.filename));
    assert.equal(record.archive.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(record.archive.filename, `pob-codes-build-editor-${"a".repeat(24)}.tar.gz`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
