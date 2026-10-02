import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { canonicalExportTree } from '../../scripts/lib/canonical-export.mjs';

// Visual acceptance only: both modes use the same native runtime, real fonts
// and original Items tooltips. Diagnostics are injected into an in-memory core
// package and never written to a source checkout or generated payload.
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const buildFile = argument('build-file');
const reviewDirectory = argument('review-dir') && resolve(argument('review-dir'));
assert.ok(process.argv.slice(2).every(value => /^--(?:build-file|review-dir)=.+$/.test(value)), 'Supported options: --build-file=<path>, --review-dir=<path>');
const app = new URL('../../', import.meta.url);
const code = (await readFile(buildFile ? resolve(buildFile) : new URL('./fixtures/guided import parity desktop 329.txt', app), 'utf8')).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(new URL('upstream/deno.json', app));
const AdmZip = require('adm-zip');
const manifest = JSON.parse(await readFile(new URL('.runtime/payload/manifest.json', app)));
const core = manifest.packages.find(pkg => pkg.id === 'core');
const archive = await readFile(new URL(`.runtime/payload/packages/${core.sha256}.zip`, app));
assert.equal(sha256(archive), core.sha256, 'Source core package identity');
const zip = new AdmZip(archive);
const diagnostics = `
do
    local encode = require('dkjson').encode
    local active, installed, lastDrawn
    local tooltipWidths, tooltipTypes = {}, {}
    local add, draw = ItemsTabClass.AddItemTooltip, ItemsTabClass.Draw
    local tooltipClass = getmetatable(new('Tooltip'):Tooltip())
    local drawTooltip = tooltipClass.Draw
    tooltipClass.Draw = function(self, ...)
        if #self.lines > 0 then lastDrawn = self end
        return drawTooltip(self, ...)
    end
    local samples = {
        { font = 'VAR', text = '^1Colour ^x00FF7Fsample\\n^7UTF-8: café Ω Ж' },
        { font = 'FIXED', text = '^7Monospace 0123456789' },
        { font = 'FONTIN SC', text = '^3Small caps sample' },
    }
    local function bounds(control)
        local x,y = control:GetPos(); local w,h = control:GetSize()
        return {x,y,w,h}
    end
    ItemsTabClass.AddItemTooltip = function(self, tooltip, ...)
        local result = table.pack(add(self, tooltip, ...))
        local item = select(1, ...)
        tooltipTypes[tooltip] = item and item.type
        local sampleWidths = {}
        tooltipWidths[tooltip] = sampleWidths
        for _, sample in ipairs(samples) do
            local first = #tooltip.lines + 1
            tooltip:AddLine(14, sample.text, sample.font)
            for index = first, #tooltip.lines do
                -- Exercise each actual font even if the fixture hides flavour
                -- text. This touches test tooltip layout only, never the build.
                local line = tooltip.lines[index]
                line.font = sample.font
                local width = DrawStringWidth(line.size, line.font, line.text)
                local repeated = DrawStringWidth(line.size, line.font, line.text)
                assert(width == repeated)
                sampleWidths[#sampleWidths + 1] = {font = line.font, width = width}
            end
        end
        return table.unpack(result, 1, result.n)
    end
    ItemsTabClass.Draw = function(self, ...)
        active = self
        lastDrawn = nil
        local result = table.pack(draw(self, ...))
        if not installed and getRuntimeProfile then
            installed = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local original = profile(reset)
                local list = active.controls.itemList
                local state = {listBounds = bounds(list), rowHeight = list.rowHeight,
                    scrollOffset = list.controls.scrollBarV.offset,
                    rowLabelOffset = list.colLabels and 18 or 0,
                    widths = tooltipWidths[lastDrawn] or {}, tooltipKind = lastDrawn == list.tooltip and 'list' or 'other',
                    itemType = tooltipTypes[lastDrawn]}
                state.screenWidth, state.screenHeight = GetVirtualScreenSize()
                local helmet = active.slots.Helmet
                if helmet and helmet.shown() and active.items[helmet.selItemId] then
                    state.helmetBounds = bounds(helmet)
                    if lastDrawn == helmet.tooltip then state.tooltipKind = 'helmet' end
                end
                for index, itemId in ipairs(list.list) do
                    local item = active.items[itemId]
                    if item and item.type == 'Jewel' then state.jewelIndex = index; break end
                end
                return original:sub(1,-2) .. ',"textWidthVisual":' .. encode(state) .. '}'
            end
        end
        return table.unpack(result, 1, result.n)
    end
end
`;
const source = zip.readAsText('Classes/ItemsTab.lua');
const content = Buffer.from(source + '\n' + diagnostics);
zip.updateFile('Classes/ItemsTab.lua', content);
const bytes = zip.toBuffer();
const file = core.files.find(entry => entry.path === 'Classes/ItemsTab.lua');
core.uncompressedBytes += content.length - file.bytes;
file.bytes = content.length; core.bytes = bytes.length; core.sha256 = sha256(bytes);
if (reviewDirectory) await mkdir(reviewDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
let frozenNativeSource, nativeWasm;
try {
  for (const dpr of [1, 2]) {
    const modes = [];
    for (const enabled of [false, true]) {
      console.error(`Visual context: DPR ${dpr}, cache ${enabled ? 'on' : 'off'}`);
      const context = await browser.newContext({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: dpr });
      try {
        // Disable Vite hot reload for this isolated acceptance context.
        await context.routeWebSocket('**/*', socket => socket.close());
        await context.route('**/payload/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest) }));
        await context.route(`**/payload/packages/${core.sha256}.zip`, route => route.fulfill({ contentType: 'application/octet-stream', body: bytes }));
        await context.route(/\/dist\/release\/driver\.mjs(?:\?|$)/, async route => {
          if (!frozenNativeSource) {
            const response = await route.fetch(), original = await response.text();
            const clock = 'var _emscripten_get_now = () => performance.now();';
            assert.ok(original.includes(clock), 'Freeze only the native PoB animation clock');
            frozenNativeSource = original.replace(clock, 'var _emscripten_get_now = () => 1000;');
          }
          await route.fulfill({ contentType: 'text/javascript', body: frozenNativeSource });
        });
        await context.route(/\/dist\/release\/driver\.wasm(?:\?|$)/, async route => {
          if (!nativeWasm) nativeWasm = await (await route.fetch()).body();
          await route.fulfill({ contentType: 'application/wasm', body: nativeWasm });
        });
        const page = await context.newPage();
        const faults = [];
        page.on('pageerror', error => faults.push(error.message));
        await page.goto(`http://127.0.0.1:3010/?helpers=0&payloadPrefetch=0&textWidthCache=${enabled ? 'on' : 'off'}`);
        try {
          await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 30000 });
        } catch {
          const status = await page.evaluate(() => ({ api: Boolean(window.__DESKTOP_POB__), errors: window.__DESKTOP_POB__?.errors }));
          throw new Error(`Runtime boot failed before importing a build: ${JSON.stringify({ dpr, enabled, faults, ...status })}`);
        }
        await page.evaluate(value => window.__DESKTOP_POB__.loadBuildFromCode(value), code);
        await page.keyboard.press('Control+3');
        const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
        const profile = () => page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
        await flush();
        await page.evaluate(() => window.__DESKTOP_POB__.configureRenderReuse(false));
        const exportHash = async () => {
          const exported = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
          const xml = inflateSync(Buffer.from(exported, 'base64url')).toString();
          const tree = await page.evaluate(value => {
            const root = new DOMParser().parseFromString(value, 'application/xml');
            const walk = node => node.nodeType === 1 ? [node.tagName, [...node.attributes].map(attr => [attr.name, attr.value]), [...node.childNodes].map(walk).filter(value => value !== null)] : node.textContent.trim() || null;
            return walk(root.documentElement);
          }, xml);
          return sha256(JSON.stringify(canonicalExportTree(tree)));
        };
        const initialExport = await exportHash();
        const point = async (x, y) => {
          const bounds = await page.locator('canvas').boundingBox();
          const state = (await profile()).samples.textWidthVisual;
          return { x: bounds.x + x * bounds.width / state.screenWidth, y: bounds.y + y * bounds.height / state.screenHeight };
        };
        const move = async (x, y) => {
          const target = await point(x, y);
          await page.mouse.move(target.x, target.y); await flush();
          await page.mouse.move(target.x + 1, target.y); await flush();
        };
        const states = [];
        for (const zoom of [1, .8]) {
          if (zoom !== 1) {
            await page.getByRole('button', { name: 'Zoom Controls', exact: true }).click();
            await page.getByRole('group', { name: 'Zoom and canvas controls' }).locator('input[type="range"]').fill(String(zoom));
            await page.getByRole('button', { name: 'Zoom Controls', exact: true }).click();
            await flush();
          }
          let state = (await profile()).samples.textWidthVisual;
          assert.ok(state?.helmetBounds && state.jewelIndex, 'Fixture must expose an equipped helmet and list jewel');
          const [hx,hy,hw,hh] = state.helmetBounds;
          const targets = [{ name: 'helmet', x: hx + Math.min(hw * .6, 80), y: hy + Math.min(hh * .5, 8) }];
          for (const target of targets) {
            await move(state.screenWidth - 20, state.screenHeight - 20);
            await move(target.x, target.y);
            await capture(target.name, zoom);
          }
          // Scroll the native list, without selecting or equipping an item.
          state = (await profile()).samples.textWidthVisual;
          let [lx,ly,lw,lh] = state.listBounds;
          for (let step = 0; step < 50; step++) {
            const offset = (state.jewelIndex - 1) * state.rowHeight - state.scrollOffset + state.rowLabelOffset;
            if (offset >= 0 && offset + state.rowHeight < lh - 4) break;
            const center = await point(lx + lw * .45, ly + lh * .5);
            await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, offset < 0 ? -100 : 100); await flush();
            state = (await profile()).samples.textWidthVisual;
          }
          const offset = (state.jewelIndex - 1) * state.rowHeight - state.scrollOffset + state.rowLabelOffset;
          assert.ok(offset >= 0 && offset + state.rowHeight < lh - 4, 'Jewel row must be visible');
          await move(lx + lw * .45, ly + 2 + offset + state.rowHeight * .5);
          await capture('list-jewel', zoom);
        }
        async function capture(target, zoom) {
          // Let demand images and glyph uploads settle; repeat the hover so
          // native counters prove actual cache hits in the accepted scene.
          await page.waitForFunction(async () => {
            const { images } = await window.__DESKTOP_POB__.getRuntimeProfile();
            return images.resources === images.completed + images.failed;
          }, null, { timeout: 30000 });
          let image, pixels, previous, stable = 0;
          for (let attempt = 0; attempt < 20 && stable < 2; attempt++) {
            await page.waitForTimeout(150); await flush();
            image = await page.locator('canvas').screenshot();
            pixels = await sharp(image).removeAlpha().raw().toBuffer();
            const hash = sha256(pixels);
            stable = hash === previous ? stable + 1 : 0;
            previous = hash;
          }
          assert.equal(stable, 2, 'Native tooltip framebuffer must settle before comparison');
          const widthProfile = (await profile()).draw.textWidth;
          assert.equal(widthProfile.enabled, enabled, 'Native width cache must use the requested mode');
          assert.ok(widthProfile.calls > 0 && widthProfile.bridgeCalls > 0, 'Real width requests must cross the baseline bridge');
          if (enabled) assert.ok(widthProfile.hits > 0 && widthProfile.bridgeCalls < widthProfile.calls, 'Native cache must avoid real bridge calls');
          else assert.equal(widthProfile.bridgeCalls, widthProfile.calls, 'Uncached requests must all cross the bridge');
          const probe = (await profile()).samples.textWidthVisual;
          assert.equal(probe.tooltipKind, target === 'helmet' ? 'helmet' : 'list', 'The requested native tooltip must actually draw');
          if (target === 'list-jewel') assert.equal(probe.itemType, 'Jewel', 'The native list hover must target a jewel');
          assert.equal(probe.widths.length, 4, 'Real fonts, colours, multiline and UTF-8 probes must run');
          if (reviewDirectory) await writeFile(join(reviewDirectory, `${target}-dpr${dpr}-zoom${zoom}-${enabled ? 'on' : 'off'}.png`), image);
          const canonical = await exportHash();
          assert.equal(canonical, initialExport, 'Visual probes must preserve complete build exports');
          states.push({ target, zoom, pixels: sha256(pixels), widths: sha256(JSON.stringify(probe.widths)), canonical, widthProfile });
        }
        assert.equal(faults.length, 0, 'Browser must have no page errors');
        assert.equal((await page.evaluate(() => window.__DESKTOP_POB__.errors)).length, 0, 'Runtime must have no errors');
        modes.push(states);
      } finally { await context.close(); }
    }
    assert.equal(modes[0].length, 4);
    for (let index = 0; index < modes[0].length; index++) {
      const before = modes[0][index], after = modes[1][index];
      const label = `${before.target}, DPR ${dpr}, zoom ${before.zoom}`;
      assert.equal(after.pixels, before.pixels, `Exact canvas pixel parity: ${label}`);
      assert.equal(after.widths, before.widths, `Exact native real-font widths: ${label}`);
      assert.equal(after.canonical, before.canonical, `Exact canonical export parity: ${label}`);
      results.push({ target: before.target, dpr, zoom: before.zoom, exactPixels: true, exactWidths: true, exactExport: true,
        offBridgeCalls: before.widthProfile.bridgeCalls, onBridgeCalls: after.widthProfile.bridgeCalls, hits: after.widthProfile.hits });
    }
  }
  console.log(JSON.stringify({ status: 'passed', scope: 'Visual correctness only; native animation clock frozen, browser clocks real',
    runtimeSha256: sha256(nativeWasm), cases: results }));
} finally { await browser.close(); }
