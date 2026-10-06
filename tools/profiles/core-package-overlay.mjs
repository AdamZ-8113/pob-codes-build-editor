import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { decodeBuildCode, loadInput, sha256 } from '../../scripts/lib/fixture-loader.mjs';

const require = createRequire(new URL('../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
export { sha256 };

// Inputs and rewritten packages stay in memory. Never include input text in errors.
export async function loadBuildInput({ buildFile, buildUrl }) {
  assert.ok(!(buildFile && buildUrl), 'Choose one build input');
  if (buildFile) {
    const { xml, hash } = loadInput(buildFile);
    return { buildCode: deflateSync(xml).toString('base64url'), xmlHash: hash };
  }
  const shared = new URL(buildUrl);
  const id = shared.protocol === 'https:' && shared.hostname === 'pob.codes' && shared.pathname.match(/^\/b\/([\w-]+)\/?$/)?.[1];
  assert.ok(id, 'Build URL must be an HTTPS pob.codes/b/<id> link');
  const response = await fetch(`https://api.pob.codes/${id}/raw`);
  assert.ok(response.ok, `Build input HTTP ${response.status}`);
  const buildCode = (await response.text()).trim();
  return { buildCode, xmlHash: sha256(decodeBuildCode(buildCode)) };
}

export async function readCorePackage(origin = 'http://127.0.0.1:3010/') {
  let manifest, archive;
  if (new URL(origin).hostname === 'pob.codes') {
    const html = await (await fetch(origin)).text();
    const release = html.match(/\/import2\/releases\/([a-f0-9]{24})\//)?.[1];
    assert.ok(release, 'Live release pointer');
    const prefix = `https://pob.codes/import2/releases/${release}/payload/`;
    manifest = await (await fetch(`${prefix}manifest.json`)).json();
    archive = Buffer.from(await (await fetch(`${prefix}packages/${manifest.packages.find(p => p.id === 'core').sha256}.zip`)).arrayBuffer());
  } else {
    const root = new URL('../../.runtime/payload/', import.meta.url);
    manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
    archive = await readFile(new URL(`packages/${manifest.packages.find(p => p.id === 'core').sha256}.zip`, root));
  }
  assert.equal(sha256(archive), manifest.packages.find(p => p.id === 'core').sha256, 'Core package identity');
  return { manifest, archive };
}

// New modules export an ordered transforms array. Legacy item-hover modules work unchanged.
export async function loadSourceTransforms(paths, legacyPath = 'Classes/ItemsTab.lua') {
  const transforms = [], modules = [];
  for (const path of paths) {
    const module = await import(pathToFileURL(resolve(path)).href);
    const entries = module.transforms ?? [{ path: module.path ?? legacyPath, transform: module.transform }, ...(module.additionalTransforms ?? [])];
    for (const entry of entries) {
      assert.equal(typeof entry.path, 'string', 'Transform path required');
      assert.equal(typeof entry.transform, 'function', 'Source transform must be a function');
      transforms.push(entry);
    }
    modules.push({ sha256: sha256(await readFile(path)), experiment: module.experiment, transformationEvidence: module.transformationEvidence });
  }
  return { transforms, modules };
}

export function rewriteCorePackage({ manifest: original, archive }, transforms) {
  const manifest = structuredClone(original);
  const core = manifest.packages.find(p => p.id === 'core');
  assert.equal(sha256(archive), core.sha256, 'Core package identity');
  const sourceCoreHash = core.sha256;
  const zip = new AdmZip(archive), evidence = [];
  for (const { path, transform } of transforms) {
    const file = core.files.find(f => f.path === path);
    assert.ok(file && zip.getEntry(path), 'Transform source must belong to core package');
    const before = zip.readAsText(path), after = transform(before);
    assert.equal(typeof after, 'string', 'Transform must return source text');
    const content = Buffer.from(after);
    evidence.push({ path, before: sha256(before), after: sha256(after) });
    zip.updateFile(path, content);
    core.uncompressedBytes += content.length - file.bytes;
    file.bytes = content.length;
  }
  const bytes = zip.toBuffer();
  core.bytes = bytes.length;
  core.sha256 = sha256(bytes);
  return { manifest, core, bytes, sourceCoreHash, evidence };
}

export async function routeCorePackage(context, overlay) {
  await context.route('**/payload/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(overlay.manifest) }));
  await context.route(`**/payload/packages/${overlay.core.sha256}.zip`, route => route.fulfill({ contentType: 'application/octet-stream', body: overlay.bytes }));
}
