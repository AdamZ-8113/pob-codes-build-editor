import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const excluded = new Set([".git", ".runtime", "node_modules", "build", "dist"]);

function gitFiles(root, args) {
  return execFileSync("git", ["-C", root, "ls-files", "-z", ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

// Git supplies both tracked and new public files, without reading private local
// state. Keep ignored tracked paths visible so force-adding cannot bypass checks.
export function publicFileInventory(directory) {
  const root = resolve(directory);
  if (existsSync(join(root, ".git"))) {
    const files = [...new Set(gitFiles(root, ["--cached", "--others", "--exclude-standard"]))]
      .filter((path) => {
        const absolute = join(root, path);
        return existsSync(absolute) && lstatSync(absolute).isFile();
      }).sort();
    const ignoredTracked = gitFiles(root, ["--cached", "--ignored", "--exclude-standard"]);
    return { files, ignoredTracked };
  }

  // Source archives and isolated fixture directories have no Git index.
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  visit(root);
  return { files: files.sort(), ignoredTracked: [] };
}
