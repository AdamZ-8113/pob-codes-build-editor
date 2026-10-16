/**
 * Lazy payload a launch build will demand during import. Hints only start
 * background downloads earlier: a missed hint falls back to PoB's demand load,
 * and a false hint costs bytes, never behavior.
 */
const MAX_XML_BYTES = 32 * 1024 * 1024;
const TIMELESS_FILES: readonly [RegExp, string][] = [
  [/Glorious Vanity/i, "GloriousVanity"],
  [/Lethal Pride/i, "LethalPride"],
  [/Brutal Restraint/i, "BrutalRestraint"],
  [/Militant Faith/i, "MilitantFaith"],
  [/Elegant Hubris/i, "ElegantHubris"],
  [/Heroic Tragedy/i, "HeroicTragedy"],
];

export async function payloadHintsForBuildCode(code: string): Promise<string[]> {
  return payloadHintsForXml(await inflateBuildCode(code));
}

export function payloadHintsForXml(xml: string): string[] {
  const prefixes = new Set<string>();
  for (const match of xml.matchAll(/\btreeVersion="([0-9A-Za-z_]{1,32})"/g)) prefixes.add(`/TreeData/${match[1]}/`);
  // Restrict jewel names to item text so notes or build names cannot hint 30 MB tables.
  const items = xml.match(/<Items\b[\s\S]*?<\/Items>/)?.[0] ?? "";
  for (const [pattern, file] of TIMELESS_FILES) {
    if (pattern.test(items)) prefixes.add(`/Data/TimelessJewelData/${file}.zip`);
  }
  return [...prefixes];
}

async function inflateBuildCode(code: string): Promise<string> {
  const binary = atob(code.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const decoder = new TextDecoder();
  const text: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_XML_BYTES) {
      await reader.cancel();
      throw new Error("Build code expands beyond the hint limit");
    }
    text.push(decoder.decode(value, { stream: true }));
  }
  text.push(decoder.decode());
  return text.join("");
}
