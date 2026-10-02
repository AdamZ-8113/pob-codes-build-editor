import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const excluded = new Set([".git", ".runtime", "node_modules", "build", "dist", "tmp", "reports"]);
const modules = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && path.endsWith(".mjs")) modules.push(path);
  }
}
visit(".");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
for (const module of modules.sort()) run(process.execPath, ["--check", module]);
run("deno", ["check", "--config", "upstream/deno.json", "src/main.ts", "upstream/vite.local.config.ts", "upstream/vite.import2.config.ts"]);
run(process.execPath, ["scripts/check-public-boundary.mjs"]);
console.log(`Checked ${modules.length} Node modules and the public TypeScript entry points.`);
