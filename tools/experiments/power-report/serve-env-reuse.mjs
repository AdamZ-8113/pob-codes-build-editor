// Manual-testing proxy for the power-report setup-reuse experiment.
//
// Serves the running loopback dev server (127.0.0.1:3010) on 127.0.0.1:3011 with
// only the payload manifest and core package replaced by the env-reuse-pob.mjs
// transform. Nothing on disk changes: stop this process and 3011 is gone, while
// 3010 keeps serving the unmodified editor for side-by-side comparison.
//
// Usage: npm run dev   (separate terminal)
//        node tools/experiments/power-report/serve-env-reuse.mjs [--baseline]
// --baseline serves the unmodified core through the same proxy, for a fair A/B.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readCorePackage, rewriteCorePackage, loadSourceTransforms } from '../../profiles/core-package-overlay.mjs';

const upstream = new URL('http://127.0.0.1:3010/');
const port = 3011;
const baseline = process.argv.includes('--baseline');

const source = await readCorePackage(upstream.href);
const transform = fileURLToPath(new URL('./env-reuse-pob.mjs', import.meta.url));
const { transforms } = await loadSourceTransforms(baseline ? [] : [transform], 'Classes/CalcsTab.lua');
const overlay = rewriteCorePackage(source, transforms);
const manifestBody = Buffer.from(JSON.stringify(overlay.manifest));
const corePath = `/payload/packages/${overlay.core.sha256}.zip`;
assert.ok(baseline || overlay.core.sha256 !== source.manifest.packages.find(p => p.id === 'core').sha256, 'Transform changed the core package');

const server = createServer((req, res) => {
  const path = new URL(req.url, upstream).pathname;
  const replaced = path === '/payload/manifest.json' ? manifestBody : path === corePath ? overlay.bytes : null;
  const headers = { ...req.headers, host: upstream.host };
  delete headers.origin;
  delete headers.referer;
  // Replaced files are requested upstream as the original manifest so the dev
  // server supplies its normal headers; only the body is substituted.
  const upstreamPath = replaced && path === corePath
    ? `/payload/packages/${source.manifest.packages.find(p => p.id === 'core').sha256}.zip` : req.url;
  const forward = httpRequest({ host: upstream.hostname, port: upstream.port, method: req.method, path: upstreamPath, headers }, upstreamRes => {
    if (!replaced) {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }
    upstreamRes.resume();
    const out = { ...upstreamRes.headers, 'content-length': String(replaced.length), 'cache-control': 'no-store' };
    delete out.etag;
    delete out['last-modified'];
    delete out['transfer-encoding'];
    res.writeHead(200, out).end(replaced);
    if (path === corePath) console.log(`${new Date().toLocaleTimeString()} served ${baseline ? 'baseline' : 'patched'} core ${overlay.core.sha256.slice(0, 12)}`);
  });
  forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Dev server on 127.0.0.1:3010 is not reachable'); });
  req.pipe(forward);
});
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(port, '127.0.0.1', () => {
  console.log(`${baseline ? 'Baseline' : 'Setup-reuse experiment'} editor: http://127.0.0.1:${port}/`);
  console.log(`Unmodified editor stays on ${upstream.href}. Press Ctrl+C to stop.`);
  if (!baseline) for (const e of overlay.evidence) console.log(`  patched ${e.path}`);
});
