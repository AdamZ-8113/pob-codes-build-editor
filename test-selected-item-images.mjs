import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync, deflateSync } from "node:zlib";

// Public influenced-item regression by default; optional private mode retains
// the original Chieftain list coordinates. Private codes stay caller-owned.
const [buildFile, reportFile] = process.argv.slice(2);
let code = (await readFile(buildFile ?? new URL("./fixtures/guided import parity desktop 329.txt",import.meta.url), "utf8")).trim();
if(!buildFile) {
  const xml=inflateSync(Buffer.from(code,"base64url")).toString();
  assert.ok(!/<Item\b[^>]*id="99999"/.test(xml));
  const item='\n<Item id="99999">\nRarity: RARE\nDesktop Image Regression\nTitan Gauntlets\nItem Level: 85\nSearing Exarch Item\nFractured Item\nImplicits: 0\n{fractured}+50 to maximum Life\n</Item>\n';
  const candidate=xml.replace(/<Items\b[^>]*>/,tag=>tag+item);
  assert.notEqual(candidate,xml);
  code=deflateSync(candidate).toString("base64url");
}
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  let instrumented = false;
  await context.route(/\/src\/js\/worker\.ts\?worker_file/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "const stats = this.renderer?.getStats();";
    assert.ok(source.includes(marker));
    instrumented = true;
    // Read cache sizes from the actual running worker without adding a product
    // API or changing resource loading, scheduling, or Lua execution.
    await route.fulfill({ response, body: source.replace(marker, marker + `
      if (stats) stats.imageProbe = {
        handles: this.imageRepo.images.size,
        resources: this.imageRepo.resources.size,
        textures: this.renderer.backend.textures.size,
        mouse: { ...this.mouseState }
      };`) });
  });
  const page = await context.newPage();
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  const iconRequests = [];
  page.on("request", request => {
    if (/\/(?:fracturedicon|exarchicon)\.png$/.test(request.url())) iconRequests.push(request.url());
  });
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const clear = () => page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples());
  const probe = () => page.evaluate(() => window.__DESKTOP_POB__.stats.imageProbe);
  const stats = async () => {
    const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
    return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
  };
  await page.keyboard.press("Control+3");
  await flush();
  await page.waitForTimeout(1800);
  const initialStats = await stats();
  if(buildFile) await page.mouse.dblclick(850, 262);
  else {
    // Public fixture with a known unused influenced item; no private ordering.
    const [x,,w]= (await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile())).samples.uniqueDbBounds;
    const canvas=page.locator('canvas'),box=await canvas.boundingBox();
    const size=await canvas.evaluate(c=>[c.width,c.height]);
    const point=(nx,ny)=>[box.x+nx*box.width/size[0],box.y+ny*box.height/size[1]];
    // Prepended item is first in this fixture's Custom Order list.
    await page.mouse.dblclick(...point(x+w/2,122));
  }
  await page.mouse.move(1500, 850);
  await page.waitForTimeout(800);
  assert.ok(iconRequests.some(url => url.endsWith("/fracturedicon.png")), "Selected item must exercise the fractured icon");
  assert.ok(iconRequests.some(url => url.endsWith("/exarchicon.png")), "Selected item must exercise the Exarch icon");
  await clear();
  const before = await probe();
  const requestsBefore = iconRequests.length;
  await page.waitForTimeout(1500);
  const idleFrames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples.length);
  assert.equal(idleFrames, 0, "A selected influenced item must settle without perpetual redraws");
  assert.equal(iconRequests.length, requestsBefore, "Idle must not reload influence icons");

  for (let i = 0; i < 90; i++) {
    await page.mouse.move(1100 + (i % 3) * 110, 96 + (i % 2) * 56);
    await page.waitForTimeout(16);
  }
  await flush();
  await page.waitForTimeout(150);
  const afterMotion = await probe();
  for (const key of ["handles", "resources", "textures"]) {
    assert.equal(afterMotion[key], before[key], `${key} must not grow across repeated selected-item redraws`);
  }
  assert.equal(iconRequests.length, requestsBefore);
  const motionFrames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
  const editTimings = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await page.mouse.click(1210, 96); // Original Edit... control after horizontal snap.
    await flush();
    editTimings.push(performance.now() - started);
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await flush();
  }
  await page.mouse.move(1500, 850);
  await page.waitForTimeout(300);
  const afterDialogs = await probe();
  for (const key of ["handles", "resources", "textures"]) {
    assert.equal(afterDialogs[key], before[key], `${key} must remain stable after opening and closing Edit`);
  }
  assert.deepEqual(await stats(), initialStats, "Hovering and canceling dialogs must preserve calculated build stats");
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
  assert.ok(instrumented);
  const report = {
    iconRequests: iconRequests.length, idleFrames, before, afterMotion, afterDialogs,
    motion: { frames: motionFrames.length, maxFrameMs: Math.max(...motionFrames.map(frame => frame.duration)) },
    editInputFlushMs: editTimings, statsUnchanged: true,
    note: "Input flush timings exclude GPU presentation. Private mode targets the original Chieftain list ordering; default mode derives a public influenced-item fixture."
  };
  if (reportFile) await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
