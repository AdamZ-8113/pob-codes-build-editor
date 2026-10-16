import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Appends the generated mastery-option supplement (scripts/build/mod-cache) to
// PoB's shipped Data/ModCache.lua. Both are main:SaveModCache modules; the
// shipped bytes are kept verbatim and the supplement may only add new keys.
export const modCachePath = 'src/Data/ModCache.lua';
const header = Buffer.from('local c = {}\n(function()\n');
const footer = Buffer.from('end)();\nreturn c\n');
const returnLine = Buffer.from('return c\n');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Keys in SaveModCache line order. SaveModCache escapes only newlines in keys. */
export function modCacheKeys(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const keys = [...text.matchAll(/^c\["([^"\n]*)"\]=\{/gm)].map(match => match[1]);
  if (keys.length !== (text.match(/^c\[/gm) ?? []).length) throw new Error('ModCache supplement: unrecognized cache entry');
  return keys;
}

function assertModule(bytes, name) {
  if (!bytes.subarray(0, header.length).equals(header) || !bytes.subarray(bytes.length - footer.length).equals(footer)) {
    throw new Error(`ModCache supplement: ${name} is not a SaveModCache module`);
  }
}

export function appendModCacheSupplement(source, supplement, ledger) {
  source = Buffer.from(source);
  supplement = Buffer.from(supplement);
  if (blob(source) !== ledger.sourceBlobHashes[modCachePath]) {
    throw new Error('ModCache supplement: shipped Data/ModCache.lua identity changed');
  }
  assertModule(source, 'shipped Data/ModCache.lua');
  assertModule(supplement, 'generated supplement');
  const shipped = new Set(modCacheKeys(source));
  const added = modCacheKeys(supplement);
  if (new Set(added).size !== added.length || added.some(key => shipped.has(key))) {
    throw new Error('ModCache supplement: generated keys must be new and unique');
  }
  if (added.length !== ledger.entries) {
    throw new Error(`ModCache supplement: ${added.length} entries; source-pin.json records ${ledger.entries}`);
  }
  // `...end)();\nreturn c\n` + `(function()\n...end)();\nreturn c\n`
  const result = Buffer.concat([
    source.subarray(0, source.length - returnLine.length),
    supplement.subarray(Buffer.byteLength('local c = {}\n')),
  ]);
  const resultHash = blob(result);
  if (resultHash !== ledger.resultBlobHashes[modCachePath]) {
    throw new Error(`ModCache supplement: result identity changed (candidate ${resultHash}); ` +
      'review the generated entries and record it in source-pin.json');
  }
  return new Uint8Array(result);
}
