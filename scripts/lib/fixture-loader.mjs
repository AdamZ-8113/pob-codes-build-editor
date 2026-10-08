import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function decodeBuildCode(code) {
  const xml = inflateSync(Buffer.from(code.trim(), "base64url")).toString("utf8");
  if (!xml.includes("<PathOfBuilding")) throw new Error("Not a Path of Building export");
  return xml;
}

export function loadInput(file) {
  const absolute = path.resolve(file);
  const raw = readFileSync(absolute, "utf8").trim();
  if (!absolute.endsWith(".json")) {
    const xml = raw.startsWith("<") ? raw : decodeBuildCode(raw);
    return { xml, hash: sha256(xml) };
  }

  const fixture = JSON.parse(raw);
  if (fixture.schemaVersion !== 1 || !fixture.baseFixture || !Number.isInteger(fixture.itemId) ||
      !Number.isInteger(fixture.jewelTypeId)) {
    throw new Error("Unsupported JSON fixture schema; expected a public composite jewel fixture");
  }
  const base = path.resolve(path.dirname(absolute), fixture.baseFixture);
  if (path.dirname(base) !== path.dirname(absolute) || base.endsWith(".json")) {
    throw new Error("Fixture base must be a sibling XML or build-code file");
  }
  let xml = loadInput(base).xml;
  const item = new RegExp(`<Item\\b[^>]*\\bid="${fixture.itemId}"[^>]*>[\\s\\S]*?</Item>`, "u");
  if (!item.test(xml) || !/<TimelessData\b[^>]*\/>/u.test(xml)) throw new Error("Fixture targets are missing");
  const families = {vaal:'Vaal', maraketh:'Maraketh', templar:'Templars', kalguur:'Kalguur'};
  if (fixture.conqueror !== undefined && !Object.hasOwn(families, fixture.conqueror)) throw new Error('Unknown composite fixture conqueror');
  const conquest = fixture.conqueror ? `Passives in radius are Conquered by the ${families[fixture.conqueror]}` : 'Passives affected are Conquered by the Abyssal';
  const radius = fixture.conqueror ? 'Radius: Large\n' : '';
  xml = xml.replace(item, () => `<Item id="${fixture.itemId}">\nRarity: UNIQUE\n${fixture.itemName}\n${fixture.baseName}\nLimited to: 1 Historic\n${radius}Implicits: 0\n${fixture.seedLine}\n${conquest}\nHistoric\n</Item>`)
    .replace(/<TimelessData\b[^>]*\/>/u, `<TimelessData jewelTypeId="${fixture.jewelTypeId}" jewelSocketId="${fixture.socketId}" devotionVariant1="1" devotionVariant2="1" searchList="" searchListFallback=""/>`);
  return { xml, hash: sha256(xml), fixtureRevision: fixture.sourceRevision };
}
