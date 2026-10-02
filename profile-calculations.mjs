import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const fixture = (await readFile(new URL('./fixtures/guided import parity desktop 329.txt', import.meta.url), 'utf8')).trim();
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('http://127.0.0.1:3010');
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120000 });
  if(process.argv.includes('--synchronous')) await page.evaluate(()=>window.__DESKTOP_POB__.configureCalculationScheduling(false));
  const rounds = [];
  for (const interaction of ['character-level', 'map-mod-effect']) {
    for (let round = 0; round < 3; round++) {
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
      await page.keyboard.press(interaction === 'character-level' ? 'Control+1' : 'Control+5');
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      const canvas = page.locator('canvas');
      const bounds = await canvas.boundingBox();
      const dims = await canvas.evaluate(c => ({ width: c.width, height: c.height }));
      const [x, y] = interaction === 'character-level' ? [910, 16] : [995, 234];
      await canvas.click({ position: { x: x * bounds.width / dims.width, y: y * bounds.height / dims.height } });
      await page.keyboard.press('Control+a');
      await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile(true));
      await page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples());
      const begin = performance.now();
      await page.keyboard.type('73', { delay: 65 });
      await page.keyboard.press('Enter');
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      const duration = performance.now() - begin;
      const profile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile(true));
      const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), 'base64url')).toString();
      const edited = interaction === 'character-level' ? /level="73"/ : /name="multiplierMapModEffect"[^>]*number="73"|number="73"[^>]*name="multiplierMapModEffect"/;
      assert.ok(edited.test(xml), `${interaction} must edit its intended native control`);
      assert.ok(profile.samples.MAIN.length, 'Interaction must produce real exact rebuilds');
      const frames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
      rounds.push({ interaction, round, duration, frames, ...profile });
    }
  }
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  const report = { browser: browser.version(), synchronous:process.argv.includes('--synchronous'), rounds };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ browser: report.browser, rounds: rounds.map(({ frames, ...r }) => ({ ...r, slowFrameStarts: frames.filter(f => f.duration >= 40).map(f => f.at) })) }));
} finally { await browser.close(); }
