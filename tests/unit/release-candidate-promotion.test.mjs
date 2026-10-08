import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverCandidateBundle, verifyReleaseCandidate } from "../../scripts/release/verify-release-candidate.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header({ path, bytes = Buffer.alloc(0), type = "0", link = "" }) {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, "utf8");
  block.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(bytes.length, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.fill(32, 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write(link, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function archive(entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? "");
    parts.push(header({ ...entry, bytes }), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

async function fixture(extraEntries = [], { archiveFileBytes } = {}) {
  const root = await mkdtemp(join(tmpdir(), "editor-candidate-test-"));
  const bundle = join(root, "bundle");
  await mkdir(join(bundle, "release-assets"), { recursive: true });
  const payload = Buffer.from("verified candidate\n");
  const generation = "a".repeat(24);
  const inventory = {
    schemaVersion: 1,
    generation,
    files: [{ path: "index.html", bytes: payload.length, sha256: digest(payload) }],
    totals: { files: 1, bytes: payload.length },
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const archiveBytes = archiveFileBytes ?? archive([
    { path: "import2-release/", type: "5" },
    { path: "import2-release/index.html", bytes: payload },
    { path: "release-inventory.json", bytes: inventoryBytes },
    ...extraEntries,
  ]);
  const archiveName = `pob-codes-build-editor-${generation}.tar.gz`;
  const archiveFile = join(bundle, "release-assets", archiveName);
  const record = {
    schemaVersion: 1,
    contractVersion: 2,
    generation,
    predecessor: null,
    publicCommit: "b".repeat(40),
    inventorySha256: digest(inventoryBytes),
    archive: { filename: archiveName, sha256: digest(archiveBytes) },
  };
  await writeFile(join(bundle, "release-inventory.json"), inventoryBytes);
  await writeFile(join(bundle, "release-record.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(archiveFile, archiveBytes);
  return { root, bundle, archiveFile, inventoryBytes, record };
}

test("candidate verifier proves the inner archive, inventory, record, and requested SHA", async t => {
  const candidate = await fixture();
  t.after(() => rm(candidate.root, { recursive: true, force: true }));
  const files = await discoverCandidateBundle(candidate.bundle);
  const verified = await verifyReleaseCandidate({ ...files, targetSha: candidate.record.publicCommit });
  assert.equal(verified.files, 1);
  assert.equal(verified.record.generation, candidate.record.generation);
  await assert.rejects(verifyReleaseCandidate({ ...files, targetSha: "c".repeat(40) }), /requested SHA/);
});

test("candidate verifier rejects changed, duplicate, traversing, linked, and unexpected archive content", async t => {
  const cases = [
    [{ path: "import2-release/index.html", bytes: "duplicate" }, /duplicate path/],
    [{ path: "../outside", bytes: "escape" }, /Unsafe candidate archive path/],
    [{ path: "import2-release/link", type: "2", link: "index.html" }, /unsupported entry type/],
    [{ path: "other.txt", bytes: "unexpected" }, /Unexpected candidate archive file/],
  ];
  for (const [entry, pattern] of cases) {
    const candidate = await fixture([entry]);
    t.after(() => rm(candidate.root, { recursive: true, force: true }));
    await assert.rejects(verifyReleaseCandidate({ ...(await discoverCandidateBundle(candidate.bundle)), targetSha: candidate.record.publicCommit }), pattern);
  }
  const candidate = await fixture();
  t.after(() => rm(candidate.root, { recursive: true, force: true }));
  await writeFile(candidate.archiveFile, Buffer.from(await readFile(candidate.archiveFile)).subarray(0, 100));
  await assert.rejects(verifyReleaseCandidate({ ...(await discoverCandidateBundle(candidate.bundle)), targetSha: candidate.record.publicCommit }), /not bound/);
});

test("candidate bundle discovery rejects missing or extra transport files", async t => {
  const candidate = await fixture();
  t.after(() => rm(candidate.root, { recursive: true, force: true }));
  await writeFile(join(candidate.bundle, "extra.txt"), "not allowed");
  await assert.rejects(discoverCandidateBundle(candidate.bundle), /must contain only/);
});
