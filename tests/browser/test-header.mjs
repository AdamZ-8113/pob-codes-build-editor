import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  for (const width of [1600, 641, 640, 390, 320]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(250);
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return {header:rect("header"),nav:rect("nav"),controls:rect("#editor-accessibility"),canvas:rect("canvas"),
        buttons:[...document.querySelectorAll("#editor-accessibility button")].map(e=>e.getBoundingClientRect().toJSON())};
    });
    assert.equal(layout.buttons.length,4);
    for (const button of layout.buttons) {
      assert.ok(button.left >= 0 && button.right <= width && button.bottom <= layout.header.bottom);
      assert.ok(button.width >= 44 && button.height >= 44);
    }
    assert.ok(layout.canvas.top >= layout.header.bottom,"Header must not obscure the canvas");
    if (width <= 640) assert.ok(layout.controls.top >= layout.nav.bottom,"Mobile controls belong below links");
    else assert.ok(layout.controls.top < layout.nav.bottom,"Desktop controls share the navigation row");
    await page.getByRole("button",{name:"Zoom Controls",exact:true}).click();
    const zoom = page.getByRole("group",{name:"Zoom and canvas controls"});
    const zoomBox = await zoom.boundingBox();
    assert.ok(zoomBox.x >= 0 && zoomBox.x+zoomBox.width <= width,"Zoom panel must fit the viewport");
    assert.ok(zoomBox.y >= layout.header.bottom,"Zoom opens below the header");
    await zoom.locator('input[type="range"]').fill("0.8");
    await page.getByRole("button",{name:"Reset Zoom",exact:true}).click();
    await page.getByRole("button",{name:"Zoom Controls",exact:true}).click();
    const pan = page.getByRole("button",{name:"Toggle Pan Tool",exact:true});
    await pan.click();
    assert.equal(await pan.getAttribute("aria-pressed"),"true");
    await pan.click();
    const keyboard = page.getByRole("button",{name:"Toggle Virtual Keyboard",exact:true});
    await keyboard.click();
    assert.equal(await keyboard.getAttribute("aria-pressed"),"true");
    await keyboard.click();
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
  await page.getByRole("button",{name:"Enter Fullscreen",exact:true}).click();
  await page.waitForFunction(()=>document.fullscreenElement === document.documentElement);
  assert.ok(await page.getByRole("navigation",{name:"Primary"}).isVisible());
  await page.getByRole("button",{name:"Exit Fullscreen",exact:true}).click();
  await page.waitForFunction(()=>!document.fullscreenElement);
  assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
  assert.deepEqual(faults,[]);
  console.log("Fullscreen preserves the header and exit control.");
} finally { await browser.close(); }
