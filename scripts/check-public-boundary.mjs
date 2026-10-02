import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const excluded = new Set([".git", ".runtime", "node_modules", "build", "dist"]);
const forbidden = [
  /apps[\\/]desktop-pob/u,
  /\.\.[\\/]\.\.[\\/](?:scripts|test_builds|apps)[\\/]/u,
  /Vibe Code Projects/u,
  /MercenaryApiCapture/u,
  /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|CLOUDFLARE_API_TOKEN\s*=)/u,
];
const violations = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && !/\.(?:woff|png|jpe?g|zip|wasm)$/iu.test(path)) {
      if (path.replaceAll("\\", "/") === "scripts/check-public-boundary.mjs") continue;
      const text = readFileSync(path, "utf8");
      for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
    }
  }
}
visit(".");
if (violations.length) throw new Error(`Private-root dependency or sensitive material found:\n${violations.join("\n")}`);
console.log("Public boundary scan passed.");
