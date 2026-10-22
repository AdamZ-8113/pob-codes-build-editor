// Fresh-process actual-app A/B smoke for native buffering and bytecode experiments.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { canonicalExportTree } from '../../../../scripts/lib/canonical-export.mjs';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const rounds = Number(option('rounds') ?? 3);
const origin = 'http://127.0.0.1:3010';
const variants = (option('variants') ?? 'baseline').split(',');
const allowedVariants = new Set(['baseline', 'bytecode', 'stdio-256k']);
const bytecodeOverlayOption = option('bytecode-overlay');
const driverDirectoryOption = option('driver-dir');
assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 10, 'rounds must be 1..10');
assert.equal(new Set(variants).size, variants.length, 'variants must be unique');
assert.ok(variants.length > 0 && variants.every(value => allowedVariants.has(value)), 'unsupported variant');
const usesBytecode = variants.includes('bytecode');
const usesStdio = variants.includes('stdio-256k');
assert.equal(usesBytecode, Boolean(bytecodeOverlayOption), 'bytecode requires an explicit bytecode overlay, which is rejected when the arm is absent');
assert.equal(usesBytecode || usesStdio, Boolean(driverDirectoryOption), 'experimental driver arms require an explicit --driver-dir, which is rejected when those arms are absent');
const originUrl = new URL(origin);

const fixture = (await readFile(resolve(root, 'fixtures/guided import parity desktop 329.txt'), 'utf8')).trim();
const manifest = JSON.parse(await readFile(resolve(root, '.runtime/payload/manifest.json'), 'utf8'));
const packages = new Map();
for (const entry of manifest.packages) {
  const bytes = await readFile(resolve(root, '.runtime/payload/packages', `${entry.sha256}.zip`));
  assert.equal(sha256(bytes), entry.sha256, `Payload package identity mismatch for ${entry.id}`);
  assert.equal(bytes.byteLength, entry.bytes, `Payload package byte count mismatch for ${entry.id}`);
  packages.set(entry.sha256, bytes);
}
const bytecode = usesBytecode ? await loadBytecodeInputs(bytecodeOverlayOption, driverDirectoryOption) : undefined;
const stdio = usesStdio ? await loadStdioDriver(driverDirectoryOption) : undefined;

const stamp = new Date().toISOString().replaceAll(/[:.]/g, '');
const outputDirectory = resolve(option('output') ?? join(root, 'tmp/compiled-calcs-expanded/2026-10-11', `${stamp}-app-smoke`));
await mkdir(outputDirectory, { recursive: true });
const samples = [];
const server = await startServer();
try {
  // Prime only the Vite transform cache. Every recorded sample still gets a new
  // browser process, user-data directory, HTTP cache, worker and Lua state.
  const preflight = await runSample('baseline', -1, true);
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...variants].reverse() : variants;
    for (const variant of order) samples.push(await runSample(variant, round, false));
  }

  const canonicalHashes = new Set(samples.map(sample => sample.output.canonicalExportSha256));
  const playerStatHashes = new Set(samples.map(sample => sample.output.playerStatsSha256));
  assert.equal(canonicalHashes.size, 1, 'Actual-app canonical build export differs across arms');
  assert.equal(playerStatHashes.size, 1, 'Actual-app exported PlayerStat values differ across arms');
  const report = {
    generatedAt: new Date().toISOString(),
    experiment: 'actual-app-source-loading-smoke',
    scope: {
      app: 'normal displayed release runtime through window.__DESKTOP_POB__',
      fixture: 'public guided import fixture; raw fixture and exports omitted',
      network: 'owned watch-free Vite server on loopback; payload bytes pinned in memory; external requests blocked',
      cache: 'one excluded Vite preflight, then a fresh Chrome process and profile for every sample',
      query: 'none; shipped local defaults (eager helpers and payload prefetch) run in every arm',
      bytecodeTarget: usesBytecode ? 'bytecode arm only: retained payload overlay and explicit isolated full driver; helper worker source remains unchanged' : undefined,
      stdioTarget: usesStdio ? 'stdio arm only: normal source payload with an explicit unprofiled 256 KiB stdio driver' : undefined,
      instrumentation: 'payload and worker-response routing is symmetric; no profile RPC occurs before the timed first import completes; post-import profile snapshots retain immutable startup marks',
      payloadSnapshotTiming: 'post-import diagnostic snapshot; startup package/request sequencing is not inferred from this later snapshot',
      parity: 'canonical exported XML and saved PlayerStat elements; transient unsaved calculation tables are outside this smoke',
    },
    identities: {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      fixtureSha256: sha256(fixture),
      manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
      packageSha256: manifest.packages.map(entry => ({ id: entry.id, sha256: entry.sha256 })),
      harnessSha256: sha256(await readFile(new URL(import.meta.url))),
      workerSourceSha256: sha256(await readFile(resolve(root, 'upstream/packages/driver/src/js/worker.ts'))),
      viteConfigSha256: sha256(await readFile(resolve(root, 'upstream/vite.local.config.ts'))),
      bytecode: bytecode?.identity,
      stdio: stdio?.identity,
    },
    preflight: { excludedFromTiming: true, separateProcessAndProfile: true, workerResponse: preflight.workerResponse },
    samples,
    comparisons: compare(samples),
  };
  await writeFile(resolve(outputDirectory, 'raw.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, 'summary.md'), renderSummary(report));
  console.log(JSON.stringify({ evidenceDirectory: relative(root, outputDirectory), comparisons: report.comparisons }, null, 2));
} finally {
  await server.close();
}

async function runSample(variant, round, excluded) {
  const processStarted = performance.now();
  const profileDirectory = await mkdtemp(join(tmpdir(), 'pob-app-smoke-'));
  let context;
  const faults = [];
  const routeStats = { manifest: 0, packages: 0, externalBlocked: 0, worker: 0 };
  const workerResponse = [];
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chrome', headless: true, serviceWorkers: 'block',
      viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1,
    });
    await context.routeWebSocket('**', socket => socket.close());
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestUrl.hostname)) {
        routeStats.externalBlocked++;
        await route.abort('blockedbyclient');
        return;
      }
      const isBytecode = variant === 'bytecode';
      const isStdio = variant === 'stdio-256k';
      const experimentalDriver = isBytecode ? bytecode : isStdio ? stdio : undefined;
      if (requestUrl.pathname === '/payload/manifest.json') {
        routeStats.manifest++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(isBytecode ? bytecode.manifest : manifest) });
        return;
      }
      const packageMatch = requestUrl.pathname.match(/^\/payload\/packages\/([a-f0-9]{64})\.zip$/);
      if (packageMatch) {
        const bytes = (isBytecode ? bytecode.packages.get(packageMatch[1]) : undefined) ?? packages.get(packageMatch[1]);
        assert.ok(bytes, 'App requested a package outside the pinned manifest');
        routeStats.packages++;
        await route.fulfill({ contentType: 'application/octet-stream', body: bytes });
        return;
      }
      if (experimentalDriver && requestUrl.pathname.endsWith('/upstream/packages/driver/dist/release/driver.mjs')) {
        routeStats.driverMjs = (routeStats.driverMjs ?? 0) + 1;
        await route.fulfill({ contentType: 'text/javascript', body: experimentalDriver.driverMjs });
        return;
      }
      if (experimentalDriver && requestUrl.pathname.endsWith('/upstream/packages/driver/dist/release/driver.wasm')) {
        routeStats.driverWasm = (routeStats.driverWasm ?? 0) + 1;
        await route.fulfill({ contentType: 'application/wasm', body: experimentalDriver.driverWasm });
        return;
      }
      if (requestUrl.pathname.endsWith('/upstream/packages/driver/src/js/worker.ts') && requestUrl.searchParams.has('worker_file')) {
        routeStats.worker++;
        const response = await route.fetch();
        const before = await response.text();
        workerResponse.push({ sourceSha256: sha256(before), servedSha256: sha256(before), patched: false });
        await route.fulfill({ response, body: before });
        return;
      }
      await route.continue();
    });

    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => faults.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().startsWith('[vite] failed to connect to websocket.')) faults.push(message.text());
    });
    const navigationStarted = performance.now();
    await page.goto(`${originUrl.href.replace(/\/$/, '')}/`);
    await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120_000 });
    const navigationToReadyMs = performance.now() - navigationStarted;
    const browserProcessToReadyMs = performance.now() - processStarted;
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    assert.deepEqual(faults, []);

    const preImportProfileReadMs = 0;
    const importStarted = performance.now();
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    const firstImportMs = performance.now() - importStarted;
    const navigationToFirstImportCompleteMs = performance.now() - navigationStarted;
    const processToFirstImportCompleteMs = performance.now() - processStarted;
    const result = await page.evaluate(async () => {
      const code = await window.__DESKTOP_POB__.getBuildCode();
      const profile = await window.__DESKTOP_POB__.getRuntimeProfile();
      return { code, profile, errors: window.__DESKTOP_POB__.errors, frames: window.__DESKTOP_POB__.frames };
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(faults, []);
    assert.equal(routeStats.worker, 1, 'Expected exactly one displayed-runtime worker response');
    assert.equal(routeStats.manifest, 1, 'Expected exactly one payload manifest request');
    assert.ok(routeStats.packages > 0, 'Expected pinned payload package requests');
    if (variant === 'bytecode' || variant === 'stdio-256k') {
      assert.ok(routeStats.driverMjs > 0 && routeStats.driverWasm > 0, `${variant} arm did not load the explicit isolated driver`);
    }

    const xml = inflateSync(Buffer.from(result.code, 'base64url')).toString('utf8');
    const parsed = await page.evaluate(xmlText => {
      const document = new DOMParser().parseFromString(xmlText, 'application/xml');
      if (document.querySelector('parsererror')) throw new Error('Exported build XML could not be parsed');
      const walk = node => node.nodeType === 1
        ? [node.tagName, [...node.attributes].map(attribute => [attribute.name, attribute.value]),
          [...node.childNodes].map(walk).filter(value => value !== null)]
        : node.textContent.trim() || null;
      const playerStats = [...document.querySelectorAll('PlayerStat')].map(node =>
        [...node.attributes].map(attribute => [attribute.name, attribute.value]).sort(([a], [b]) => a.localeCompare(b)));
      return { tree: walk(document.documentElement), playerStats };
    }, xml);
    const canonical = canonicalExportTree(parsed.tree);
    return {
      variant, round, excluded,
      browserProcessToReadyMs,
      navigationToReadyMs, preImportProfileReadMs, firstImportMs,
      navigationToFirstImportCompleteMs, processToFirstImportCompleteMs,
      startupPhases: result.profile.startupPhases,
      payload: result.profile.filesystem?.payload,
      frames: result.frames,
      routeStats,
      workerResponse,
      output: {
        exactBuildCodeSha256: sha256(result.code),
        canonicalExportSha256: sha256(JSON.stringify(canonical)),
        playerStatsSha256: sha256(JSON.stringify(parsed.playerStats)),
        playerStatCount: parsed.playerStats.length,
      },
    };
  } finally {
    await context?.close().catch(() => {});
    await removeOwnedProfile(profileDirectory);
  }
}

async function loadBytecodeInputs(overlayOption, driverOption) {
  const overlayDirectory = resolve(root, overlayOption);
  const driverDirectory = resolve(root, driverOption);
  const [overlayManifest, identity, validation, driverIdentity, driverMjs, driverWasm] = await Promise.all([
    readFile(resolve(overlayDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(overlayDirectory, 'identity.json'), 'utf8').then(JSON.parse),
    readFile(resolve(overlayDirectory, 'validation.json'), 'utf8').then(JSON.parse),
    readFile(resolve(driverDirectory, 'identity.json'), 'utf8').then(JSON.parse),
    readFile(resolve(driverDirectory, 'driver.mjs')),
    readFile(resolve(driverDirectory, 'driver.wasm')),
  ]);
  assert.equal(validation.validated, true, 'Bytecode overlay validation did not pass');
  assert.equal(sha256(Buffer.from(JSON.stringify(overlayManifest))), identity.overlayManifestSha256, 'Bytecode overlay manifest identity mismatch');
  assert.equal(sha256(Buffer.from(JSON.stringify(manifest))), identity.sourceManifestSha256, 'Bytecode overlay source manifest drift');
  assert.equal(driverIdentity.compilerImage, identity.compilerImage, 'Overlay and isolated driver compiler images differ');
  assert.equal(driverIdentity.helperBootSha256, sha256(await readFile(resolve(root, 'upstream/packages/driver/helper-boot.lua'))), 'Isolated driver does not use the authoritative helper boot');
  assert.equal(driverIdentity.helperProfiled, false, 'Isolated app driver must not profile eager helpers');
  assert.equal(driverIdentity.binaryReopen, true, 'Isolated app driver must contain the checked binary-reopen fix');
  assert.ok(driverIdentity.buildIdentity?.startsWith(basename(driverDirectory)), 'Isolated driver directory does not match build identity');
  const overlayPackages = new Map();
  for (const entry of await readdir(resolve(overlayDirectory, 'packages'), { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.zip$/.test(entry.name)) continue;
    const expected = entry.name.slice(0, -4);
    const bytes = await readFile(resolve(overlayDirectory, 'packages', entry.name));
    assert.equal(sha256(bytes), expected, `Bytecode package identity mismatch: ${entry.name}`);
    overlayPackages.set(expected, bytes);
  }
  for (const selected of identity.packages) {
    const entry = overlayManifest.packages.find(candidate => candidate.id === selected.id);
    assert.equal(entry?.sha256, selected.overlaySha256, `Bytecode manifest package mismatch: ${selected.id}`);
    assert.ok(overlayPackages.has(selected.overlaySha256), `Bytecode package missing: ${selected.id}`);
  }
  assert.equal(overlayPackages.size, identity.packages.length, 'Unexpected bytecode package inventory');
  return {
    manifest: overlayManifest,
    packages: overlayPackages,
    driverMjs,
    driverWasm,
    identity: {
      overlayDirectory: relative(root, overlayDirectory),
      driverDirectory: relative(root, driverDirectory),
      overlayManifestSha256: identity.overlayManifestSha256,
      sourceManifestSha256: identity.sourceManifestSha256,
      driverBuildIdentity: driverIdentity.buildIdentity,
      helperBootSha256: driverIdentity.helperBootSha256,
      helperProfiled: driverIdentity.helperProfiled,
      binaryReopen: driverIdentity.binaryReopen,
      driverMjsSha256: sha256(driverMjs),
      driverWasmSha256: sha256(driverWasm),
      validation,
    },
  };
}

async function loadStdioDriver(driverOption) {
  const driverDirectory = resolve(root, driverOption);
  const [driverIdentity, driverMjs, driverWasm, helperBoot] = await Promise.all([
    readFile(resolve(driverDirectory, 'identity.json'), 'utf8').then(JSON.parse),
    readFile(resolve(driverDirectory, 'driver.mjs')),
    readFile(resolve(driverDirectory, 'driver.wasm')),
    readFile(resolve(root, 'upstream/packages/driver/helper-boot.lua')),
  ]);
  assert.ok(driverIdentity.buildIdentity?.startsWith(basename(driverDirectory)), 'Stdio driver directory does not match build identity');
  assert.equal(driverIdentity.helperBootSha256, sha256(helperBoot), 'Stdio driver does not use the authoritative helper boot');
  assert.equal(driverIdentity.helperProfiled, false, 'Stdio app driver must not profile eager helpers');
  assert.equal(driverIdentity.binaryReopen, true, 'Stdio app driver must contain the checked binary-reopen fix');
  assert.equal(driverIdentity.stdioBufferBytes, 256 * 1024, 'Stdio app driver must use the validated 256 KiB stdio buffer');
  return {
    driverMjs,
    driverWasm,
    identity: {
      driverDirectory: relative(root, driverDirectory),
      driverBuildIdentity: driverIdentity.buildIdentity,
      compilerImage: driverIdentity.compilerImage,
      helperBootSha256: driverIdentity.helperBootSha256,
      helperProfiled: driverIdentity.helperProfiled,
      binaryReopen: driverIdentity.binaryReopen,
      stdioBufferBytes: driverIdentity.stdioBufferBytes,
      driverMjsSha256: sha256(driverMjs),
      driverWasmSha256: sha256(driverWasm),
    },
  };
}

async function removeOwnedProfile(path) {
  const resolved = resolve(path);
  const temporaryRoot = await realpath(tmpdir());
  const actual = await realpath(resolved);
  assert.equal(dirname(actual).toLowerCase(), temporaryRoot.toLowerCase(), 'Browser profile escaped the OS temporary directory');
  assert.match(basename(actual), /^pob-app-smoke-[A-Za-z0-9_-]+$/, 'Unexpected browser profile name');
  const stat = await lstat(actual);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Browser profile must be an owned directory');
  await rm(actual, { recursive: true, force: true });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compare(values) {
  const result = {};
  for (const variant of variants) {
    const arm = values.filter(sample => sample.variant === variant);
    result[variant] = {
      samples: arm.length,
      medianNavigationToReadyMs: median(arm.map(sample => sample.navigationToReadyMs)),
      medianNavigationToFirstImportCompleteMs: median(arm.map(sample => sample.navigationToFirstImportCompleteMs)),
      medianProcessToFirstImportCompleteMs: median(arm.map(sample => sample.processToFirstImportCompleteMs)),
      medianPreImportProfileReadMs: median(arm.map(sample => sample.preImportProfileReadMs)),
      medianFirstImportMs: median(arm.map(sample => sample.firstImportMs)),
      medianLuaReadyMs: median(arm.map(sample => sample.startupPhases.luaReadyMs)),
    };
  }
  if (result.baseline) for (const variant of variants.filter(value => value !== 'baseline')) {
    const candidate = result[variant];
    result[`${variant}VsBaseline`] = {
      readyRatio: result.baseline.medianNavigationToReadyMs / candidate.medianNavigationToReadyMs,
      navigationToFirstImportRatio: result.baseline.medianNavigationToFirstImportCompleteMs / candidate.medianNavigationToFirstImportCompleteMs,
      processToFirstImportRatio: result.baseline.medianProcessToFirstImportCompleteMs / candidate.medianProcessToFirstImportCompleteMs,
      firstImportRatio: result.baseline.medianFirstImportMs / candidate.medianFirstImportMs,
      luaReadyRatio: result.baseline.medianLuaReadyMs / candidate.medianLuaReadyMs,
    };
  }
  return result;
}

function renderSummary(report) {
  const lines = [
    '# Actual-app source-loading smoke', '',
    `Fresh recorded browser processes: ${report.samples.length}.`,
    `Canonical export parity: ${new Set(report.samples.map(sample => sample.output.canonicalExportSha256)).size === 1 ? 'exact' : 'mismatch'}.`,
    `Saved PlayerStat parity: ${new Set(report.samples.map(sample => sample.output.playerStatsSha256)).size === 1 ? 'exact' : 'mismatch'}.`, '',
    '## Medians', '',
  ];
  for (const [variant, value] of Object.entries(report.comparisons).filter(([, value]) => 'samples' in value)) {
    lines.push(`- ${variant}: navigation to ready ${value.medianNavigationToReadyMs.toFixed(1)} ms; navigation to imported build ${value.medianNavigationToFirstImportCompleteMs.toFixed(1)} ms; process to imported build ${value.medianProcessToFirstImportCompleteMs.toFixed(1)} ms; first import call ${value.medianFirstImportMs.toFixed(1)} ms; pre-import profile read ${value.medianPreImportProfileReadMs.toFixed(1)} ms; Lua ready ${value.medianLuaReadyMs.toFixed(1)} ms.`);
  }
  for (const [label, value] of Object.entries(report.comparisons).filter(([, value]) => !('samples' in value)))
    lines.push('', `${label}: ready ${value.readyRatio.toFixed(3)}x; navigation-to-import ${value.navigationToFirstImportRatio.toFixed(3)}x; process-to-import ${value.processToFirstImportRatio.toFixed(3)}x; first import call ${value.firstImportRatio.toFixed(3)}x; Lua ready ${value.luaReadyRatio.toFixed(3)}x.`);
  lines.push('', 'Parity covers the canonical exported build XML and its saved PlayerStat elements. It does not claim equality for transient calculation tables that are absent from the export.', '');
  return `${lines.join('\n')}\n`;
}

async function startServer() {
  const viteEntry = resolve(root, 'upstream/node_modules/vite/dist/node/index.js');
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  const server = await createServer({
    configFile: resolve(root, 'upstream/vite.local.config.ts'),
    define: { __DESKTOP_DEV_LAN_HOSTS__: JSON.stringify([]) },
    server: { hmr: false, watch: null },
  });
  await server.listen();
  return server;
}
