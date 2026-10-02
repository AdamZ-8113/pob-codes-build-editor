import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

// Run against the standalone loopback app; never use production or port 3000.
const origin = process.env.DESKTOP_POB_ORIGIN ?? "http://127.0.0.1:3010";
const fixture = (await readFile(new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  const faults = [];
  const remoteAssets = [];
  page.on("pageerror", error => faults.push(error.message));
  page.on("request", request => {
    if (/asset\.pob\.cool|pob\.cool\//.test(request.url())) remoteAssets.push(request.url());
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120_000 });
  assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), true, await page.locator("#status").textContent());
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.ok(await page.evaluate(() => window.__DESKTOP_POB__.stats.backend.instances) > 0);
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
  const exportXml = async () => inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
  const buildTag = xml => xml.match(/<Build\s[^>]*>/)?.[0] ?? "Missing Build element";
  const initialXml = await exportXml();
  assert.match(buildTag(initialXml), /className="Duelist"/);
  const canvas = page.locator("canvas");
  // A complete drag may arrive before RAF. Its final cursor position must be
  // consumed while LEFTBUTTON is still held, without allocating a passive node.
  await page.keyboard.press("Control+1");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const viewPosition = xml => {
    const view = xml.match(/<[^>]*\bzoomX="[^"]*"[^>]*>/)?.[0];
    assert.ok(view, "Native export includes tree viewport position");
    return { x:Number(view.match(/\bzoomX="([^"]*)"/)[1]), y:Number(view.match(/\bzoomY="([^"]*)"/)[1]) };
  };
  const beforeDragXml = await exportXml();
  const beforeDrag = viewPosition(beforeDragXml);
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const send = (type,x,y,buttons) => canvas.dispatchEvent(new MouseEvent(type, {
      bubbles:true,cancelable:true,clientX:rect.left+x,clientY:rect.top+y,button:0,buttons,
    }));
    send("mousemove",1100,700,0);
    send("mousedown",1100,700,1);
    for (let i=1;i<=50;i++) send("mousemove",1100-i*2,700-i,1);
    send("mouseup",1000,650,0);
  });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const afterDragXml = await exportXml();
  const afterDrag = viewPosition(afterDragXml);
  assert.equal(afterDrag.x - beforeDrag.x,-100,"Drag must include the final horizontal movement");
  assert.equal(afterDrag.y - beforeDrag.y,-50,"Drag must include the final vertical movement");
  const playerStats = xml => [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
  assert.deepEqual(playerStats(afterDragXml),playerStats(beforeDragXml),"Dragging must not change calculated stats");
  // Pinned Modules/Build.lua: pointDisplay right = screenW / 2 - 3;
  // manual button starts +16 (width 62), characterLevel follows +5 (width 110).
  // The header toolbar leaves the whole viewport width available to PoB.
  await canvas.click({ position: { x: (await canvas.boundingBox()).width/2+135, y: 16 } });
  await page.keyboard.press("Control+a");
  await page.keyboard.type("73");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const editedXml = await exportXml();
  assert.match(buildTag(editedXml), /level="73"/);
  assert.match(buildTag(editedXml), /characterLevelAutoMode="false"/);
  const life = xml => xml.match(/<PlayerStat\b[^>]*\bstat="Life"[^>]*>/)?.[0].match(/\bvalue="([^"]+)"/)?.[1];
  assert.ok(life(initialXml), "Native export must include calculated Life");
  assert.notEqual(life(initialXml), life(editedXml), "Native calculation must update after the edit");
  for (const [shortcut, mode] of [["1", "TREE"], ["2", "SKILLS"], ["3", "ITEMS"], ["4", "CALCS"], ["5", "CONFIG"], ["i", "IMPORT"]]) {
    await page.keyboard.press(`Control+${shortcut}`);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    assert.match(buildTag(await exportXml()), new RegExp(`viewMode="${mode}"`));
  }
  await page.keyboard.press("Control+6");
  // Native NotesTab EditControl below its color controls, inside the main pane.
  await canvas.click({ position: { x: 400, y: 200 } });
  await page.evaluate(() => navigator.clipboard.writeText("Desktop PoB clipboard acceptance"));
  await page.keyboard.press("Control+v");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  assert.ok((await exportXml()).includes("Desktop PoB clipboard acceptance"), "Native Lua notes must receive clipboard paste");
  const exported = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
  assert.match(buildTag(inflateSync(Buffer.from(exported, "base64url")).toString()), /level="73"/);
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), exported);
  assert.match(buildTag(await exportXml()), /level="73"/);
  await canvas.click({ position: { x: 120, y: 16 } });
  await page.keyboard.type("Desktop browser acceptance");
  const bounds = await canvas.boundingBox();
  // Original 470 x 555 Save dialog: save control centered at (-45, 535).
  await canvas.click({ position: { x: bounds.width / 2 - 45, y: (bounds.height - 555) / 2 + 535 } });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const readSavedBuild = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await (await root.getDirectoryHandle("Path of Building")).getDirectoryHandle("Builds");
    return await (await (await directory.getFileHandle("Desktop browser acceptance.xml")).getFile()).text();
  });
  assert.match(buildTag(await readSavedBuild()), /level="73"/);
  await page.reload();
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120_000 });
  assert.match(buildTag(await readSavedBuild()), /level="73"/);
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
  assert.deepEqual(remoteAssets, []);
  console.log("Desktop PoB: native WebGL2 UI, fixture import, rapid drag/release, mouse/keyboard edit, recalculation, six native screens, clipboard, export/reimport and native OPFS save/reload passed.");
  await context.close();
} finally {
  await browser.close();
}
