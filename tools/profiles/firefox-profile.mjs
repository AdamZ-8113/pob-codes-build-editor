import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { sha256 } from './core-package-overlay.mjs';
const require = createRequire(new URL('../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');

export function verifyFirefoxAutomation(archive) {
  const zip = new AdmZip(archive);
  const entries = ['Runtime.js', 'WorkerMain.js'].map(name => {
    const entry = zip.getEntries().find(entry => entry.entryName.endsWith(`/content/${name}`) && entry.entryName.includes('juggler'));
    assert.ok(entry, 'Firefox automation sources must be inspectable for performance measurements');
    const source = zip.readAsText(entry);
    assert.match(source, /allowUnobservedWasm\s*=\s*true/, 'Firefox automation pins Wasm to the debugging tier; use a browser with the upstream allowUnobservedWasm fix');
    return {name, sha256:sha256(source)};
  });
  return {omniSha256:sha256(archive), entries, wasmOptimizationAllowed:true};
}

export async function firefoxProfileEvidence(executable) {
  for (const relative of ['browser/omni.ja', 'omni.ja']) {
    const bytes = await readFile(join(dirname(executable), relative)).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (!bytes) continue;
    const zip = new AdmZip(bytes);
    if (zip.getEntries().some(entry => entry.entryName.includes('juggler') && entry.entryName.endsWith('/Runtime.js'))) {
      return verifyFirefoxAutomation(bytes);
    }
  }
  throw new Error('Firefox performance probe requires inspectable Juggler automation sources');
}
