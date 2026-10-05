import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const generationPattern = /^[a-f0-9]{24}$/;
const shellPattern = /^import2-shell-([a-f0-9]{24})$/;
const archivePattern = /^pob-codes-build-editor-([a-f0-9]{24})\.tar\.gz$/;
const stagingPattern = /^import2-release-.*\.next$/;
const protectedNames = ["payload", "prepared", "import2-release", "predecessor", "release-record.json", "release-inventory.json"];

function validateName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid --include name: ${name}; use one exact direct-child name`);
  }
}

export function parseArgs(args) {
  const include = [];
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--include" && args[i + 1] && !args[i + 1].startsWith("--")) {
      validateName(args[++i]);
      include.push(args[i]);
    } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  return { apply, include };
}

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function runtimeRoot(root) {
  const runtime = join(await realpath(root), ".runtime");
  const info = await lstat(runtime);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(runtime) !== runtime) {
    throw new Error("Containment failure: .runtime must be a real directory inside the repository");
  }
  return runtime;
}

// Check every component before reading or removing a descendant, including the
// archive container. A lexical prefix alone does not detect Windows junctions.
async function assertContained(runtime, path) {
  const rel = relative(runtime, path);
  if (!rel || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error(`Containment failure: ${path}`);
  let current = runtime;
  for (const part of ["", ...rel.split(sep)]) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Link or junction refused: ${current}`);
  }
  if (await realpath(path) !== path) throw new Error(`Containment failure: ${path}`);
}

function statIdentity(info) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
}

async function scan(path) {
  const entries = [];
  const issues = [];
  let size = 0;
  let newest = 0;
  async function visit(current) {
    const info = await lstat(current);
    entries.push([relative(path, current), ...statIdentity(info)]);
    newest = Math.max(newest, info.mtimeMs);
    if (info.isSymbolicLink()) issues.push(`Link or junction refused: ${current}`);
    else if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await visit(join(current, name));
    } else if (info.isFile()) size += info.size;
    else issues.push(`Special file refused: ${current}`);
  }
  await visit(path);
  return { size, newest, signature: JSON.stringify(entries), issues };
}

async function readIdentity(runtime, name) {
  const path = join(runtime, name);
  if (!await optionalStat(path)) return null;
  await assertContained(runtime, path);
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Invalid identity file: ${name}`);
  const text = await readFile(path, "utf8");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Invalid identity JSON: ${name}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid identity: ${name}`);
  return { value, text, stat: statIdentity(info), mtime: info.mtimeMs };
}

async function identities(root, runtime) {
  const record = await readIdentity(runtime, "release-record.json");
  const release = await readIdentity(runtime, "import2-release/import2/release.json");
  const generations = new Set();
  function protect(value) {
    if (typeof value !== "string" || !generationPattern.test(value)) throw new Error("Invalid release generation identity");
    generations.add(value);
  }
  if (record) protect(record.value.generation);
  if (release) {
    protect(release.value.current);
    if (!Array.isArray(release.value.retained)) throw new Error("Invalid retained generation identities");
    release.value.retained.forEach(protect);
    if (release.value.predecessor !== null && release.value.predecessor !== undefined) protect(release.value.predecessor);
  }
  const pinText = await readFile(join(root, "source-pin.json"), "utf8");
  const patch = JSON.parse(pinText)?.compositePatch?.patchSha256;
  if (typeof patch !== "string" || !/^[a-f0-9]{64}$/.test(patch)) throw new Error("Cannot identify the current prepared source from source-pin.json");
  const warnings = [];
  if (!record || !release) warnings.push("Missing release identity file(s); apply requires both identities");
  if (record && release && record.value.generation !== release.value.current) warnings.push("Release identities disagree; protecting their union and refusing apply");
  return { record, release, generations, currentSource: `source-${patch.slice(0, 12)}`, warnings, signature: JSON.stringify([record, release, pinText]) };
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sourceStatus(path) {
  if (!await optionalStat(join(path, ".git"))) return "Git HEAD/status unavailable (no prepared-source repository)";
  const run = (args) => spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (head.status !== 0 || status.status !== 0) return "Git HEAD/status unavailable";
  const records = status.stdout.split("\0").filter(Boolean);
  let count = 0;
  for (let i = 0; i < records.length; i++) {
    count++;
    if (/[RC]/.test(records[i].slice(0, 2))) i++;
  }
  return `HEAD ${head.stdout.trim()}, porcelain entries ${count} (composite changes may be expected)`;
}

export async function discoverRuntime(root = process.cwd(), { include = [] } = {}) {
  include.forEach(validateName);
  root = await realpath(root);
  const runtime = await runtimeRoot(root);
  const identity = await identities(root, runtime);
  const names = (await readdir(runtime)).sort();
  const protectedSet = new Set([...protectedNames, identity.currentSource, "release-assets"]);
  for (const generation of identity.generations) protectedSet.add(`import2-shell-${generation}`);
  for (const name of include) {
    if (!names.includes(name)) throw new Error(`--include does not name a discovered direct child: ${name}`);
    if (protectedSet.has(name.toLowerCase())) throw new Error(`Protected entry cannot be included: ${name}`);
    // Without identities no generation, including an explicitly selected shell,
    // can safely be called stale.
    if (!identity.generations.size && shellPattern.test(name)) throw new Error(`Missing identity for generation entry: ${name}`);
  }
  const candidates = [];
  const reports = [];
  const blockers = [...identity.warnings];
  async function describe(paths, kind, reason, automatic) {
    const snapshots = [];
    for (const path of paths) snapshots.push(await scan(path));
    const item = { names: paths.map((path) => relative(runtime, path)), paths, kind, reason, size: snapshots.reduce((sum, value) => sum + value.size, 0), snapshots };
    if (automatic || include.includes(relative(runtime, paths[0]))) {
      for (const snapshot of snapshots) if (snapshot.issues.length) throw new Error(snapshot.issues.join("; "));
      for (const path of paths) await assertContained(runtime, path);
      candidates.push(item);
      if (identity.record && snapshots.some((value) => value.newest > identity.record.mtime)) blockers.push(`Candidate newer than release-record.json: ${item.names.join(" + ")}`);
    } else {
      const issues = snapshots.flatMap((value) => value.issues);
      if (issues.length) item.reason += `; contains ${issues.length} refused link(s) or special file(s)`;
      if (/^source-/.test(item.names[0]) && !issues.length && (await lstat(paths[0])).isDirectory()) item.reason += `; ${await sourceStatus(paths[0])}`;
      reports.push(item);
    }
  }
  for (const name of names) {
    const path = join(runtime, name);
    if (stagingPattern.test(name)) blockers.push(`Possible active build staging: ${name}`);
    if (protectedSet.has(name.toLowerCase())) continue;
    const shell = name.match(shellPattern);
    if (shell && identity.generations.size) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Link or junction refused: ${path}`);
      if (info.isDirectory()) {
        await describe([path], "shell", "superseded Vite output", true);
        continue;
      }
    }
    await describe([path], "manual", shell ? "missing identity or unexpected shell type" : "requires item-specific --include", false);
  }
  const assets = join(runtime, "release-assets");
  if (await optionalStat(assets)) {
    await assertContained(runtime, assets);
    const assetNames = (await readdir(assets)).sort();
    const consumed = new Set();
    for (const name of assetNames) {
      if (consumed.has(name)) continue;
      const match = name.match(/^pob-codes-build-editor-([a-f0-9]{24})\.tar\.gz(?:\.sha256)?$/i);
      if (match && identity.generations.has(match[1].toLowerCase())) continue;
      const archive = name.match(archivePattern);
      const path = join(assets, name);
      const sidecarName = `${name}.sha256`;
      const sidecar = join(assets, sidecarName);
      let reason = "unrecognized archive entry; preserved";
      if (archive && identity.generations.size) {
        reason = "archive sidecar missing, malformed, or mismatched; preserved";
        if (assetNames.includes(sidecarName)) {
          await assertContained(runtime, path);
          await assertContained(runtime, sidecar);
          if ((await lstat(path)).isFile() && (await lstat(sidecar)).isFile()) {
            const beforeHash = [await scan(path), await scan(sidecar)];
            const digest = await fileHash(path);
            if (await readFile(sidecar, "utf8") === `${digest}  ${name}\n`) {
              await describe([path, sidecar], "archive pair", "superseded archive with verified SHA-256 sidecar", true);
              if (candidates.at(-1).snapshots.some((snapshot, i) => snapshot.signature !== beforeHash[i].signature)) {
                throw new Error(`Archive pair changed during verification: ${name}`);
              }
              consumed.add(sidecarName);
              continue;
            }
          }
        }
      }
      await describe([path], "manual", reason, false);
    }
  }
  return { root, runtime, identity, candidates, reports, blockers };
}

async function recheckState(plan) {
  if (await runtimeRoot(plan.root) !== plan.runtime) throw new Error("Runtime root changed");
  const current = await identities(plan.root, plan.runtime);
  if (current.signature !== plan.identity.signature) throw new Error("Release identity or source pin changed; refusing remaining deletions");
  if (current.warnings.length) throw new Error(current.warnings.join("; "));
  if ((await readdir(plan.runtime)).some((name) => stagingPattern.test(name))) throw new Error("Possible active build staging; refusing apply");
}

async function recheckCandidate(plan, item) {
  for (let i = 0; i < item.paths.length; i++) {
    await assertContained(plan.runtime, item.paths[i]);
    const current = await scan(item.paths[i]);
    if (current.issues.length) throw new Error(current.issues.join("; "));
    if (current.signature !== item.snapshots[i].signature) throw new Error(`Candidate changed: ${item.names[i]}`);
    if (current.newest > plan.identity.record.mtime) throw new Error(`Candidate newer than release record: ${item.names[i]}`);
  }
}

export async function applyRuntime(plan, log = console.log) {
  if (plan.blockers.length) throw new Error(plan.blockers.join("; "));
  // Complete preflight of every target before the first removal.
  await recheckState(plan);
  for (const item of plan.candidates) await recheckCandidate(plan, item);
  for (const item of plan.candidates) {
    await recheckCandidate(plan, item);
    await recheckState(plan);
    // Producers do not participate in a lock: an exact-name rewrite after this
    // final check remains a race. Run manually while producers are stopped.
    for (const path of item.paths) await rm(path, { recursive: true });
    log(`Removed ${item.names.join(" + ")}`);
  }
}

function bytes(size) { return `${(size / 1024 / 1024).toFixed(2)} MiB`; }

export function printPlan(plan, log = console.log) {
  log(`Protected generations: ${[...plan.identity.generations].sort().join(", ") || "unknown (no generation pruning)"}`);
  log(`Protected runtime inputs and current source: ${plan.identity.currentSource}`);
  for (const item of plan.candidates) log(`Candidate [${item.kind}] ${item.names.join(" + ")} | ${bytes(item.size)} | ${item.reason}`);
  for (const item of plan.reports) log(`Report only ${item.names.join(" + ")} | ${bytes(item.size)} | ${item.reason}`);
  log(`${plan.candidates.length} candidate(s), ${bytes(plan.candidates.reduce((sum, item) => sum + item.size, 0))} reclaimable`);
  for (const blocker of plan.blockers) log(`Apply blocked: ${blocker}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = await discoverRuntime(process.cwd(), options);
    printPlan(plan);
    if (options.apply) await applyRuntime(plan);
    else {
      console.log("Dry run only. Stop producers and review before using --apply; --include <name> selects an exact runtime child. release-assets is a protected container; only verified stale pairs are selected.");
      if (plan.identity.warnings.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Runtime cleanup refused: ${error.message}`);
    process.exitCode = 1;
  }
}
