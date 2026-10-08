import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const [buildFile, reportFile] = process.argv.slice(2);
const code = (await readFile(buildFile || new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
const browser = await chromium.launch({ headless:true, channel: browserChannel() });
try {
  const context = await browser.newContext({ viewport:{width:1600,height:1000} });
  // Observe the position used by the real completed Lua frame, without changing
  // the app's scheduling or adding a production diagnostic API.
  let instrumented = false;
  await context.route(/\/src\/js\/worker\.ts\?worker_file/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "this.hostCallbacks?.onFrame(start, time, stats);";
    assert.ok(source.includes(marker));
    instrumented = true;
    await route.fulfill({response,body:source.replace(marker, "if (stats) stats.inputMouse = { ...this.mouseState }; " + marker)});
  });
  await context.addInitScript(() => {
    const NativeWorker = Worker;
    const pending = new Map();
    const probe = window.__INPUT_PROBE__ = { sent:0, maxPending:0, received:0 };
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        // Observe replies before Comlink's listeners can send the next update.
        this.addEventListener("message", event => {
          if (pending.delete(event.data?.id)) probe.received++;
        });
      }
      postMessage(message, ...args) {
        if (message?.type === "APPLY" && message.path?.[0] === "handleMouseMove") {
          pending.set(message.id, true);
          probe.sent++;
          probe.maxPending = Math.max(probe.maxPending, pending.size);
        }
        return super.postMessage(message, ...args);
      }
    };
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, {timeout:120_000});
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  await page.keyboard.press("Control+3");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await page.waitForTimeout(2000);
  const results = [];
  for (let run=0; run<3; run++) {
    await page.mouse.move(1250,850);
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      Object.assign(window.__INPUT_PROBE__, {sent:0,received:0,maxPending:0});
      window.__DESKTOP_POB__.clearFrameSamples();
    });
    const finalPosition = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas");
      const rect = canvas.getBoundingClientRect();
      const send = (x,y) => canvas.dispatchEvent(new MouseEvent("mousemove", {bubbles:true,clientX:rect.left+x,clientY:rect.top+y}));
      // Deliberate high-rate burst to test backpressure, not a claimed physical
      // mouse polling rate. Every event still traverses the actual DOM handler.
      for (let batch=0;batch<30;batch++) {
        for (let i=0;i<8;i++) send(850,122+((batch*8+i)%15)*16);
        await new Promise(resolve => setTimeout(resolve,4));
      }
      send(1234,777);
      return {x:1234,y:777,stoppedAt:performance.now()};
    });
    await page.waitForFunction(({x,y}) => {
      const mouse = window.__DESKTOP_POB__.stats?.inputMouse;
      return mouse?.x === x && mouse?.y === y;
    }, finalPosition);
    const catchUp = await page.evaluate(at => performance.now()-at, finalPosition.stoppedAt);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await page.waitForTimeout(150);
    results.push(await page.evaluate(catchUp => ({...window.__INPUT_PROBE__,catchUpMs:catchUp,frames:window.__DESKTOP_POB__.frameSamples.length}), catchUp));
  }
  assert.ok(instrumented);
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples());
  await page.mouse.move(1244,855);
  await page.waitForTimeout(250);
  const idleMotionFrames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples.length);
  if (process.argv.includes("--expect-coalesced")) {
    for (const result of results) {
      assert.equal(result.maxPending,1,"Free motion must have at most one worker RPC awaiting reply");
      assert.ok(result.sent < 241,"A busy worker must skip superseded positions");
    }
    assert.equal(idleMotionFrames,1,"An ordinary mouse move must not force trailing redraws");
  }
  const report = {syntheticMouseEventsPerRun:241,results,idleMotionFrames,note:"Catch-up measures final input to observed frame callback, including polling overhead; not GPU presentation time."};
  if (reportFile) await writeFile(reportFile,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
