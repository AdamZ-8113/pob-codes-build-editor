import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const registry = JSON.parse(readFileSync("tests/deno-unit-tests.json", "utf8"));
const discovered = readdirSync("upstream/packages/driver/test/unit").filter((name) => name.endsWith(".test.ts")).sort();
const registered = [...registry.driver, ...registry.nativeOnly].sort();
if (JSON.stringify(discovered) !== JSON.stringify(registered)) throw new Error("Deno driver test registry is stale");

function run(args) {
  const result = spawnSync("deno", args, { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
run(["test", "--no-check", "--allow-env", "--allow-read=upstream",
  "--config", "upstream/packages/driver/deno.json", ...registry.driver.map((name) => `upstream/packages/driver/test/unit/${name}`)]);
run(["test", "--no-check", "--allow-read", "--config", "upstream/packages/packer/deno.json",
  ...registry.packer.map((name) => `upstream/packages/packer/src/${name}`)]);
