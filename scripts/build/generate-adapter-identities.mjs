// Candidate generation only. Normal packing must independently verify all
// generated identities; this command never installs a pin or edits its source.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PACK_STAGES} from './upstream-drift.mjs';
import {transformBuildListPendingPatch} from '../patches/build-list-pending-patch.mjs';
import {transformBrowserUiDefaults} from '../../upstream/packages/packer/src/ui-defaults-adapter.ts';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(option('source-root') && option('pin') && option('out'), 'Required: --source-root=<authored final layer> --pin=<candidate pin> --out=<new file>');
const source = resolve(option('source-root'));
const pin = JSON.parse(await readFile(option('pin'), 'utf8'));
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const prepared = {}, current = {};
for (const [path, expected] of Object.entries(pin.compositePatch.resultBlobHashes)) {
  assert.equal(blob((await readFile(join(source,path),'utf8')).replaceAll('\r\n','\n')), expected, `Authored source matches generated composite: ${path}`);
}
for (const adapter of Object.values(pin.adapters)) {
  for (const path of Object.keys({...adapter.preparedSourceBlobHashes, ...adapter.sourceBlobHashes, ...adapter.resultBlobHashes})) {
    if (!(path in prepared)) prepared[path] = current[path] = (await readFile(join(source,path),'utf8')).replaceAll('\r\n','\n');
  }
}
for (const [name, transform] of [...PACK_STAGES, ['buildListPendingFolders', transformBuildListPendingPatch]]) {
  const adapter = pin.adapters[name], patch = await readFile(adapter.patchFile);
  assert.equal(createHash('sha256').update(patch).digest('hex'), adapter.patchSha256, `${name}: retained patch identity`);
  for (const path of Object.keys(adapter.sourceBlobHashes)) {
    if (adapter.preparedSourceBlobHashes) adapter.preparedSourceBlobHashes[path] = blob(prepared[path]);
    adapter.sourceBlobHashes[path] = blob(current[path]);
    current[path] = transform(current[path], patch, path);
    adapter.resultBlobHashes[path] = blob(current[path]);
  }
}
for (const [name, adapter] of Object.entries(pin.adapters).filter(([,adapter]) => !adapter.patchFile)) {
  for (const path of Object.keys(adapter.resultBlobHashes)) {
    if (adapter.sourceBlobHashes) adapter.sourceBlobHashes[path] = blob(prepared[path]);
    adapter.resultBlobHashes[path] = blob(name === 'browserUiDefaults' ? transformBrowserUiDefaults(prepared[path]) : prepared[path]);
  }
}
for (const path of Object.keys(pin.generated.masteryModCacheSupplement.sourceBlobHashes)) {
  pin.generated.masteryModCacheSupplement.sourceBlobHashes[path] = blob((await readFile(join(source,path),'utf8')).replaceAll('\r\n','\n'));
}
// The generated ModCache result must come from its actual generator and fresh
// parser verification. Do not guess it from the new input identity.
await writeFile(option('out'), JSON.stringify(pin,null,2)+'\n', {flag:'wx'});
console.log('Candidate adapter identities generated; pack and ModCache verification remain required.');
