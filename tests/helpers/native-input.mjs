// Clipboard permissions must be granted for the test origin by its context.
// Real paste delivers one native input operation; per-character typing forces
// a render for each key and is disproportionately slow with software WebGL.
export async function pasteNativeText(page, text) {
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+v");
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
}

export async function timedNativePhase(name, run, context = {}) {
  const started = performance.now();
  try { return await run(); }
  finally { console.log(JSON.stringify({ phase: name, ...context, ms: Math.round(performance.now() - started) })); }
}
