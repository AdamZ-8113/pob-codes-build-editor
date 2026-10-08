import { appendFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSha256 } from "./release-common.mjs";

const numericId = value => /^[1-9][0-9]*$/.test(value ?? "");

export function validateArtifactZipEntries(entries) {
  if (entries.some(name => !name || /[\0-\x1f\x7f\\]/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === ".."))) {
    throw new Error("Downloaded CI artifact zip contains an unsafe path");
  }
  const sorted = [...entries].sort();
  if (new Set(entries).size !== entries.length || sorted.length !== 3 ||
      !/^release-assets\/pob-codes-build-editor-[a-f0-9]{24}\.tar\.gz$/.test(sorted[0]) ||
      sorted[1] !== "release-inventory.json" || sorted[2] !== "release-record.json") {
    throw new Error("Downloaded CI artifact zip does not contain the exact release candidate tuple");
  }
  return sorted;
}

async function run(command, args, options = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

export async function downloadCiCandidate({ repository, artifactId, expectedDigest, zipFile, outputDirectory }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository is invalid");
  if (!numericId(artifactId)) throw new Error("Artifact ID is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? "")) throw new Error("Expected artifact digest is invalid");
  const started = Date.now();
  await mkdir(dirname(zipFile), { recursive: true });
  const output = await open(zipFile, "wx");
  try {
    await run("gh", ["api", `repos/${repository}/actions/artifacts/${artifactId}/zip`], { stdio: ["ignore", output.fd, "inherit"] });
  } catch (error) {
    await output.close();
    await rm(zipFile, { force: true });
    throw error;
  }
  await output.close();
  const actualDigest = `sha256:${await fileSha256(zipFile)}`;
  if (actualDigest !== expectedDigest) throw new Error("Downloaded CI artifact digest does not match GitHub metadata");
  const listing = spawnSync("unzip", ["-Z1", zipFile], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  if (listing.error || listing.status !== 0) throw new Error(listing.error?.message ?? listing.stderr.trim() ?? `unzip exited ${listing.status}`);
  validateArtifactZipEntries(listing.stdout.split(/\r?\n/).filter(Boolean));
  try {
    if ((await readdir(outputDirectory)).length || (await stat(outputDirectory)).isFile()) throw new Error("Candidate output directory must be fresh and empty");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(outputDirectory, { recursive: true });
  }
  const extracted = spawnSync("unzip", ["-q", zipFile, "-d", outputDirectory], { encoding: "utf8", windowsHide: true });
  if (extracted.error || extracted.status !== 0) throw new Error(extracted.error?.message ?? extracted.stderr.trim() ?? `unzip exited ${extracted.status}`);
  return { digest: actualDigest, bytes: (await stat(zipFile)).size, elapsedMs: Date.now() - started };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
  const zipFile = resolve(value("zip"));
  const outputDirectory = resolve(value("output"));
  const result = await downloadCiCandidate({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    artifactId: value("artifact-id"),
    expectedDigest: value("digest"),
    zipFile,
    outputDirectory,
  });
  const githubOutput = value("github-output");
  if (githubOutput) {
    await appendFile(resolve(githubOutput), `download-bytes=${result.bytes}\ndownload-seconds=${Math.ceil(result.elapsedMs / 1000)}\n`);
  }
  console.log(`Downloaded and verified CI artifact ${value("artifact-id")}: ${result.bytes} bytes in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
}
