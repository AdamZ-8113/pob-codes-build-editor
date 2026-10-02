import { spawnSync } from "node:child_process";
import { publicFileInventory } from "./lib/public-files.mjs";

const modules = publicFileInventory(".").files.filter((path) => path.endsWith(".mjs"));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
for (const module of modules.sort()) run(process.execPath, ["--check", module]);
run("deno", ["check", "--config", "upstream/deno.json", "src/main.ts", "upstream/vite.local.config.ts", "upstream/vite.import2.config.ts"]);
run(process.execPath, ["scripts/check-public-boundary.mjs"]);
console.log(`Checked ${modules.length} Node modules and the public TypeScript entry points.`);
