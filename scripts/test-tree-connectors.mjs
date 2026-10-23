import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { applyTreeConnectorCullingPatch } from "./patches/tree-connector-culling-patch.mjs";
import { validateSourceLedger } from "./build/source-ledger.mjs";

// Bind only the adapted inputs over the read-only prepared checkout. Neither
// the upstream source nor its retained Busted expectations are edited.
const { pin } = await validateSourceLedger(process.cwd());
const adapter = pin.adapters.treeConnectorCulling;
const source = resolve(`.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}`);
const directory = await mkdtemp(join(tmpdir(), "pob-tree-connectors-"));
try {
  const args = ["run", "--rm", "--mount", `type=bind,src=${source},dst=/pob,readonly`];
  const patch = await readFile(adapter.patchFile);
  for (const path of Object.keys(adapter.sourceBlobHashes)) {
    const staged = join(directory, basename(path));
    await writeFile(staged, applyTreeConnectorCullingPatch(await readFile(join(source, path), "utf8"), patch, adapter, path));
    args.push("--mount", `type=bind,src=${staged},dst=/pob/${path},readonly`);
  }
  args.push("--mount", `type=bind,src=${resolve("tests/lua/tree-connector-culling_spec.lua")},dst=/tests/tree-connector-culling_spec.lua,readonly`,
    "--workdir", "/pob", "ghcr.io/pathofbuildingcommunity/pathofbuilding-tests:latest",
    "busted", "--lua=luajit", "../spec/System/TestPassiveTreeView_spec.lua", "../spec/System/TestTreeTab_spec.lua", "/tests/tree-connector-culling_spec.lua");
  execFileSync("docker", args, { stdio: "inherit", windowsHide: true });
} finally {
  // Only this invocation's fresh mkdtemp directory is disposable.
  await rm(directory, { recursive: true, force: true });
}
