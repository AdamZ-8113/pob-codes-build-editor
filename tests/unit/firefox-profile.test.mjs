import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verifyFirefoxAutomation } from '../../tools/profiles/firefox-profile.mjs';
const require = createRequire(new URL('../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');

test('Firefox measurements reject debugging-tier automation in either page or worker runtime', () => {
  const archive = (runtime, worker) => {
    const zip = new AdmZip();
    for (const [name, flag] of [['Runtime.js',runtime],['WorkerMain.js',worker]]) {
      zip.addFile(`chrome/juggler/content/content/${name}`, Buffer.from(`const d = new Debugger();\nd.allowUnobservedWasm = ${flag};`));
    }
    return zip.toBuffer();
  };
  assert.equal(verifyFirefoxAutomation(archive(true,true)).wasmOptimizationAllowed, true);
  for (const pair of [[false,true],[true,false],[false,false]]) assert.throws(() => verifyFirefoxAutomation(archive(...pair)), /debugging tier/);
});
