import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR_VERSION = 1;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function featureInventory(source) {
  const count = pattern => [...source.matchAll(pattern)].length;
  return {
    functionKeyword: count(/\bfunction\b/gu),
    loadstring: count(/\bloadstring\s*\(/gu),
    newClass: count(/\bnewClass\s*\(/gu),
    setmetatable: count(/\bsetmetatable\s*\(/gu),
    compoundAssignment: count(/[+\-*/%]=/gu),
    probeSchema: count(/architectureProbeSchema/gu),
  };
}

export function artifactKey({ sourceRevision, compositePatchSha256, files }) {
  const inputs = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, source]) => [name, sha256(source)]);
  return sha256(JSON.stringify({
    generatorVersion: GENERATOR_VERSION,
    sourceRevision,
    compositePatchSha256,
    inputs,
  }));
}

export function runControlledEvolution({ sourceRevision, compositePatchSha256, files }) {
  const changes = [
    {
      id: 'formula',
      file: 'Modules/CalcPerform.lua',
      addition: '\nlocal function architectureProbeFormula(value) return value * 1.01 + 7 end\n',
      expectedFeature: 'functionKeyword',
    },
    {
      id: 'data-schema',
      file: 'Data/ModCache.lua',
      addition: '\ndata.architectureProbeSchema = { version = 2, columns = { "stat", "value" } }\n',
      expectedFeature: 'probeSchema',
    },
    {
      id: 'dynamic-behavior',
      file: 'Classes/PassiveTree.lua',
      addition: '\nlocal architectureProbeDynamic = loadstring("return function(value) return value end")()\n',
      expectedFeature: 'loadstring',
    },
  ];
  const baselineKey = artifactKey({ sourceRevision, compositePatchSha256, files });
  return {
    generatorVersion: GENERATOR_VERSION,
    baselineKey,
    changes: changes.map(change => {
      if (!Object.hasOwn(files, change.file)) throw new Error(`Missing controlled-change input: ${change.file}`);
      const before = featureInventory(files[change.file]);
      const evolvedFiles = { ...files, [change.file]: files[change.file] + change.addition };
      const after = featureInventory(evolvedFiles[change.file]);
      const evolvedKey = artifactKey({ sourceRevision, compositePatchSha256, files: evolvedFiles });
      return {
        id: change.id,
        file: change.file,
        artifactInvalidated: evolvedKey !== baselineKey,
        expectedFeature: change.expectedFeature,
        featureDelta: after[change.expectedFeature] - before[change.expectedFeature],
        unsupportedDynamicBehaviorDetected: change.id === 'dynamic-behavior'
          ? after.loadstring > before.loadstring
          : null,
        evolvedKey,
      };
    }),
  };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const pin = JSON.parse(await readFile(path.join(repositoryRoot, 'source-pin.json'), 'utf8'));
  const preparedSource = path.join(
    repositoryRoot,
    '.runtime',
    `source-${pin.compositePatch.patchSha256.slice(0, 12)}`,
    'src',
  );
  const names = ['Modules/CalcPerform.lua', 'Data/ModCache.lua', 'Classes/PassiveTree.lua'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [
    name,
    await readFile(path.join(preparedSource, ...name.split('/')), 'utf8'),
  ])));
  const result = runControlledEvolution({
    sourceRevision: pin.revision,
    compositePatchSha256: pin.compositePatch.patchSha256,
    files,
  });
  console.log(JSON.stringify({
    sourceRevision: pin.revision,
    compositePatchSha256: pin.compositePatch.patchSha256,
    preparedSource: path.relative(repositoryRoot, preparedSource).replaceAll('\\', '/'),
    ...result,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
