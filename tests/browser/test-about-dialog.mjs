import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from "node:assert/strict";

const DISCLAIMER = "PoB Codes is an unofficial fan-made Path of Exile tool. Path of Exile and related assets are © Grinding Gear Games. Not affiliated with or endorsed by Grinding Gear Games. Privacy · Terms";

const browser = await chromium.launch({ headless: true, channel: browserChannel() });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  const about = page.getByRole("button", { name: "About, disclaimer and open-source notices", exact: true });
  const dialog = page.getByRole("dialog", { name: "About PoB Codes Build Editor" });
  const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");

  for (const [width, height] of [[1440, 900], [1180, 900], [721, 900], [720, 900], [375, 812]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    const measure = () => page.evaluate(() => {
      const rect = element => element.getBoundingClientRect().toJSON();
      return {
        header: rect(document.querySelector("header")),
        launch: rect(document.querySelector("#launch-build")),
        about: rect(document.querySelector("#about-legal")),
        tools: [...document.querySelectorAll("#editor-accessibility button")].map(rect),
        overflow: document.querySelector(".site-header-inner").scrollWidth - document.documentElement.clientWidth,
      };
    });
    const layout = await measure();
    assert.equal(layout.tools.length, 2);
    assert.ok(layout.launch.right <= layout.about.left && layout.about.right <= layout.tools[0].left,
      `${width}px: About sits between Launch and the toolbar`);
    for (const box of [layout.launch, layout.about, ...layout.tools]) {
      assert.ok(box.left >= 0 && box.right <= width && box.bottom <= layout.header.bottom, `${width}px: header controls fit`);
    }
    assert.ok(layout.overflow <= 0, `${width}px: header must not overflow horizontally`);
    assert.ok(layout.about.width >= 24 && layout.about.height >= 24, "About keeps a usable target size");
    if (width > 720) {
      assert.equal(layout.header.height, 49, "Keep the 29px compact header row");
      assert.equal(layout.about.height, 29, "About matches the compact row");
    } else {
      assert.ok(layout.about.height >= 44, "Touch layout uses the toolbar's 44px row");
    }
    await page.evaluate(() => { document.querySelector("#about-legal").style.display = "none"; });
    const without = await measure();
    await page.evaluate(() => { document.querySelector("#about-legal").style.display = ""; });
    assert.equal(layout.header.height, without.header.height, `${width}px: About must not change the header height`);
    console.log(`About ${width}px: placed between Launch and the toolbar without changing the header.`);
  }

  // Keyboard: Tab reaches About from the header links, Enter opens, Escape closes and returns focus.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".site-discord-link").focus();
  await page.keyboard.press("Tab");
  if (await activeId() === "launch-build") await page.keyboard.press("Tab");
  assert.equal(await activeId(), "about-legal", "Tab reaches About after the header links");
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.querySelector("#about-dialog").contains(document.activeElement)), true,
    "Opening moves focus into the dialog");
  assert.equal((await page.locator("#about-disclaimer").textContent()).replace(/\s+/g, " ").trim(), DISCLAIMER);
  for (const [name, href] of [["Privacy", "https://pob.codes/content/privacy"], ["Terms", "https://pob.codes/content/terms"]]) {
    const link = dialog.getByRole("link", { name, exact: true });
    assert.equal(await link.getAttribute("href"), href);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  assert.ok(await dialog.getByRole("heading", { name: "Open-source notices" }).isVisible());
  const box = await dialog.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900, "Dialog fits the viewport");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await activeId(), "about-legal", "Escape returns focus to About");

  // Close button and backdrop both close; clicks inside the content do not.
  await about.click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await activeId(), "about-legal", "Close returns focus to About");
  await about.click();
  await dialog.getByRole("heading", { name: "About PoB Codes Build Editor" }).click();
  assert.ok(await dialog.isVisible(), "Clicking the content keeps the dialog open");
  await page.mouse.click(8, 892);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await activeId(), "about-legal", "Backdrop click returns focus to About");

  // Phone width: the dialog fits and its notices scroll inside it.
  await page.setViewportSize({ width: 375, height: 812 });
  await about.click();
  await dialog.waitFor({ state: "visible" });
  const phone = await page.evaluate(() => {
    const dialog = document.querySelector("#about-dialog");
    const content = dialog.querySelector(".about-dialog-content");
    return { box: dialog.getBoundingClientRect().toJSON(), scrollable: content.scrollHeight > content.clientHeight, overflow: content.scrollWidth - content.clientWidth };
  });
  assert.ok(phone.box.left >= 0 && phone.box.right <= 375 && phone.box.top >= 0 && phone.box.bottom <= 812, "Dialog fits a phone viewport");
  assert.ok(phone.scrollable && phone.overflow <= 0, "Notices scroll vertically without horizontal overflow");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
  console.log("About dialog: keyboard, close button, backdrop, focus return and phone layout passed.");
} finally { await browser.close(); }
