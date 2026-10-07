import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSourceLedger } from '../../scripts/build/source-ledger.mjs';
import { applyStatusTextPatch } from '../../scripts/patches/status-text-patch.mjs';

const root = process.cwd();
const { pin } = await validateSourceLedger(root);
const adapter = pin.adapters.compactStatusText;
const patch = await readFile(adapter.patchFile);
const prepared = `.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}`;
const preparedAvailable = await readFile(`${prepared}/src/Classes/GemSelectControl.lua`).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

test('compact status text adapter changes only the three accepted UI paths and rejects drift', { skip: !preparedAvailable }, async () => {
  for (const path of Object.keys(adapter.sourceBlobHashes)) {
    let source = await readFile(`${prepared}/${path}`, 'utf8');
    if (path === 'src/Classes/GemSelectControl.lua') {
      const { applyGemHoverPatch } = await import('../../scripts/patches/gem-hover-patch.mjs');
      const gemPatch = await readFile(pin.adapters.gemDropdownHover.patchFile);
      source = applyGemHoverPatch(source, gemPatch, pin.adapters.gemDropdownHover);
    }
    const result = applyStatusTextPatch(source, patch, adapter, path);
    assert.notEqual(result, source);
    assert.throws(() => applyStatusTextPatch(`${source}\n`, patch, adapter, path), /identity/);
    assert.throws(() => applyStatusTextPatch(result, patch, adapter, path), /identity/);
  }
});
