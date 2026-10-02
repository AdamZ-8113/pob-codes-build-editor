import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real framebuffer regression, not a reuse-versus-fresh comparison: both paths
// used to contain the same diagonal seams. Optional directory retains review PNGs.
const evidence = process.argv[2] && resolve(process.argv[2]);
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr });
    try {
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:3010/?renderReuse=0');
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
      const worker = page.workers().find(w => w.url().includes('/worker.ts'));
      assert.ok(worker, 'Native UI worker must exist');
      // Use Vite's actual module identity, including an HMR timestamp if present.
      const rendererUrl = await page.evaluate(() => performance.getEntriesByType('resource')
        .find(e => /\/renderer\/renderer\.ts(?:\?|$)/.test(e.name)).name);
      await worker.evaluate(async url => {
        const { Renderer } = await import(url);
        const render = Renderer.prototype.render;
        Renderer.prototype.render = function(view) {
          globalThis.seamRenderer = this;
          globalThis.seamCommands = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
          return render.call(this, view);
        };
      }, rendererUrl);
      await page.keyboard.press('Control+i');
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      await page.waitForTimeout(200);

      // Reduce the captured panel to two solid quads. No native command parser,
      // layer sorting, glyph atlas, DOM canvas or compositor participates here.
      const reduced = await worker.evaluate(dpr => {
        const live = globalThis.seamRenderer;
        const canvas = new OffscreenCanvas(1600 * dpr, 951 * dpr);
        const backend = new live.backend.constructor(canvas);
        const renderer = new live.constructor(live.imageRepo, live.textMetrics,
          { width: canvas.width, height: canvas.height });
        renderer.backend = backend;
        const gl = canvas.getContext('webgl2');
        const results = [];
        try {
          for (const alpha of [255, 128]) {
            backend.beginFrame();
            backend.begin();
            renderer.setColor(168, 168, 168, 255);
            renderer.drawImage(0, 332*dpr, 52*dpr, 602*dpr, 68*dpr, 0, 0, 1, 1, 0, -1);
            renderer.setColor(25, 25, 25, alpha);
            renderer.drawImage(0, 334*dpr, 54*dpr, 598*dpr, 64*dpr, 0, 0, 1, 1, 0, -1);
            backend.end();
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const expected = Math.round((25 * alpha + 168 * (255 - alpha)) / 255);
            let wrong = 0;
            for (let y = 55*dpr; y < 117*dpr; y++) for (let x = 335*dpr; x < 931*dpr; x++) {
              const i = ((canvas.height - 1 - y) * canvas.width + x) * 4;
              if ([0, 1, 2].some(c => Math.abs(pixels[i+c] - expected) > 1)) wrong++;
            }
            results.push({ alpha, expected, wrong, error: gl.getError() });
          }
        } finally {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
        return results;
      }, dpr);
      for (const sample of reduced) {
        assert.equal(sample.error, 0);
        assert.equal(sample.wrong, 0, `Two-quad framebuffer must be uniform: ${JSON.stringify(sample)}`);
      }

      const inspect = async label => {
        const result = await worker.evaluate(async ({ dpr, save }) => {
          const renderer = globalThis.seamRenderer;
          const backend = renderer.backend;
          const canvas = backend.canvas;
          const gl = canvas.getContext('webgl2');
          renderer.invalidateReuse();
          renderer.render(new DataView(globalThis.seamCommands.buffer));
          // Read synchronously after submission, before default-buffer discard.
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let wrong = 0;
          const examples = [];
          // Empty interior of the original Import From Your Account panel,
          // crossing its top-left -> bottom-right internal triangle edge.
          for (let y = 85 * dpr; y < 115 * dpr; y++) {
            for (let x = 600 * dpr; x < 900 * dpr; x++) {
              const i = ((canvas.height - 1 - y) * canvas.width + x) * 4;
              if (pixels[i] !== 25 || pixels[i + 1] !== 25 || pixels[i + 2] !== 25) {
                wrong++;
                if (examples.length < 5) examples.push([x, y, ...pixels.slice(i, i + 3)]);
              }
            }
          }
          let png;
          if (save) {
            const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            png = btoa(binary);
          }
          return { wrong, examples, width: canvas.width, height: canvas.height,
            antialias: gl.getContextAttributes().antialias, error: gl.getError(), png };
        }, { dpr, save: !!evidence && label === 'import' });
        if (result.png) {
          await writeFile(resolve(evidence, `${label}-dpr${dpr}-framebuffer.png`), Buffer.from(result.png, 'base64'));
          await page.screenshot({ path: resolve(evidence, `${label}-dpr${dpr}-page.png`) });
        }
        delete result.png;
        console.log(JSON.stringify({ browser: browser.version(), dpr, label, ...result }));
        assert.equal(result.error, 0, 'Framebuffer read must succeed');
        assert.equal(result.wrong, 0, `Solid panel must have no diagonal pixels: ${JSON.stringify(result.examples)}`);
      };
      await inspect('import');
      await page.waitForTimeout(1500);
      await inspect('idle');
      await page.mouse.move(1300,800);
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      await inspect('motion');
      await page.evaluate(() => window.__DESKTOP_POB__.configureRenderReuse(true));
      await page.keyboard.press('Control+2');
      await page.keyboard.press('Control+i');
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      await inspect('reuse-navigation');
      await page.setViewportSize({ width: 1700, height: 1050 });
      await page.waitForTimeout(300);
      await inspect('resize');
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
