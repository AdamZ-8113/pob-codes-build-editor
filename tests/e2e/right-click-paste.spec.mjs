import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

test.use({ screenshot: "only-on-failure" });

test("native text fields paste on right click using the browser gesture", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await page.goto("/");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 90_000 });
  const fixture = (await readFile(new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
  await page.evaluate(() => {
    const read = navigator.clipboard.readText.bind(navigator.clipboard);
    window.readClipboardForTest = read;
    window.clipboardGestures = [];
    navigator.clipboard.readText = () => {
      window.clipboardGestures.push(window.event?.type);
      return read();
    };
  });
  const canvas = page.locator("canvas");
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const shortcut = async key => { await page.keyboard.press(key); await flush(); };
  const paste = async (text, position) => {
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await canvas.click({ button: "right", position });
    await flush();
  };
  const copiedSelection = async () => {
    await page.evaluate(() => navigator.clipboard.writeText("Copy has not completed"));
    await shortcut("Control+a");
    await shortcut("Control+c");
    // Native Copy writes asynchronously on the main thread.
    return () => page.evaluate(async () => (await window.readClipboardForTest()).replace(/\r\n/g, "\n"));
  };

  await shortcut("Control+6");
  await paste("Right-click notes\nSecond line", { x: 400, y: 200 });
  const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
  expect(xml).toContain("Right-click notes\nSecond line");
  await shortcut("Control+a");
  await paste("Replacement notes", { x: 400, y: 200 });
  const replaced = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
  expect(replaced).toContain("Replacement notes");
  expect(replaced).not.toContain("Right-click notes");

  await shortcut("Control+3");
  const [listX,, listWidth] = (await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile())).samples.uniqueDbBounds;
  await canvas.click({ position: { x: listX + listWidth + 200, y: 52 } });
  await flush();
  const bounds = await canvas.boundingBox();
  const item = "Rarity: Rare\nClipboard Ring\nIron Ring\n+25 to maximum Life";
  await paste(item, { x: bounds.width / 2, y: bounds.height / 2 });
  await expect.poll(await copiedSelection()).toBe(item);
  await canvas.click({ position: { x: bounds.width / 2 + 45, y: (bounds.height - 500) / 2 + 480 } });
  await flush();

  await shortcut("Control+i");
  // Native ImportTab: build sharing below the 226px account section.
  const code = fixture;
  await paste(code, { x: 400, y: 440 });
  await expect.poll(await copiedSelection()).toBe(code);
  const gestures = await page.evaluate(() => window.clipboardGestures);
  expect(gestures).toEqual(["mousedown", "mousedown", "mousedown", "mousedown"]);
  expect(await page.evaluate(() => window.__DESKTOP_POB__.errors)).toEqual([]);
});
