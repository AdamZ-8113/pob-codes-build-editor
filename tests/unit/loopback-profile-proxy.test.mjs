import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startProfileProxy } from '../../tools/profiles/loopback-profile-proxy.mjs';
import { sha256 } from '../../tools/profiles/core-package-overlay.mjs';

test('Firefox profiling serves identical seeded worker bytes and verified overlays on loopback only', async () => {
  const upstream = createServer((request, response) => response.end(request.url.endsWith('.wasm') ? 'wasm' : 'export default 1;'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const overlay = {manifest:{packages:[]}, core:{sha256:'abc'}, bytes:Buffer.from('archive')};
  const proxy = await startProfileProxy(`http://127.0.0.1:${upstream.address().port}/import2/`, overlay);
  try {
    for (const file of ['driver.mjs', 'driver-ABC.js']) {
      const response = await fetch(new URL(file, proxy.origin));
      assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
      assert.match(await response.text(), /^Date.now = .*export default 1;/s);
    }
    assert.equal(proxy.evidence.seededRequests, 2);
    await fetch(new URL('driver-ABC.wasm', proxy.origin));
    assert.deepEqual([...proxy.evidence.wasmHashes], [sha256('wasm')]);
    assert.deepEqual(await (await fetch(new URL('payload/manifest.json', proxy.origin))).json(), overlay.manifest);
    assert.equal(await (await fetch(new URL('payload/packages/abc.zip', proxy.origin))).text(), 'archive');
    assert.equal((await fetch(proxy.origin, {method:'POST'})).status, 403);
    await assert.rejects(startProfileProxy('https://example.com', overlay));
  } finally {
    await proxy.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
});
