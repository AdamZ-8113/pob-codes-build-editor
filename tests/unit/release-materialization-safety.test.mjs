import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  GENERATION_CONTRACT_INPUTS,
  GENERATION_SHELL_ROOTS,
  releaseFingerprint,
} from "../../scripts/release/materialize-import2.mjs";
import { materializeImport2Disabled } from "../../scripts/release/materialize-import2-disabled.mjs";
import { verifyImport2Release } from "../../scripts/release/verify-import2-release.mjs";

const config = Object.freeze({
  basePath: "/import2",
  siteOrigin: "https://pob.codes",
  productName: "PoB Codes Build Editor",
  repositoryUrl: "https://github.com/AdamZ-8113/pob-codes-build-editor",
  apiBaseUrl: "",
  telemetryEndpoint: "",
});

test("generation identity covers public config, materializer, shell, payload, and legal inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-editor-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of GENERATION_CONTRACT_INPUTS) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `contract:${path}\n`);
  }
  for (const path of GENERATION_SHELL_ROOTS) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "input.txt"), `shell:${path}\n`);
  }
  const payloadRoot = join(root, ".runtime/payload");
  await mkdir(join(payloadRoot, "root"), { recursive: true });
  await writeFile(join(payloadRoot, "manifest.json"), "{}\n");
  await writeFile(join(payloadRoot, "root/input.lua"), "return true\n");

  const fingerprint = () => releaseFingerprint(config, { root, payloadRoot });
  const baseline = await fingerprint();
  assert.notEqual(await releaseFingerprint({ ...config, telemetryEndpoint: "https://api.pob.codes/events" }, { root, payloadRoot }), baseline);

  await writeFile(join(root, "scripts/release/materialize-import2.mjs"), "changed materializer\n");
  assert.notEqual(await fingerprint(), baseline);
  await writeFile(join(root, "scripts/release/materialize-import2.mjs"), "contract:scripts/release/materialize-import2.mjs\n");

  await writeFile(join(root, "src/input.txt"), "changed shell\n");
  assert.notEqual(await fingerprint(), baseline);
  await writeFile(join(root, "src/input.txt"), "shell:src\n");

  await writeFile(join(root, "PATH_OF_BUILDING_LICENSE.md"), "changed legal bytes\n");
  assert.notEqual(await fingerprint(), baseline);
  await writeFile(join(root, "PATH_OF_BUILDING_LICENSE.md"), "contract:PATH_OF_BUILDING_LICENSE.md\n");

  await writeFile(join(payloadRoot, "root/input.lua"), "return false\n");
  assert.notEqual(await fingerprint(), baseline);
});

test("disabled release materializes and passes the production release verifier", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-editor-disabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDirectory = join(root, "release");
  await materializeImport2Disabled({ releaseDirectory, stagingDirectory: join(root, "staging") });
  const verified = await verifyImport2Release(releaseDirectory);
  assert.equal(verified.release.mode, "disabled");
  assert.equal(verified.release.current, null);
  assert.match(await readFile(join(releaseDirectory, "import2/index.html"), "utf8"), /Build Editor temporarily unavailable/);
});
