import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { applyRuntime, discoverRuntime, parseArgs, printPlan } from "../../scripts/clean-runtime.mjs";

const current = "a".repeat(24);
const retained = "b".repeat(24);
const predecessor = "c".repeat(24);
const stale = "d".repeat(24);
const pin = "e".repeat(64);
const shell = (generation) => `import2-shell-${generation}`;
const archive = (generation) => `release-assets/pob-codes-build-editor-${generation}.tar.gz`;
const old = new Date("2020-01-01T00:00:00Z");
const recordTime = new Date("2021-01-01T00:00:00Z");
const noop = () => {};

async function fixture(t) {
  const tempBase = await realpath(tmpdir());
  const root = await mkdtemp(join(tempBase, "editor-clean-runtime-"));
  t.after(async () => {
    // Only remove this fixture's verified OS-temp child, never a computed parent.
    assert.equal(dirname(root), tempBase);
    assert.ok(relative(tempBase, root).startsWith("editor-clean-runtime-"));
    await rm(root, { recursive: true, force: true });
  });
  const runtime = join(root, ".runtime");
  await mkdir(runtime);
  async function file(name, text = "public fixture") {
    const path = join(runtime, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return path;
  }
  async function pair(generation) {
    const name = archive(generation);
    const content = `fixture archive ${generation}`;
    await file(name, content);
    await file(`${name}.sha256`, `${createHash("sha256").update(content).digest("hex")}  ${name.split("/").at(-1)}\n`);
  }
  async function age(path = runtime) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await age(join(path, name));
    }
    await utimes(path, old, old);
  }
  async function ready() {
    await age();
    if (existsSync(join(runtime, "release-record.json"))) await utimes(join(runtime, "release-record.json"), recordTime, recordTime);
  }
  await writeFile(join(root, "source-pin.json"), JSON.stringify({ compositePatch: { patchSha256: pin } }));
  await file("release-record.json", JSON.stringify({ generation: current }));
  await file("import2-release/import2/release.json", JSON.stringify({ current, retained: [retained], predecessor }));
  return { root, runtime, file, pair, ready, exists: (name) => existsSync(join(runtime, name)) };
}

test("CLI defaults to a dry run and reports classes, sizes, and protected generations", async (t) => {
  const f = await fixture(t);
  await f.pair(stale);
  await f.file(`${shell(stale)}/index.html`);
  await f.file("notes.txt");
  await f.ready();
  const result = spawnSync(process.execPath, [resolve("scripts/clean-runtime.mjs")], { cwd: f.root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  for (const expected of ["Dry run only", "archive pair", "shell", "MiB", current, retained, predecessor, "Report only notes.txt"]) assert.ok(result.stdout.includes(expected), expected);
  assert.ok(f.exists(archive(stale)));
  assert.ok(f.exists(shell(stale)));
});

test("apply removes stale pairs and shells and preserves all protected generations and inputs", async (t) => {
  const f = await fixture(t);
  for (const generation of [current, retained, predecessor, stale]) {
    await f.pair(generation);
    await f.file(`${shell(generation)}/index.html`);
  }
  for (const name of ["payload", "prepared", "predecessor", `source-${pin.slice(0, 12)}`]) await f.file(`${name}/keep.txt`);
  await f.file("release-inventory.json", "{}");
  await f.ready();
  const plan = await discoverRuntime(f.root);
  assert.equal(plan.candidates.length, 2);
  await applyRuntime(plan, noop);
  for (const generation of [current, retained, predecessor]) {
    assert.ok(f.exists(shell(generation)));
    assert.ok(f.exists(archive(generation)));
    assert.ok(f.exists(`${archive(generation)}.sha256`));
  }
  for (const name of ["payload", "prepared", "predecessor", `source-${pin.slice(0, 12)}`, "release-record.json", "release-inventory.json", "import2-release"]) assert.ok(f.exists(name));
  assert.equal(f.exists(shell(stale)), false);
  assert.equal(f.exists(archive(stale)), false);
  assert.equal(f.exists(`${archive(stale)}.sha256`), false);
});

test("unverified archive entries and edited prepared source remain report-only", async (t) => {
  const f = await fixture(t);
  await f.file(archive(stale));
  await f.pair("1".repeat(24));
  await f.file(`${archive("1".repeat(24))}.sha256`, "incorrect digest\n");
  await f.file("release-assets/keep.txt");
  const source = join(f.runtime, "source-old");
  await f.file("source-old/edited.lua");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  git("add", "edited.lua");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  await f.file("source-old/edited.lua", "maintainer edit");
  await f.ready();
  const plan = await discoverRuntime(f.root);
  assert.equal(plan.candidates.length, 0);
  const lines = [];
  printPlan(plan, (line) => lines.push(line));
  assert.match(lines.join("\n"), new RegExp(`HEAD ${head}, porcelain entries 1`));
  await applyRuntime(plan, noop);
  for (const name of [archive(stale), archive("1".repeat(24)), "release-assets/keep.txt", "source-old/edited.lua"]) assert.ok(f.exists(name));
  assert.equal(await readFile(join(source, "edited.lua"), "utf8"), "maintainer edit");
});

test("item-specific include removes only the exact direct child, never a matching archive-container entry", async (t) => {
  const f = await fixture(t);
  await f.file("notes.txt");
  await f.file("release-assets/notes.txt");
  await f.file("source-old/edit.lua");
  await f.ready();
  const plan = await discoverRuntime(f.root, { include: ["notes.txt", "source-old"] });
  assert.equal(plan.candidates.length, 2);
  await applyRuntime(plan, noop);
  assert.equal(f.exists("notes.txt"), false);
  assert.equal(f.exists("source-old"), false);
  assert.ok(f.exists("release-assets/notes.txt"));
});

test("invalid, missing, and protected include names are rejected before deletion", async (t) => {
  const f = await fixture(t);
  await f.file(`${shell(stale)}/index.html`);
  await f.pair(current);
  await f.pair(retained);
  await f.pair(predecessor);
  for (const name of ["payload", "prepared", "predecessor", `source-${pin.slice(0, 12)}`, shell(current), shell(retained), shell(predecessor)]) await f.file(`${name}/keep`);
  await f.file("release-inventory.json");
  await f.ready();
  for (const name of [".", "..", "/", "../outside", "child/file", "child\\file", "C:\\outside", f.runtime, `child${sep}..`]) {
    assert.throws(() => parseArgs(["--include", name]), /Invalid/);
    await assert.rejects(discoverRuntime(f.root, { include: [name] }), /Invalid/);
  }
  assert.throws(() => parseArgs(["--include"]), /incomplete/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown/);
  await assert.rejects(discoverRuntime(f.root, { include: ["missing"] }), /discovered/);
  for (const name of ["payload", "prepared", "predecessor", "import2-release", "release-record.json", "release-inventory.json", "release-assets", `source-${pin.slice(0, 12)}`, shell(current), shell(retained), shell(predecessor)]) {
    await assert.rejects(discoverRuntime(f.root, { include: [name] }), /Protected/);
  }
  assert.ok(f.exists(shell(stale)));
});

for (const variant of ["root", "child", "nested", "assets"]) {
  test(`junction at ${variant} is refused with zero deletions`, async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    if (variant === "root") {
      // Empty fixture-only root replacement, with a bounded literal target.
      assert.equal(dirname(f.runtime), f.root);
      await rm(f.runtime, { recursive: true });
      await symlink(outside, f.runtime, "junction");
    } else {
      await f.file(`${shell(stale)}/index.html`);
      const target = variant === "child" ? "linked" : variant === "nested" ? `${shell(stale)}/linked` : "release-assets";
      await symlink(outside, join(f.runtime, target), "junction");
      await f.ready();
    }
    await assert.rejects(discoverRuntime(f.root, { include: variant === "child" ? ["linked"] : [] }), /[Ll]ink|junction|Containment/);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
    if (variant !== "root") assert.ok(f.exists(shell(stale)));
  });
}

test("staging and candidates newer than the record abort before deleting any candidate", async (t) => {
  for (const variant of ["staging", "new shell", "new nested file", "new sidecar"]) {
    const f = await fixture(t);
    await f.file(`${shell(stale)}/index.html`);
    await f.pair(stale);
    if (variant === "staging") await f.file(`import2-release-${stale}.next/index.html`);
    await f.ready();
    const newerPath = variant === "new shell" ? shell(stale) : variant === "new nested file" ? `${shell(stale)}/index.html` : `${archive(stale)}.sha256`;
    if (variant !== "staging") await utimes(join(f.runtime, newerPath), new Date(), new Date());
    const plan = await discoverRuntime(f.root);
    await assert.rejects(applyRuntime(plan, noop), /staging|newer/);
    assert.ok(f.exists(shell(stale)));
    assert.ok(f.exists(archive(stale)));
  }
});

test("inconsistent identities protect the union and refuse apply", async (t) => {
  const f = await fixture(t);
  const other = "f".repeat(24);
  await f.file("release-record.json", JSON.stringify({ generation: other }));
  for (const generation of [current, other, retained, predecessor, stale]) {
    await f.file(`${shell(generation)}/index.html`);
    await f.pair(generation);
  }
  await f.ready();
  const plan = await discoverRuntime(f.root);
  assert.deepEqual([...plan.identity.generations].sort(), [current, other, retained, predecessor].sort());
  assert.equal(plan.candidates.length, 2);
  await assert.rejects(applyRuntime(plan, noop), /disagree/);
  assert.ok(f.exists(shell(stale)));
  assert.ok(f.exists(archive(stale)));
});

test("missing identities disable generation pruning; incomplete or malformed identity refuses apply", async (t) => {
  for (const variant of ["both missing", "record missing", "release missing", "malformed", "invalid retained", "invalid pin"]) {
    const f = await fixture(t);
    await f.file(`${shell(stale)}/index.html`);
    await f.pair(stale);
    if (["both missing", "record missing"].includes(variant)) await rm(join(f.runtime, "release-record.json"));
    if (["both missing", "release missing"].includes(variant)) await rm(join(f.runtime, "import2-release/import2/release.json"));
    if (variant === "malformed") await f.file("release-record.json", "{");
    if (variant === "invalid retained") await f.file("import2-release/import2/release.json", JSON.stringify({ current, retained: ["../bad"] }));
    if (variant === "invalid pin") await writeFile(join(f.root, "source-pin.json"), "{}");
    await f.ready();
    if (["malformed", "invalid retained", "invalid pin"].includes(variant)) await assert.rejects(discoverRuntime(f.root), /Invalid|Cannot identify/);
    else {
      const plan = await discoverRuntime(f.root);
      if (variant === "both missing") {
        assert.equal(plan.candidates.length, 0);
        await assert.rejects(discoverRuntime(f.root, { include: [shell(stale)] }), /Missing identity/);
      }
      await assert.rejects(applyRuntime(plan, noop), /Missing/);
    }
    assert.ok(f.exists(shell(stale)));
    assert.ok(f.exists(archive(stale)));
  }
});

test("preflight detects post-discovery candidate, identity, pin, staging and link changes before any deletion", async (t) => {
  for (const variant of ["candidate", "record", "release", "pin", "staging", "link"]) {
    const f = await fixture(t);
    await f.file(`${shell(stale)}/index.html`);
    await f.pair(stale);
    await f.ready();
    const plan = await discoverRuntime(f.root);
    if (variant === "candidate") await f.file(`${archive(stale)}.sha256`, "edited");
    if (variant === "record") await f.file("release-record.json", JSON.stringify({ generation: current, changed: true }));
    if (variant === "release") await f.file("import2-release/import2/release.json", JSON.stringify({ current, retained: [stale], predecessor }));
    if (variant === "pin") await writeFile(join(f.root, "source-pin.json"), JSON.stringify({ compositePatch: { patchSha256: "1".repeat(64) } }));
    if (variant === "staging") await f.file(`import2-release-${stale}.next/index.html`);
    if (variant === "link") {
      const outside = join(f.root, "outside");
      await mkdir(outside);
      await symlink(outside, join(f.runtime, `${shell(stale)}/linked`), "junction");
    }
    await assert.rejects(applyRuntime(plan, noop), /changed|staging|Link|junction/);
    assert.ok(f.exists(shell(stale)));
    assert.ok(f.exists(archive(stale)));
  }
});

test("identity change after the first deletion aborts remaining deletions", async (t) => {
  const f = await fixture(t);
  await f.file(`${shell(stale)}/index.html`);
  await f.pair(stale);
  await f.ready();
  const plan = await discoverRuntime(f.root);
  await assert.rejects(applyRuntime(plan, () => {
    // Complete the simulated producer's write between removal units.
    writeFileSync(join(f.runtime, "release-record.json"), JSON.stringify({ generation: stale }));
  }), /identity|JSON/);
  assert.equal(f.exists(shell(stale)), false);
  assert.ok(f.exists(archive(stale)));
  assert.ok(f.exists(`${archive(stale)}.sha256`));
});
