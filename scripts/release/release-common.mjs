import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileSha256 = async (file) => sha256(await readFile(file));

export async function inventoryFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = (await stat(file)).size;
        files.push({ path: relative(root, file).replaceAll("\\", "/"), bytes, sha256: await fileSha256(file) });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
