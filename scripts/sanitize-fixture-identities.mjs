import { readdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBuildCode } from "../fixture-loader.mjs";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
let changed = 0;
for (const name of await readdir(fixtures)) {
  if (!name.endsWith(".txt")) continue;
  const path = join(fixtures, name);
  const encoded = (await readFile(path, "utf8")).trim();
  if (encoded.startsWith("<")) continue;
  const xml = decodeBuildCode(encoded);
  const sanitized = xml.replace(/\s+(?:last)?(?:AccountHash|CharacterHash)="[^"]*"/giu, "");
  if (sanitized === xml) continue;
  await writeFile(path, `${deflateSync(Buffer.from(sanitized)).toString("base64url")}\n`);
  changed += 1;
  console.log(`Removed account/character identity fields from ${name}.`);
}
console.log(`Sanitized ${changed} encoded public fixture(s).`);
