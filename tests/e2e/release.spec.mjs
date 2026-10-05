import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";

const origin = "http://127.0.0.1:3011";
const fixture = (await readFile(new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
const decode = code => inflateSync(Buffer.from(code, "base64url")).toString();
const buildTag = xml => xml.match(/<Build\s[^>]*>/)?.[0] ?? "Missing Build element";
const life = xml => xml.match(/<PlayerStat\b[^>]*\bstat="Life"[^>]*>/)?.[0].match(/\bvalue="([^"]+)"/)?.[1];

async function ready(page) {
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors?.length, null, { timeout: 120_000 });
  expect(await page.evaluate(() => window.__DESKTOP_POB__.errors)).toEqual([]);
  expect(await page.evaluate(() => window.__DESKTOP_POB__.ready)).toBe(true);
}

test("candidate imports, edits, recalculates, shares and persists the displayed native build", async ({ page, context }) => {
  const faults = [], blocked = [], assetPaths = [], uploads = [], resolutions = [], characterRequests = [];
  page.on("pageerror", error => faults.push(error.message));
  const cors = { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type,x-pobcodes-client", "access-control-allow-methods": "GET,POST,OPTIONS", "cache-control": "no-store" };
  // Context routes cover workers and newly opened tabs as well as this page.
  // Every external URL is either an explicit fixture or rejected before I/O.
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { assetPaths.push(url.pathname); await route.continue(); return; }
    if (url.origin === "https://api.pob.codes" && ["/pob/plain", "/pob", "/fixture-build/raw"].includes(url.pathname)) {
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
      if (url.pathname === "/pob/plain" && request.method() === "POST") {
        uploads.push(request.postData());
        await route.fulfill({ status: 200, headers: cors, contentType: "text/plain", body: "fixture-build" }); return;
      }
      if (url.pathname === "/pob" && request.method() === "POST") {
        resolutions.push(request.postData());
        await route.fulfill({ status: 201, headers: cors, json: { id: "fixture-build" } }); return;
      }
      if (url.pathname === "/fixture-build/raw" && request.method() === "GET") {
        await route.fulfill({ status: 200, headers: cors, contentType: "text/plain", body: fixture }); return;
      }
    }
    if (url.href === "https://pob.codes/b/fixture-build" && request.isNavigationRequest()) {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture shared build</title><link rel=icon href='data:,'>" }); return;
    }
    if (url.origin === "https://pob.codes" && ["/api/poe/characters", "/api/poe/import-character"].includes(url.pathname)) {
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
      if (request.method() === "POST") {
        characterRequests.push({ path: url.pathname, body: request.postDataJSON() });
        await route.fulfill({ headers: cors, json: url.pathname.endsWith("/characters")
          ? { characters: [{ name: "FixtureDuelist", class: "Duelist", level: 91, league: "Standard", realm: "pc" }] }
          : { itemsJson: JSON.stringify({ items: [] }), passiveSkillsJson: JSON.stringify({ hashes: [], hashes_ex: [], mastery_effects: {} }) } });
        return;
      }
    }
    blocked.push(request.url()); await route.abort("blockedbyclient");
  });

  const response = await page.goto("/import2/");
  expect(response.status()).toBe(200);
  expect(response.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(response.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
  await ready(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(async () => (await window.__DESKTOP_POB__.getRuntimeProfile()).filesystem.payload.packagesBeforeReady)).toBeGreaterThan(0);
  expect(await page.title()).toContain("PoB Codes Build Editor");
  const metadata = await (await context.request.get(`${origin}/import2/release.json`)).json();
  const prefix = `/import2/releases/${metadata.current}/`;
  expect(metadata.current).toMatch(/^[a-f0-9]{24}$/);
  const shellScript = await page.locator("script[type=module]").getAttribute("src");
  expect(shellScript.startsWith(`${prefix}shell/`)).toBe(true);
  const shellResponse = await context.request.get(`${origin}${shellScript}`);
  expect(shellResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  const resolved = await page.evaluate(() => window.__DESKTOP_POB__.resolveBuildInput("https://pobb.in/fixture"));
  expect(resolved).toBe(fixture);
  expect(resolutions).toEqual(["https://pobb.in/fixture"]);
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), resolved);
  const exportCode = () => page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
  const initialXml = decode(await exportCode());
  expect(buildTag(initialXml)).toMatch(/className="Duelist"/);
  const canvas = page.locator("canvas");
  // Pinned native Build.lua character-level input in the displayed PoB header.
  await canvas.click({ position: { x: (await canvas.boundingBox()).width / 2 + 135, y: 16 } });
  await page.keyboard.press("Control+a");
  await page.keyboard.type("73");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const editedXml = decode(await exportCode());
  expect(buildTag(editedXml)).toMatch(/level="73"/);
  expect(life(initialXml)).toBeTruthy();
  expect(life(editedXml)).toBeTruthy();
  expect(life(editedXml)).not.toBe(life(initialXml));

  // Exercise an actual padded native export, not a substituted getBuildCode.
  // XML attribute ordering can vary; adjust a real note until compression needs padding.
  let exported = await exportCode();
  if (!exported.endsWith("=")) {
    await page.keyboard.press("Control+6");
    await canvas.click({ position: { x: 400, y: 200 } });
    for (let attempt = 0; attempt < 20 && !exported.endsWith("="); attempt++) {
      await page.keyboard.type(` release-${attempt}`);
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      exported = await exportCode();
    }
  }
  expect(exported).toMatch(/=$/);
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Launch in PoB.Codes" }).click();
  const popup = await popupPromise;
  await expect(page.locator("#status")).toHaveText("Build opened in PoB.Codes");
  await expect(popup).toHaveURL("https://pob.codes/b/fixture-build");
  expect(uploads).toHaveLength(1);
  expect(decode(uploads[0])).toBe(decode(exported));
  await popup.close();
  await page.bringToFront();
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), exported);
  expect(buildTag(decode(await exportCode()))).toMatch(/level="73"/);

  await canvas.click({ position: { x: 120, y: 16 } });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Release browser acceptance");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width / 2 - 45, y: (bounds.height - 555) / 2 + 535 } });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const savedXml = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    // Native PoB currently persists here even though the host configuration
    // retains the Import2 preview namespace. Preserve existing users' files.
    const namespace = await root.getDirectoryHandle("Path of Building");
    const builds = await namespace.getDirectoryHandle("Builds");
    return (await (await builds.getFileHandle("Release browser acceptance.xml")).getFile()).text();
  });
  await expect.poll(async () => buildTag(await savedXml().catch(() => "")), { timeout: 15_000 }).toMatch(/level="73"/);
  await page.reload();
  await ready(page);
  expect(buildTag(await savedXml())).toMatch(/level="73"/);
  // Reopen the persisted document through the same native driver's importer.
  const persisted = await savedXml();
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
  expect(buildTag(decode(await exportCode()))).not.toMatch(/level="73"/);
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), deflateSync(persisted).toString("base64url"));
  expect(buildTag(decode(await exportCode()))).toMatch(/level="73"/);
  const directories = await page.evaluate(async () => {
    const result = [];
    for await (const [name] of (await navigator.storage.getDirectory()).entries()) result.push(name);
    return result;
  });
  expect(directories).toContain("Path of Building");

  // Pinned Build.lua sidebar (322 px); browser adapter hides the OAuth section
  // and anchors the public-account section at y=18 within the import viewport.
  // Use native UI so this also proves the release selects the production host adapter.
  await page.keyboard.press("Control+i");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await canvas.click({ position: { x: 508, y: 124 } });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await page.keyboard.type("FixtureAccount#1234");
  await canvas.click({ position: { x: 646, y: 124 } });
  await expect.poll(() => characterRequests.length).toBe(1);
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await canvas.click({ position: { x: 450, y: 188 } });
  await expect.poll(() => characterRequests.length).toBe(2);
  await expect.poll(async () => buildTag(decode(await exportCode()))).toMatch(/level="91"/);
  expect(characterRequests).toEqual([
    { path: "/api/poe/characters", body: { accountName: "FixtureAccount#1234", realm: "pc" } },
    { path: "/api/poe/import-character", body: { accountName: "FixtureAccount#1234", characterName: "FixtureDuelist", realm: "pc" } },
  ]);
  expect(assetPaths.some(path => path.startsWith(`${prefix}payload/`))).toBe(true);
  expect(assetPaths.every(path => path === "/import2/" || path.startsWith(prefix))).toBe(true);
  expect(await page.evaluate(() => window.__DESKTOP_POB__.errors)).toEqual([]);
  expect(faults).toEqual([]);
  expect(blocked).toEqual([]);
});
