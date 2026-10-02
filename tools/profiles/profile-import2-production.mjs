import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { cpus } from "node:os";
import { writeFile } from "node:fs/promises";

const target = new URL(process.env.IMPORT2_ORIGIN ?? "https://pob.codes/import2/");
const cloudflareManagedPrefix = "/cdn-cgi/";
const localPreview = process.env.IMPORT2_ALLOW_LOCAL === "1" && target.protocol === "http:" && target.hostname === "127.0.0.1";
if ((!localPreview && (target.protocol !== "https:" || target.hostname !== "pob.codes")) || target.pathname !== "/import2/") {
  throw new Error("IMPORT2_ORIGIN must be https://pob.codes/import2/");
}
const output = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
const disabledMode = process.argv.includes("--disabled");
if (disabledMode) {
  const [home, unknown, boundary] = await Promise.all([
    fetch(target),
    fetch(new URL("unknown-disabled-probe", target)),
    fetch(new URL("/import20", target)),
  ]);
  const [html, unknownBody, boundaryBody] = await Promise.all([
    home.text(),
    unknown.text(),
    boundary.text(),
  ]);
  const responses = {
    home: summarizeFetchResponse(home, html),
    unknown: summarizeFetchResponse(unknown, unknownBody),
    boundary: summarizeFetchResponse(boundary, boundaryBody),
  };
  if (home.status !== 200 || unknown.status !== 404 || boundary.status !== 404) {
    console.error(JSON.stringify({ target: target.href, mode: "disabled", responses }, null, 2));
  }
  assert.equal(home.status, 200);
  assert.match(html, /preview unavailable/i);
  const injectedScripts = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  for (const script of injectedScripts) {
    assert.ok(script.includes(cloudflareManagedPrefix), "Disabled page contains a non-Cloudflare script");
  }
  assert.doesNotMatch(html.replaceAll(/<script\b[\s\S]*?<\/script>/gi, ""), /<script\b|modulepreload/i);
  assert.match(home.headers.get("x-robots-tag") ?? "", /noindex/i);
  assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(home.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(unknown.status, 404);
  assert.equal(boundary.status, 404);
  console.log(JSON.stringify({ target: target.href, mode: "disabled", responses }));
}
if (!disabledMode) {
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const requests = [];
const failedResponses = [];
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push({ host: url.host, path: url.pathname, type: request.resourceType() });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    failedResponses.push({ host: url.host, path: url.pathname, status: response.status() });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const navigation = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const navigationEvidence = navigation
    ? {
        status: navigation.status(),
        statusText: navigation.statusText(),
        url: navigation.url(),
        contentType: navigation.headers()["content-type"] ?? null,
        cfMitigated: navigation.headers()["cf-mitigated"] ?? null,
      }
    : null;
  if (!navigation || navigation.status() >= 400 || navigationEvidence.cfMitigated === "challenge") {
    const title = await page.title().catch(() => null);
    throw new Error(`Import2 navigation was intercepted: ${JSON.stringify({ navigation: navigationEvidence, title })}`);
  }
  try {
    await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 180_000 });
  } catch (error) {
    const pageEvidence = await page.evaluate(() => ({
      desktopPobPresent: typeof window.__DESKTOP_POB__ === "object",
      errors: window.__DESKTOP_POB__?.errors ?? [],
      ready: window.__DESKTOP_POB__?.ready ?? false,
      status: document.querySelector("#status")?.textContent ?? null,
      title: document.title,
    })).catch((evaluationError) => ({ evaluationError: evaluationError.message }));
    console.error(JSON.stringify({
      target: target.href,
      mode: "full",
      navigation: navigationEvidence,
      page: pageEvidence,
      pageErrors: errors,
      failedResponses,
      recentRequests: requests.slice(-20),
    }, null, 2));
    throw error;
  }
  await page.waitForTimeout(1_000);
  const browserEvidence = await page.evaluate(() => ({
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    errors: window.__DESKTOP_POB__?.errors ?? [],
    marks: performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith("pob-import2-")).map((entry) => ({ name: entry.name, startTime: entry.startTime })),
    profile: window.__DESKTOP_POB__?.getRuntimeProfile(),
  }));
  const workerKinds = page.workers().map((worker) => {
    const path = new URL(worker.url()).pathname;
    if (/calc-helper/i.test(path)) return "helper";
    if (/broker/i.test(path)) return "broker";
    return "main";
  });
  assert.equal(browserEvidence.crossOriginIsolated, true);
  assert.equal(browserEvidence.sharedArrayBuffer, true);
  assert.deepEqual(browserEvidence.errors, []);
  assert.deepEqual(errors, []);
  assert.ok(workerKinds.includes("main"), "PoB main worker was not observed");
  assert.ok(workerKinds.includes("broker"), "PoB filesystem broker worker was not observed");
  for (const mark of ["pob-import2-shell-start", "pob-import2-first-pob-frame", "pob-import2-payload-ready"]) {
    assert.ok(browserEvidence.marks.some((entry) => entry.name === mark), `Missing performance mark ${mark}`);
  }
  assert.equal(requests.some((request) => request.host === "api.pob.codes"), false, "Import2 contacted the API Worker");
  const unexpectedMainSiteRequests = requests.filter(
    (request) => request.host === target.host && !request.path.startsWith("/import2") && !request.path.startsWith(cloudflareManagedPrefix),
  );
  if (unexpectedMainSiteRequests.length > 0) {
    console.error(JSON.stringify({ target: target.href, unexpectedMainSiteRequests }, null, 2));
  }
  assert.deepEqual(unexpectedMainSiteRequests, [], "Import2 requested an unexpected main-site path");
  assert.equal(requests.some((request) => request.path.endsWith("root.zip")), false, "Import2 requested the legacy payload");
  const startupMissing = failedResponses.slice();
  const allowedStartupMisses = new Set([
    "TreeData/PassiveMasteryConnectedButton.png",
    "TreeData/bloodline-3.webp",
    "TreeData/ascendancy-3.webp",
  ]);
  for (const response of startupMissing) {
    assert.equal(response.host, target.host, `Startup request failed outside the Import2 host: ${response.host}${response.path}`);
    assert.equal(response.status, 404, `Unexpected startup response status for ${response.path}`);
    const match = response.path.match(/^\/import2\/releases\/[a-f0-9]{24}\/payload\/root\/(.+)$/);
    assert.ok(match && allowedStartupMisses.has(match[1]), `Unexpected missing startup asset: ${response.path}`);
  }

  const [unknown, sourceMap, boundary, head] = await page.evaluate(async () => {
    const results = await Promise.all([
      fetch("/import2/unknown-probe", { cache: "no-store" }),
      fetch("/import2/releases/missing/app.js.map", { cache: "no-store" }),
      fetch("/import20", { cache: "no-store" }),
      fetch("/import2/", { method: "HEAD", cache: "no-store" }),
    ]);
    return results.map((response) => ({ status: response.status, worker: response.headers.get("server-timing") ?? "" }));
  });
  assert.equal(unknown.status, 404);
  assert.equal(sourceMap.status, 404);
  assert.equal(boundary.status, 404);
  assert.equal(head.status, 200);

  const legacy = await context.newPage();
  await legacy.goto(new URL("?legacyPayload=1", target).href, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await legacy.waitForFunction(() => document.querySelector("#status")?.classList.contains("status-error"));
  assert.match(await legacy.locator("#status").textContent(), /legacy payload is unavailable/i);
  await legacy.close();

  const report = {
    target: target.origin + target.pathname,
    browser: browser.version(),
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    requestCounts: Object.fromEntries([...new Set(requests.map((request) => request.type))].sort().map((type) => [type, requests.filter((request) => request.type === type).length])),
    cloudflareManagedRequestCount: requests.filter((request) => request.host === target.host && request.path.startsWith(cloudflareManagedPrefix)).length,
    workerKinds: workerKinds.sort(),
    marks: browserEvidence.marks,
    wasmBytes: browserEvidence.profile?.wasmBytes,
    payload: browserEvidence.profile?.filesystem?.payload,
    startupMissing,
    staticMissStatuses: { unknown: unknown.status, sourceMap: sourceMap.status, boundary: boundary.status, head: head.status },
  };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
}

function summarizeFetchResponse(response, body) {
  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    cfMitigated: response.headers.get("cf-mitigated"),
    bodySnippet: String(body).replace(/\s+/g, " ").trim().slice(0, 240),
  };
}
