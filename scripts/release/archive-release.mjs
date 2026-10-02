import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileSha256 } from "./release-common.mjs";

const record = JSON.parse(await readFile(".runtime/release-record.json", "utf8"));
const output = resolve(".runtime/release-assets");
await mkdir(output, { recursive: true });
const archive = join(output, `pob-codes-build-editor-${record.generation}.tar.gz`);
const result = spawnSync("tar", ["-czf", archive, "-C", ".runtime", "import2-release", "release-inventory.json"], { stdio: "inherit", windowsHide: true });
if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `tar exited ${result.status}`);
const digest = await fileSha256(archive);
// Bind the archive to the record before exporting the credential-free candidate.
record.archive = { sha256: digest, filename: archive.split(/[\\/]/).at(-1) };
await writeFile(".runtime/release-record.json", `${JSON.stringify(record, null, 2)}\n`);
await writeFile(`${archive}.sha256`, `${digest}  ${archive.split(/[\\/]/).at(-1)}\n`);
console.log(`${archive}\nSHA-256 ${digest}`);
