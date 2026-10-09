import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true, channel: browserChannel() });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:3010",
  });
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  assert.equal(await page.locator('[contenteditable="true"]').evaluate(element => getComputedStyle(element).cursor), "default",
    "PoB canvas uses the arrow cursor instead of the editable-text I-beam");
  for (const width of [1600, 721, 720, 390, 320]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(250);
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return {header:rect("header"),nav:rect("nav"),controls:rect("#editor-accessibility"),canvas:rect("canvas"),
        buttons:[...document.querySelectorAll("#editor-accessibility button")].map(e=>e.getBoundingClientRect().toJSON())};
    });
    assert.equal(layout.buttons.length,2);
    for (const button of layout.buttons) {
      assert.ok(button.left >= 0 && button.right <= width && button.bottom <= layout.header.bottom);
      assert.ok(button.width >= 44 && button.height >= 44);
    }
    assert.ok(layout.canvas.top >= layout.header.bottom,"Header must not obscure the canvas");
    if (width <= 720) assert.ok(layout.controls.top >= layout.nav.bottom,"Mobile controls belong below links");
    else assert.ok(layout.controls.top < layout.nav.bottom,"Desktop controls share the navigation row");
    const tools = page.getByRole("button",{name:"WebAssembly tools",exact:true});
    await tools.click();
    const menu = page.getByRole("menu",{name:"WebAssembly tools",exact:true});
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox.y >= layout.header.bottom,"Wasm tools menu opens below the header");
    assert.ok(menuBox.width <= 200,"Wasm tools menu stays compact");
    const pan = page.getByRole("menuitemcheckbox",{name:"Pointer / pan",exact:true});
    await pan.click();
    assert.equal(await pan.getAttribute("aria-checked"),"true");
    await pan.click();
    await page.getByRole("menuitemcheckbox",{name:"Zoom & canvas",exact:true}).click();
    const zoom = page.getByRole("group",{name:"Zoom and canvas controls"});
    const zoomBox = await zoom.boundingBox();
    assert.ok(zoomBox.x >= 0 && zoomBox.x+zoomBox.width <= width,"Zoom panel must fit the viewport");
    assert.ok(zoomBox.y >= layout.header.bottom,"Zoom opens below the header");
    await zoom.locator('input[type="range"]').fill("0.8");
    await page.getByRole("button",{name:"Reset Zoom",exact:true}).click();
    await tools.click();
    const keyboard = page.getByRole("menuitemcheckbox",{name:"Virtual keyboard",exact:true});
    await keyboard.click();
    assert.equal(await tools.getAttribute("aria-pressed"),"true");
    await tools.click();
    assert.equal(await page.getByRole("menuitemcheckbox",{name:"Virtual keyboard",exact:true}).getAttribute("aria-checked"),"true");
    await page.getByRole("menuitemcheckbox",{name:"Virtual keyboard",exact:true}).click();
    const statsButton = page.getByRole("button",{name:"Toggle runtime stats",exact:true});
    await statsButton.click();
    const stats = page.getByRole("region",{name:"Runtime stats",exact:true});
    const statsBox = await stats.boundingBox();
    assert.ok(statsBox.x + statsBox.width <= width && statsBox.y + statsBox.height <= 900,
      "Runtime stats stays in the bottom-right viewport corner");
    assert.match(await stats.textContent(),/Wasm memory.*JS heap.*PoB CPU \(est\.\)/s);
    assert.equal(await stats.evaluate(element => getComputedStyle(element,"::-webkit-scrollbar").width),"10px",
      "Runtime stats uses the wider scrollbar");
    assert.ok(await page.getByRole("button",{name:"Copy debug report",exact:true}).isVisible());
    assert.ok(await page.getByRole("button",{name:"Download JSON",exact:true}).isVisible());
    if (width === 1600) {
      const exposedReport = await page.evaluate(() => window.__DESKTOP_POB__.getDebugReport());
      assert.equal(exposedReport.schemaVersion,1);
      assert.ok(exposedReport.privacy.excluded.includes("build codes and XML"));
      const exposedJson = JSON.stringify(exposedReport);
      assert.ok(!exposedJson.includes(page.url()),"Report must not contain the page URL");
      assert.ok(!exposedJson.includes(await page.evaluate(() => navigator.userAgent)),
        "Report must not contain the full user agent");

      await page.getByRole("button",{name:"Copy debug report",exact:true}).click();
      await page.getByText("Debug report copied.",{exact:true}).waitFor();
      const copiedReport = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      assert.equal(copiedReport.schemaVersion,1);

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button",{name:"Download JSON",exact:true}).click();
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(),/^pob-codes-debug-.*\.json$/);
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      const downloadedReport = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(downloadedReport.schemaVersion,1);
      await page.getByText("Debug report downloaded.",{exact:true}).waitFor();
    }
    await statsButton.click();
    assert.equal(await page.locator("#build-menu").count(),0);
    const headerHeight = layout.header.height;
    await page.evaluate(() => {
      const status = document.querySelector("#status");
      status.classList.add("status-error");
      status.textContent = "PoB started but did not draw its interface. Check the runtime diagnostics.";
    });
    const statusLayout = await page.evaluate(() => ({
      header:document.querySelector("header").getBoundingClientRect().toJSON(),
      status:document.querySelector(".header-status").getBoundingClientRect().toJSON(),
      brand:document.querySelector(".site-brand").getBoundingClientRect().toJSON(),
      font:getComputedStyle(document.querySelector(".site-brand")).fontWeight,
    }));
    assert.equal(statusLayout.header.height,headerHeight,"Errors must not add a header row");
    assert.equal(statusLayout.font,"500","Match the site's computed font weight");
    if (width === 1600) {
      assert.equal(statusLayout.brand.x,119.5,"Match the site header's actual navigation position");
      assert.equal(statusLayout.brand.y,10,"Match the core site's top spacing");
      assert.equal(layout.canvas.top,49,"Keep 10px beneath the 29px header row");
      const centerY = rect => rect.y + rect.height/2;
      assert.equal(centerY(statusLayout.brand),centerY(layout.controls),"Navigation and accessibility controls must share a vertical center");
      assert.equal(centerY(statusLayout.status),centerY(layout.controls),"Status must align with the header controls");
      assert.equal(statusLayout.status.x+statusLayout.status.width/2,width/2,"Center status in the header");
    }
    await page.evaluate(() => {
      const status = document.querySelector("#status");
      status.classList.remove("status-error");
      status.textContent = "";
    });
    console.log(`Header ${width}px: navigation, accessibility controls and fixed-height status passed.`);
  }
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole("button",{name:"WebAssembly tools",exact:true}).click();
  await page.getByRole("menuitemcheckbox",{name:"Enter Fullscreen",exact:true}).click();
  await page.waitForFunction(()=>document.fullscreenElement === document.documentElement);
  assert.ok(await page.getByRole("navigation",{name:"Primary"}).isVisible());
  await page.getByRole("button",{name:"WebAssembly tools",exact:true}).click();
  await page.getByRole("menuitemcheckbox",{name:"Exit Fullscreen",exact:true}).click();
  await page.waitForFunction(()=>!document.fullscreenElement);
  assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
  assert.deepEqual(faults,[]);
  console.log("Fullscreen preserves the header and exit control.");
} finally { await browser.close(); }
