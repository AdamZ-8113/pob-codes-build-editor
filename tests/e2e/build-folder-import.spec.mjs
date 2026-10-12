import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const fixtureCode = (await readFile(
  new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url),
  "utf8",
)).trim();
const fixtureXml = inflateSync(Buffer.from(fixtureCode, "base64url"));

async function waitForReady(page) {
  await page.waitForFunction(
    () => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors?.length,
    null,
    { timeout: 120_000 },
  );
  expect(await page.evaluate(() => window.__DESKTOP_POB__.errors)).toEqual([]);
  expect(await page.evaluate(() => window.__DESKTOP_POB__.ready)).toBe(true);
}

async function showBuildList(page) {
  if (await page.evaluate(() => window.__DESKTOP_POB__.buildListState?.mode) === "LIST") return;
  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 35, y: 16 } });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await expect.poll(
    () => page.evaluate(() => window.__DESKTOP_POB__.buildListState?.mode),
    { timeout: 30_000 },
  ).toBe("LIST");
}

async function importFolder(page, directory, expectedFolder) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import Folder" }).click();
  await (await chooser).setFiles(directory);
  await expect(page.locator(".pob-build-folder-status")).toContainText(
    `into Builds > ${expectedFolder}.`,
    { timeout: 120_000 },
  );
}

async function inspectBuildFolder(page, name) {
  return await page.evaluate(async folderName => {
    const root = await navigator.storage.getDirectory();
    const user = await root.getDirectoryHandle("Path of Building");
    const builds = await user.getDirectoryHandle("Builds");
    const folder = await builds.getDirectoryHandle(folderName);
    const files = {};
    const visit = async (directory, prefix = "") => {
      for await (const [entryName, handle] of directory.entries()) {
        if (handle.kind === "directory") await visit(handle, `${prefix}${entryName}/`);
        else files[`${prefix}${entryName}`] = await (await handle.getFile()).text();
      }
    };
    await visit(folder);
    let registry = [];
    try {
      const internal = await root.getDirectoryHandle(".pob-codes-build-imports-v1");
      for await (const [entryName] of internal.entries()) registry.push(entryName);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
    return { files, registry };
  }, name);
}

test("visible sidecar imports an additive local snapshot and native PoB can edit and save it", async ({ page, context }) => {
  test.setTimeout(300_000);
  const temporary = await mkdtemp(join(tmpdir(), "pob-build-folder-import-"));
  const selected = join(temporary, "League Builds");
  const externalRequests = [];
  const pageErrors = [];
  try {
    await mkdir(join(selected, "Nested"), { recursive: true });
    await writeFile(join(selected, "one.xml"), fixtureXml);
    await writeFile(join(selected, "Nested", "two.xml"), fixtureXml);
    await writeFile(join(selected, "notes.txt"), "This file must not be imported.");

    page.on("pageerror", error => pageErrors.push(error.message));
    context.on("request", request => {
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:3010") {
        externalRequests.push({ url: request.url(), body: request.postData() });
      }
    });

    await page.goto("/");
    await waitForReady(page);
    await showBuildList(page);

    const button = page.getByRole("button", { name: "Import Folder" });
    await expect(button).toBeVisible();
    const layout = await page.evaluate(() => {
      const panel = document.querySelector(".pob-build-folder-import");
      const button = panel.querySelector("button");
      const layer = panel.parentElement;
      const editable = document.querySelector('[contenteditable="true"]');
      const panelRect = panel.getBoundingClientRect();
      const layerRect = layer.getBoundingClientRect();
      const state = window.__DESKTOP_POB__.buildListState;
      const nativeListRight = layerRect.left + (state.virtualWidth / 2 + 450) * (layerRect.width / state.virtualWidth);
      const style = getComputedStyle(button);
      return {
        buttonHeight: button.getBoundingClientRect().height,
        buttonBorderRadius: style.borderRadius,
        buttonFont: style.fontFamily,
        gap: panelRect.left - nativeListRight,
        panelInsideEditingHost: editable.contains(panel),
        panelAriaLive: panel.querySelector('[aria-live="polite"]') !== null,
      };
    });
    expect(layout.panelInsideEditingHost).toBe(false);
    expect(layout.panelAriaLive).toBe(true);
    expect(layout.buttonHeight).toBeCloseTo(20, 0);
    expect(layout.buttonBorderRadius).toBe("0px");
    expect(layout.buttonFont).toContain("PoB Liberation Sans");
    expect(layout.gap).toBeGreaterThanOrEqual(14);

    const beforeResize = await button.boundingBox();
    const beforeVirtualWidth = await page.evaluate(() => window.__DESKTOP_POB__.buildListState.virtualWidth);
    await page.setViewportSize({ width: 1800, height: 1000 });
    await expect.poll(
      () => page.evaluate(() => window.__DESKTOP_POB__.buildListState.virtualWidth),
      { timeout: 30_000 },
    ).toBeGreaterThan(beforeVirtualWidth);
    const afterResize = await button.boundingBox();
    expect(afterResize.x).toBeGreaterThan(beforeResize.x);

    await button.focus();
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect(button).toBeFocused();

    await importFolder(page, selected, "League Builds");
    await expect(page.locator(".pob-build-folder-status")).toContainText("Imported 2 builds");
    await expect(page.locator(".pob-build-folder-status")).toContainText("Ignored 1 non-build file");
    const first = await inspectBuildFolder(page, "League Builds");
    expect(Object.keys(first.files).sort()).toEqual(["Nested/two.xml", "one.xml"]);
    expect(Buffer.from(first.files["one.xml"])).toEqual(fixtureXml);
    expect(first.registry).toEqual([]);

    await importFolder(page, selected, "League Builds[2]");
    const second = await inspectBuildFolder(page, "League Builds[2]");
    expect(Object.keys(second.files).sort()).toEqual(["Nested/two.xml", "one.xml"]);
    expect((await inspectBuildFolder(page, "League Builds")).files["one.xml"]).toBe(first.files["one.xml"]);

    // Native BuildListControl: the first root row is the imported folder; inside
    // it the nested folder sorts before the root build, making one.xml row two.
    const canvas = page.locator("canvas");
    await canvas.dblclick({ position: { x: (await canvas.boundingBox()).width / 2, y: 85 } });
    await expect.poll(() => page.evaluate(() => window.__DESKTOP_POB__.buildListState?.subPath)).toBe("League Builds/");
    await canvas.dblclick({ position: { x: (await canvas.boundingBox()).width / 2, y: 105 } });
    await expect.poll(() => page.evaluate(() => window.__DESKTOP_POB__.buildListState?.mode)).toBe("BUILD");
    await expect(page.locator(".pob-build-folder-import")).toBeHidden();

    await canvas.click({ position: { x: (await canvas.boundingBox()).width / 2 + 135, y: 16 } });
    await page.keyboard.press("Control+a");
    await page.keyboard.type("73");
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await canvas.click({ position: { x: 100, y: 16 } });
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await expect.poll(async () => (await inspectBuildFolder(page, "League Builds")).files["one.xml"]).toContain('level="73"');

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForReady(page);
    expect((await inspectBuildFolder(page, "League Builds")).files["one.xml"]).toContain('level="73"');
    expect(await page.evaluate(path => document.body.innerText.includes(path), temporary)).toBe(false);
    expect(externalRequests.some(request =>
      request.url.includes("League%20Builds") || request.url.includes("League Builds") ||
      request.body?.includes("League Builds") || request.body?.includes("PathOfBuilding")
    )).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("same-origin tabs share the write lock and use live folder-name reservations", async ({ page, context }) => {
  test.setTimeout(300_000);
  const temporary = await mkdtemp(join(tmpdir(), "pob-build-folder-lock-"));
  const firstRoot = join(temporary, "first", "Shared Builds");
  const secondRoot = join(temporary, "second", "Shared Builds");
  const secondPage = await context.newPage();
  try {
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    await writeFile(join(firstRoot, "first.xml"), fixtureXml);
    await writeFile(join(secondRoot, "second.xml"), fixtureXml);
    await Promise.all([page.goto("/"), secondPage.goto("/")]);
    await Promise.all([waitForReady(page), waitForReady(secondPage)]);
    await Promise.all([showBuildList(page), showBuildList(secondPage)]);

    await page.evaluate(() => {
      window.__releaseImportProbe = undefined;
      void navigator.locks.request("pob-codes-local-user-storage-v1", async () => {
        await new Promise(resolve => { window.__releaseImportProbe = resolve; });
      });
    });
    await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).held.length).toBe(1);
    await secondPage.evaluate(() => {
      window.__importProbeAcquired = false;
      void navigator.locks.request("pob-codes-local-user-storage-v1", () => {
        window.__importProbeAcquired = true;
      });
    });
    await expect.poll(async () => (await secondPage.evaluate(() => navigator.locks.query())).pending.length).toBe(1);
    await page.evaluate(() => window.__releaseImportProbe());
    await expect.poll(() => secondPage.evaluate(() => window.__importProbeAcquired)).toBe(true);

    // The visible-control scenario above owns picker acceptance. Bring each tab
    // forward before setting its real directory input; Chromium does not attach
    // directories to a background tab reliably under automation. The second
    // broker's ZenFS index predates the first import, so the raw OPFS lookup is
    // what prevents an overwrite here.
    await page.bringToFront();
    await page.locator(".pob-build-folder-input").setInputFiles(firstRoot);
    await expect(page.locator(".pob-build-folder-status")).toContainText("Imported 1 build", { timeout: 120_000 });
    await secondPage.bringToFront();
    await secondPage.locator(".pob-build-folder-input").setInputFiles(secondRoot);
    await Promise.all([
      expect(page.locator(".pob-build-folder-status")).toContainText("Imported 1 build", { timeout: 120_000 }),
      expect(secondPage.locator(".pob-build-folder-status")).toContainText("Imported 1 build", { timeout: 120_000 }),
    ]);
    const folders = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const builds = await (await root.getDirectoryHandle("Path of Building")).getDirectoryHandle("Builds");
      const names = [];
      for await (const [name, handle] of builds.entries()) {
        if (handle.kind === "directory" && name.startsWith("Shared Builds")) names.push(name);
      }
      return names.sort();
    });
    expect(folders).toEqual(["Shared Builds", "Shared Builds[2]"]);
    const snapshots = await Promise.all(folders.map(name => inspectBuildFolder(page, name)));
    expect(snapshots.flatMap(snapshot => Object.keys(snapshot.files)).sort()).toEqual(["first.xml", "second.xml"]);
    expect(snapshots.every(snapshot => snapshot.registry.length === 0)).toBe(true);
  } finally {
    await secondPage.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("starts on the build selector and sidecar geometry follows a 150 percent native UI override at DPR 1", async ({ page }) => {
  await page.setViewportSize({ width: 2530, height: 1196 });
  await page.goto("/404.html");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const user = await root.getDirectoryHandle("Path of Building", { create: true });
    const settings = await user.getFileHandle("Settings.xml", { create: true });
    const writable = await settings.createWritable();
    await writable.write('<?xml version="1.0"?><PathOfBuilding><Mode mode="BUILD"><Arg boolean="false"/><Arg string="Unnamed build"/></Mode><Misc dpiScaleOverridePercent="150"/></PathOfBuilding>');
    await writable.close();
  });
  await page.goto("/");
  await waitForReady(page);
  await expect.poll(() => page.evaluate(() => window.__DESKTOP_POB__.buildListState?.mode)).toBe("LIST");
  const state = await page.evaluate(() => window.__DESKTOP_POB__.buildListState);
  expect(state.uiScale).toBe(1.5);
  expect(state.pixelRatio).toBe(1);
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector(".pob-build-folder-import");
    const layer = panel.parentElement;
    const button = panel.querySelector("button");
    const panelRect = panel.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    const state = window.__DESKTOP_POB__.buildListState;
    const nativeListRight = layerRect.left + (state.virtualWidth / 2 + 450) * state.uiScale;
    return {
      buttonHeight: button.getBoundingClientRect().height,
      gap: panelRect.left - nativeListRight,
      fontSize: Number.parseFloat(getComputedStyle(button).fontSize) * state.uiScale,
    };
  });
  expect(metrics.buttonHeight).toBeCloseTo(30, 0);
  expect(metrics.gap).toBeCloseTo(24, 0);
  expect(metrics.fontSize).toBeCloseTo(21, 0);
  const sourcePath = page.locator(".pob-build-folder-source-hint code");
  await expect(sourcePath).toHaveText("shell:Personal\\Path of Building\\Builds");
  await sourcePath.dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("shell:Personal\\Path of Building\\Builds");
});
