import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBuildCode } from "./lib/fixture-loader.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".git", ".runtime", "node_modules", "build", "dist"]);
const forbidden = [
  /apps[\\/]desktop-pob/u,
  /\.\.[\\/]\.\.[\\/](?:test_builds|apps)[\\/]/u,
  /Vibe Code Projects/u,
  /MercenaryApiCapture/u,
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
  const violations = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && !/\.(?:woff|png|jpe?g|zip|wasm)$/iu.test(absolute)) {
        const path = relative(root, absolute);
        if (path.replaceAll("\\", "/") === "scripts/check-public-boundary.mjs") continue;
        const text = readFileSync(absolute, "utf8");
        for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
        const decoded = decodedFixtureText(path, text);
        if (decoded && identifyingFixtureField.test(decoded)) {
          violations.push(`${path}: decoded fixture contains account/character hash fields`);
        }
      }
    }
  }
  visit(root);
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scanPublicBoundary();
  if (violations.length) throw new Error(`Private-root dependency or sensitive material found:\n${violations.join("\n")}`);
  console.log("Public boundary scan passed, including decoded fixture privacy checks.");
}
