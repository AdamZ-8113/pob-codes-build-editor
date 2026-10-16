import { chromium } from '@playwright/test';
import { browserChannel } from '../../scripts/lib/browser-channel.mjs';
import { publicConfig } from '../../scripts/lib/public-config.mjs';
import { createReleaseTestServer } from '../../scripts/release/serve-test-release.mjs';
import { distribution } from './profile-startup.mjs';
import { loadSourceTransforms, readCorePackage, rewriteCorePackage, routeCorePackage } from './core-package-overlay.mjs';
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Measures a homepage-style link launch (`#build=<pob.codes link>`) from
// navigation to the first frame of the imported build. A materialized release
// directory is served on loopback and the build resolver is answered from a
// local file; `--production` is an explicit, read-only live-site opt-in.
const prefix = 'pob-import2-';
const markNames = ['shell-start', 'link-resolved', 'import-start', 'first-pob-frame', 'editor-ready', 'payload-ready', 'imported-build-ready'];
const API = 'https://api.pob.codes';

export async function profileLinkImport({ releaseDirectory, production = false, buildLink, buildFile,
  resolverLatencyMs = 250, runs = 3, port = 3021, throttle, screenshotDirectory, label = 'candidate', overlays = [] }) {
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 20, 'Runs must be an integer from 1 to 20');
  assert.match(buildLink, /^https:\/\/pob\.codes\/b\/[A-Za-z0-9_-]{5,90}$/, 'Use a pob.codes/b/<id> link');
  const basePath = publicConfig().basePath;
  let server, origin;
  if (production) origin = publicConfig().siteOrigin;
  else {
    assert.ok(releaseDirectory && buildFile, 'Local profiling requires --release=<dir> and --build-file=<path>');
    server = await createReleaseTestServer(releaseDirectory);
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
    origin = `http://127.0.0.1:${port}`;
  }
  const code = buildFile ? (await readFile(buildFile, 'utf8')).trim() : undefined;
  const target = `${origin}${basePath}/#build=${encodeURIComponent(buildLink)}`;
  // Probe-only Lua instrumentation is routed in memory; the payload on disk is unchanged.
  const overlay = overlays.length ? rewriteCorePackage(await readCorePackage(), (await loadSourceTransforms(overlays)).transforms) : undefined;
  assert.ok(!overlay || !production, 'Overlays are local-only');
  const launches = [];
  let browserVersion;
  try {
    for (let run = 0; run < runs; run++) {
      const browser = await chromium.launch({ headless: true, channel: browserChannel() });
      browserVersion = browser.version();
      try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
        let resolverRequests = 0, blockedExternal = 0;
        if (!production) {
          await context.route(url => new URL(url).origin !== origin, async route => {
            const url = new URL(route.request().url());
            if (url.origin === API && /^\/[A-Za-z0-9_-]{5,90}\/raw$/.test(url.pathname) && route.request().method() === 'GET') {
              resolverRequests++;
              await new Promise(done => setTimeout(done, resolverLatencyMs));
              await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8',
                headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: code });
              return;
            }
            blockedExternal++;
            await route.abort();
          });
        }
        if (overlay) await routeCorePackage(context, overlay);
        await context.addInitScript(() => {
          const profile = window.__linkProfile = { frames: [], titles: [], ready: undefined, surfaceRemoved: undefined };
          let last = 0;
          const tick = () => {
            const host = window.__DESKTOP_POB__;
            if (host) {
              if (host.frames !== last) { last = host.frames; profile.frames.push([performance.now(), last]); }
              if (host.ready && profile.ready === undefined) profile.ready = performance.now();
            }
            if (profile.surfaceRemoved === undefined && document.readyState !== "loading" && !document.getElementById("startup-surface")) { profile.surfaceRemoved = performance.now(); profile.titleAtReveal = document.title; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          new MutationObserver(() => profile.titles.push([performance.now(), document.title]))
            .observe(document, { subtree: true, childList: true, characterData: true });
        });
        const page = await context.newPage();
        if (throttle) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttle.latencyMs,
            downloadThroughput: throttle.downMbps * 125_000, uploadThroughput: throttle.upMbps * 125_000 });
        }
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        // Request start/finish relative to navigation, including worker requests.
        const requestLog = [];
        const navigationStart = Date.now();
        if (process.env.LINK_PROFILE_REQUESTS === '1') {
          const started = new Map();
          context.on('request', request => started.set(request, Date.now() - navigationStart));
          context.on('requestfinished', request => requestLog.push({ path: new URL(request.url()).pathname.split('/').slice(-2).join('/').slice(0, 60),
            start: started.get(request), end: Date.now() - navigationStart }));
        }
        const consoleErrors = [];
        const watchConsole = message => {
          if (/error|warn/.test(message.type()) && !/404 \(Not Found\)/.test(message.text())) consoleErrors.push(message.text().slice(0, 500));
        };
        page.on('console', watchConsole);
        page.on('worker', worker => worker.on?.('console', watchConsole));
        await page.goto(target, { waitUntil: 'commit', timeout: 120_000 });
        await page.waitForFunction(() => performance.getEntriesByName('pob-import2-imported-build-ready').length
          || window.__DESKTOP_POB__?.errors.length, null, { timeout: 180_000, polling: 50 });
        await page.waitForTimeout(1500);
        const sample = await page.evaluate(({ prefix, markNames }) => {
          const profile = window.__linkProfile;
          const marks = Object.fromEntries(markNames.map(name => [name, performance.getEntriesByName(prefix + name)[0]?.startTime ?? null]));
          const visibleFrom = Math.max(marks['imported-build-ready'] ?? Infinity, profile.surfaceRemoved ?? Infinity);
          const firstBuildFrame = profile.frames.find(([at]) => at >= visibleFrom)?.[0] ?? null;
          const resolver = performance.getEntriesByType('resource').find(entry => /\/raw$/.test(entry.name));
          return { marks, errors: window.__DESKTOP_POB__?.errors ?? [], frames: profile.frames.length,
            fcp: performance.getEntriesByType('paint').find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null,
            readyObserved: profile.ready ?? null, surfaceRemoved: profile.surfaceRemoved ?? null, firstBuildFrame, titleAtReveal: profile.titleAtReveal ?? null,
            resolver: resolver ? { start: resolver.startTime, end: resolver.responseEnd } : null,
            titles: profile.titles.map(([at, title]) => [Math.round(at), title]) };
        }, { prefix, markNames });
        if (screenshotDirectory) await page.screenshot({ path: resolve(screenshotDirectory, `${label}-run${run}.png`) });
        // Failures are retained, reported and excluded from timing distributions.
        const failures = [...sample.errors, ...pageErrors];
        if (!production && resolverRequests !== 1) failures.push(`resolver requests: ${resolverRequests}`);
        if (failures.length) {
          console.error(`[${label}] run ${run} FAILED: ${failures.join(' | ').slice(0, 2000)}`);
          if (consoleErrors.length) console.error(`[${label}] console: ${consoleErrors.join(' | ').slice(0, 3000)}`);
          launches.push({ run, failed: true, failures, consoleErrors, marks: sample.marks });
          continue;
        }
        const profile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
        launches.push({ run, ...sample, blockedExternal, startupPhases: profile.startupPhases,
          packagesBeforeReady: profile.filesystem?.payload?.packagesBeforeReady, bytesBeforeReady: profile.filesystem?.payload?.bytesBeforeReady,
          loadedPackages: profile.filesystem?.payload?.loadedPackages?.length, helpers: profile.helpers,
          linkProfile: profile.samples?.linkProfile, requestLog });
        console.error(`[${label}] run ${run}: build visible ${sample.firstBuildFrame?.toFixed(0)} ms, ` +
          `editor ready ${sample.marks['editor-ready']?.toFixed(0)}, imported ${sample.marks['imported-build-ready']?.toFixed(0)}`);
      } finally { await browser.close(); }
    }
  } finally { server?.close(); server?.closeAllConnections?.(); }
  const passed = launches.filter(row => !row.failed);
  const summary = {
    failedRuns: launches.length - passed.length,
    firstBuildFrame: distribution(passed.map(row => row.firstBuildFrame)),
    surfaceRemoved: distribution(passed.map(row => row.surfaceRemoved)),
    fcp: distribution(passed.map(row => row.fcp)),
    marks: Object.fromEntries(markNames.map(name => [name, distribution(passed.map(row => row.marks[name]))])),
    phases: Object.fromEntries([...new Set(passed.flatMap(row => Object.keys(row.startupPhases ?? {})))].map(name =>
      [name, distribution(passed.map(row => row.startupPhases[name]))])),
  };
  return { schemaVersion: 1, label, target: production ? target : `${basePath}/#build=<link>`, production,
    resolverLatencyMs: production ? null : resolverLatencyMs, throttle: throttle ?? null,
    browser: browserVersion, cpu: cpus()[0]?.model, logicalCores: cpus().length, summary, launches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const throttleText = option('throttle');
  const [downMbps, latencyMs] = throttleText ? throttleText.split('@').map(Number) : [];
  const report = await profileLinkImport({
    releaseDirectory: option('release'), production: args.includes('--production'),
    buildLink: option('link'), buildFile: option('build-file'), label: option('label') ?? 'candidate',
    resolverLatencyMs: Number(option('resolver-latency') ?? 250), runs: Number(option('runs') ?? 3),
    port: Number(option('port') ?? 3021), screenshotDirectory: option('screenshots'),
    overlays: args.filter(arg => arg.startsWith('--overlay=')).map(arg => arg.slice(10)),
    throttle: throttleText ? { downMbps, upMbps: Math.max(1, downMbps / 5), latencyMs } : undefined,
  });
  const output = option('out');
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary, null, 1));
}
