import { chromium } from '@playwright/test';
import { browserChannel } from '../../scripts/lib/browser-channel.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const prefix = 'pob-import2-';
const markNames = ['shell-start', 'first-pob-frame', 'editor-ready', 'payload-ready'];

export function startupTarget(origin) {
  const target = new URL(origin);
  assert.equal(target.protocol, 'http:', 'Startup profiling is local-only');
  assert.equal(target.hostname, '127.0.0.1', 'Startup profiling requires loopback');
  assert.ok(!target.username && !target.password && !target.search && !target.hash, 'Use a plain loopback base path');
  target.pathname = target.pathname.replace(/\/+$/, '') + '/';
  return target;
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length,
    p50: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * .95) - 1] };
}

async function artifactIdentity(target, directory, sourceIdentity) {
  const get = async path => {
    const response = await fetch(new URL(path, target), { redirect: 'error' });
    assert.equal(response.status, 200, 'Missing served artifact identity');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (directory) assert.equal(sha256(bytes), sha256(await readFile(join(directory, target.pathname, path))), 'Served bytes must match the snapshot');
    return bytes;
  };
  if (target.pathname === '/') {
    const provenance = JSON.parse(await get('payload/provenance.json'));
    return { mode: 'development', sourceRevision: provenance.sourceRevision, manifestSha256: provenance.manifestSha256 };
  }
  assert.ok(directory, 'Built profiling requires --artifact=<snapshot directory>');
  assert.match(sourceIdentity?.head ?? '', /^[a-f0-9]{40}$/, 'Record the source HEAD at materialization');
  assert.match(sourceIdentity?.workingDiffSha256 ?? '', /^[a-f0-9]{64}$/, 'Record the working source diff hash at materialization');
  const release = JSON.parse(await get('release.json'));
  assert.match(release.current, /^[a-f0-9]{24}$/);
  assert.equal(release.publicCommit, sourceIdentity.head);
  const payload = `releases/${release.current}/payload/`;
  const provenanceBytes = await get(payload + 'provenance.json');
  assert.equal(sha256(provenanceBytes), release.payloadProvenanceSha256);
  assert.equal(sha256(await get(payload + 'manifest.json')), release.payloadManifestSha256);
  const provenance = JSON.parse(provenanceBytes);
  assert.equal(provenance.sourceRevision, release.sourceRevision);
  return { mode: 'built', generation: release.current, sourceRevision: release.sourceRevision,
    sourceIdentity, binaryIdentities: release.binaryIdentities,
    manifestSha256: release.payloadManifestSha256, provenanceSha256: release.payloadProvenanceSha256 };
}

// Routing disables HTTP cache. A dead loopback proxy instead blocks external
// traffic while Chromium bypasses loopback, preserving the warm-cache sample.
export async function profileStartup({ origin = process.env.DESKTOP_POB_ORIGIN ?? 'http://127.0.0.1:3010',
  artifactDirectory, sourceIdentity, runs = 5, legacy = false } = {}) {
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10, 'Runs must be an integer from 1 to 10');
  const target = startupTarget(origin);
  const provenance = await artifactIdentity(target, artifactDirectory, sourceIdentity);
  assert.ok(!legacy || provenance.mode === 'development', 'Legacy payload exists only on the development server');
  const launches = [];
  let browserVersion;
  for (let run = 0; run < runs; run++) {
    const browser = await chromium.launch({ headless: true, channel: browserChannel(),
      args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1'] });
    browserVersion = browser.version();
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      await context.addInitScript(() => {
        // Identical RAF observation in old/new builds; exact marks are separate.
        const observe = () => {
          if (window.__DESKTOP_POB__?.ready) performance.mark('startup-profile-ready-observed');
          else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      });
      const page = await context.newPage();
      let faults = 0, consoleErrors = 0, externalRequests = 0;
      page.on('pageerror', () => faults++);
      page.on('console', message => {
        // Existing optional textures return 404; their paths are checked below.
        if (message.type() === 'error' && !message.text().includes('404 (Not Found)')) consoleErrors++;
      });
      page.on('request', request => { if (new URL(request.url()).origin !== target.origin) externalRequests++; });
      const missing = [];
      page.on('response', response => {
        if (response.status() >= 400) missing.push({ status: response.status(), path: new URL(response.url()).pathname });
      });
      for (const cache of ['cold', 'warm']) {
        faults = consoleErrors = externalRequests = 0;
        missing.length = 0;
        const navigation = new URL(target);
        if (legacy) navigation.searchParams.set('legacyPayload', '1');
        const begin = performance.now();
        await page.goto(navigation.href);
        await page.waitForFunction(() => performance.getEntriesByName('startup-profile-ready-observed').length || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120_000 });
        const readyMs = performance.now() - begin;
        if (provenance.mode === 'built') await page.waitForFunction(() => performance.getEntriesByName('pob-import2-payload-ready').length, null, { timeout: 120_000 });
        await page.waitForTimeout(1500);
        const sample = await page.evaluate(({ prefix, markNames }) => {
          const h = window.__DESKTOP_POB__;
          const marks = Object.fromEntries(markNames.map(name => [name, performance.getEntriesByName(prefix + name)[0]?.startTime ?? null]));
          return { frames: h.frames, errorCount: h.errors.length, marks,
            paint: Object.fromEntries(performance.getEntriesByType('paint').map(entry => [entry.name, entry.startTime])),
            readyObserved: performance.getEntriesByName('startup-profile-ready-observed')[0]?.startTime,
            resourceBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.transferSize, 0) };
        }, { prefix, markNames });
        assert.equal(sample.errorCount + faults + consoleErrors + externalRequests, 0, 'Startup must have no runtime/console errors or external requests');
        for (const response of missing) {
          assert.ok(response.status === 404 && /\/TreeData\/(PassiveMasteryConnectedButton\.png|bloodline-3\.webp|ascendancy-3\.webp)$/.test(response.path), 'Unexpected missing startup asset');
        }
        const profile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
        await page.waitForTimeout(250);
        const idleFrames = (await page.evaluate(() => window.__DESKTOP_POB__.frames)) - sample.frames;
        assert.equal(idleFrames, 0, 'Settled startup must not redraw indefinitely');
        if (provenance.mode === 'built') for (const name of ['shell-start', 'first-pob-frame', 'payload-ready']) assert.ok(Number.isFinite(sample.marks[name]), `Missing ${name}`);
        launches.push({ run, cache, readyMs, idleFrames, ...sample,
          firstFrameToReadyObservedMs: sample.marks['first-pob-frame'] === null ? null : sample.readyObserved - sample.marks['first-pob-frame'],
          firstFrameToEditorReadyMs: sample.marks['editor-ready'] === null ? null : sample.marks['editor-ready'] - sample.marks['first-pob-frame'],
          profile: { startupPhases: profile.startupPhases },
          packagesBeforeReady: profile.filesystem.payload?.packagesBeforeReady,
          bytesBeforeReady: profile.filesystem.payload?.bytesBeforeReady });
      }
    } finally { await browser.close(); }
  }
  const summaries = Object.fromEntries(['cold', 'warm'].map(cache => {
    const rows = launches.filter(row => row.cache === cache);
    return [cache, { fcp: distribution(rows.map(row => row.paint['first-contentful-paint'])),
      readyObserved: distribution(rows.map(row => row.readyObserved)),
      marks: Object.fromEntries(markNames.map(name => [name, distribution(rows.map(row => row.marks[name]))])),
      phases: Object.fromEntries([...new Set(rows.flatMap(row => Object.keys(row.profile.startupPhases ?? {})))].map(name =>
        [name, distribution(rows.map(row => row.profile.startupPhases[name]))])) }];
  }));
  return { schemaVersion: 2, browser: browserVersion, cpu: cpus()[0]?.model, logicalCores: cpus().length,
    viewport: { width: 1600, height: 1000, dpr: 1 }, build: 'release', payloadMode: legacy ? 'legacy' : 'packages',
    cacheProtocol: 'Cold: fresh browser process/context/storage. Warm: same-context reload. OS/server cache not cleared.',
    limitations: ['Ready observation is RAF-sampled; exact editor-ready mark is absent in older builds.',
      'CPU callbacks and paint entries do not measure GPU presentation or input-to-photon latency.'],
    provenance, summaries, launches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const report = await profileStartup({ runs: Number(option('runs') ?? 5), legacy: args.includes('--legacy'),
    artifactDirectory: option('artifact'), sourceIdentity: { head: option('source-head'), workingDiffSha256: option('source-diff-sha256') } });
  const output = args.find(arg => !arg.startsWith('--'));
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, launches: report.launches.map(({ profile, ...row }) => ({ ...row, phases: profile.startupPhases })) }));
}
