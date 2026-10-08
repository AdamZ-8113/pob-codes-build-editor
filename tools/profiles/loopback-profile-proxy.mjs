import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sha256 } from './core-package-overlay.mjs';

// Firefox does not intercept worker fetches with Playwright routes. Serve the
// same diagnostic transformations over HTTP so UI and helper interpreters use
// identical Lua packages and hash seeds. Only an isolated loopback test uses it.
export async function startProfileProxy(origin, overlay) {
  const upstream = new URL(origin);
  assert.ok(['127.0.0.1', 'localhost'].includes(upstream.hostname));
  const evidence = { seededRequests: 0, wasmHashes: new Set() };
  const server = createServer(async (request, response) => {
    try {
      const target = new URL(request.url, upstream);
      if (target.origin !== upstream.origin || request.method !== 'GET') {
        response.writeHead(403).end(); return;
      }
      let body, type;
      if (target.pathname.endsWith('/payload/manifest.json')) {
        body = Buffer.from(JSON.stringify(overlay.manifest)); type = 'application/json';
      } else if (target.pathname.endsWith(`/payload/packages/${overlay.core.sha256}.zip`)) {
        body = overlay.bytes; type = 'application/octet-stream';
      } else {
        const fetched = await fetch(target);
        body = Buffer.from(await fetched.arrayBuffer());
        if (!fetched.ok) { response.writeHead(fetched.status).end(body); return; }
        type = fetched.headers.get('content-type') ?? 'application/octet-stream';
        if (/\/driver(?:-[\w-]+)?\.(?:mjs|js)$/.test(target.pathname)) {
          body = Buffer.concat([Buffer.from('Date.now = () => 1790812800000;\n'), body]);
          evidence.seededRequests++;
        }
        if (/\/driver(?:-[\w-]+)?\.wasm$/.test(target.pathname)) evidence.wasmHashes.add(sha256(body));
      }
      response.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}).end(body);
    } catch { response.writeHead(502).end('Local profiling upstream failed'); }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = new URL(origin); url.hostname = '127.0.0.1'; url.port = String(server.address().port);
  return { origin: url.href, evidence, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
