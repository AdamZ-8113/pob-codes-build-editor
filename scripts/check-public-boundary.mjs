import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBuildCode } from "./lib/fixture-loader.mjs";
import { publicFileInventory } from "./lib/public-files.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = [
  // Absolute paths into a personal home directory expose a contributor's machine
  // layout: C:\Users\..., C:/Users/..., /c/Users/..., /Users/..., /home/...
  /\b[a-z]:[\\/]+users[\\/]+[^\\/\s"'`]+/iu,
  /(?<![\w.-])(?:\/[A-Za-z])?\/(?:Users|home)\/[^/\s"'`]+\//u,
  /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|CLOUDFLARE_API_TOKEN\s*=)/u,
];
const identifyingFixtureField = /\b(?:last)?(?:AccountHash|CharacterHash)\s*=/iu;

function decodedFixtureText(path, text) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.startsWith("fixtures/") || !normalized.endsWith(".txt")) return null;
  if (text.trimStart().startsWith("<")) return text;
  try {
    return decodeBuildCode(text);
  } catch (error) {
    throw new Error(`Public fixture cannot be decoded for privacy review: ${path}: ${error.message}`);
  }
}

export function scanPublicBoundary(root = appDir) {
  const { files, ignoredTracked } = publicFileInventory(root);
  const violations = ignoredTracked.map((path) => `${path}: tracked file matches local ignore rules`);
  for (const path of files) {
    if (path === "scripts/check-public-boundary.mjs" || /\.(?:woff|png|jpe?g|zip|wasm)$/iu.test(path)) continue;
    const text = readFileSync(join(root, path), "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
    const decoded = decodedFixtureText(path, text);
    if (decoded && identifyingFixtureField.test(decoded)) {
      violations.push(`${path}: decoded fixture contains account/character hash fields`);
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scanPublicBoundary();
  if (violations.length) throw new Error(`Private-root dependency or sensitive material found:\n${violations.join("\n")}`);
  console.log("Public boundary scan passed, including decoded fixture privacy checks.");
}
