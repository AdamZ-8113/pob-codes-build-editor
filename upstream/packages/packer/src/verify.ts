import AdmZip from "adm-zip";
import { Buffer } from "node:buffer";
import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { sha256, validatePayloadManifest } from "../../../payload-manifest.ts";

// Full generated-output check against the retained legacy archive, never a sample.
const directory = Deno.args[0];
if (!directory || Deno.args.length !== 1) throw new Error("Usage: verify.ts <payload-directory>");
const root = resolve(directory);
const manifest = validatePayloadManifest(JSON.parse(await Deno.readTextFile(`${root}/manifest.json`)));
const legacy = new AdmZip(`${root}/root.zip`);
const expected = new Map(legacy.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName, e]));
const directories = new Set<string>((manifest.directories ?? []).map((d) => d + "/"));
let files = 0, bytes = 0;
for (const p of manifest.packages) {
  const data = await Deno.readFile(`${root}/packages/${p.sha256}.zip`);
  assertEquals(data.length, p.bytes);
  assertEquals(await sha256(data), p.sha256);
  const zip = new AdmZip(Buffer.from(data));
  assertEquals(
    zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort(),
    p.files.map((f) => f.path).sort(),
  );
  for (const file of p.files) {
    const old = expected.get(file.path);
    if (!old) throw new Error(`Unexpected packaged path: ${file.path}`);
    const actual = zip.getEntry(file.path)!.getData();
    assertEquals(actual.length, file.bytes);
    assertEquals(actual, old.getData(), `Changed packaged bytes: ${file.path}`);
    expected.delete(file.path);
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/") + "/");
      parts.pop();
    }
    files++;
    bytes += actual.length;
  }
}
assertEquals(expected.size, 0, "Every legacy file must be packaged");
const missingDirectories = legacy.getEntries().filter((e) => e.isDirectory && !directories.has(e.entryName)).map((e) =>
  e.entryName
);
assertEquals(missingDirectories, [], "Every legacy directory must remain visible");
console.log(JSON.stringify({ packages: manifest.packages.length, files, bytes, completeLegacyParity: true }));
