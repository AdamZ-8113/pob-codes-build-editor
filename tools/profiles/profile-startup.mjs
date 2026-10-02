import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';

// Aggregate local evidence only. Never includes build data or network URLs.
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const origin = process.env.DESKTOP_POB_ORIGIN ?? 'http://127.0.0.1:3010';
const launches = [];
try {
  for (let run = 0; run < 5; run++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      for (const cache of ['cold', 'warm']) {
        const begin = performance.now();
        await page.goto(origin + (process.argv.includes('--legacy') ? '/?legacyPayload=1' : '/'));
        await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
        const readyMs = performance.now() - begin;
        await page.waitForTimeout(1500);
        const sample = await page.evaluate(() => {
          const h = window.__DESKTOP_POB__;
          return { frames: h.frames, samples: h.frameSamples, errors: h.errors };
        });
        assert.deepEqual(sample.errors, []);
        const profile=await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile());
        await page.waitForTimeout(250);
        const idleFrames=(await page.evaluate(()=>window.__DESKTOP_POB__.frames))-sample.frames;
        assert.equal(idleFrames,0,'Settled startup must not redraw indefinitely');
        launches.push({
          run, cache, readyMs, idleFrames, profile,
          packagesBeforeReady: profile.filesystem.payload?.packagesBeforeReady,
          bytesBeforeReady: profile.filesystem.payload?.bytesBeforeReady,
          ...sample,
        });
      }
    } finally { await context.close(); }
  }
  const report = {
    browser: browser.version(), cpu: cpus()[0]?.model, logicalCores: cpus().length,
    viewport: { width: 1600, height: 1000, dpr: 1 }, build: 'release',
    payloadMode: process.argv.includes('--legacy') ? 'legacy' : 'packages',
    provenance: JSON.parse(await readFile(new URL('../../.runtime/payload/provenance.json', import.meta.url), 'utf8')),
    launches,
  };
  const output = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report,
    provenance: { sourceRevision: report.provenance.sourceRevision, manifestSha256: report.provenance.manifestSha256 },
    launches: launches.map(({ samples, profile, ...r }) => ({...r,phases:profile.startupPhases})),
  }));
} finally { await browser.close(); }
