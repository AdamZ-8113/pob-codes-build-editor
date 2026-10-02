import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) throw new Error(`Node 22 or newer is required; found ${process.version}`);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} exited ${result.status}`);
}

mkdirSync(".runtime", { recursive: true });
run("deno", ["--version"]);
run("deno", ["install", "--frozen", "--config", "upstream/deno.json"]);
console.log("Prepared pinned Deno dependencies. Emscripten 6.0.6 is pulled only by npm run test:native/build:release.");
