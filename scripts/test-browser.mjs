import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://127.0.0.1:3010";
// Payload fault-containment probes deliberately wait for transport timeouts.
const harnessTimeout = 10 * 60_000;

export function validateRegistry(registry, discovered) {
  const ci = registry.ci;
  const localOnly = registry.localOnly;
  if (!Array.isArray(ci) || ci.length === 0 || !localOnly || typeof localOnly !== "object" || Array.isArray(localOnly)) {
    throw new Error("Browser harness registry is stale: expected ci and localOnly classifications");
  }
  const registered = [...ci, ...Object.keys(localOnly)];
  if (registered.some(name => typeof name !== "string" || !/^test-[a-z0-9-]+\.mjs$/.test(name)) ||
      new Set(registered).size !== registered.length ||
      JSON.stringify([...registered].sort()) !== JSON.stringify([...discovered].sort()) ||
      Object.values(localOnly).some(reason => typeof reason !== "string" || !reason.trim())) {
    throw new Error("Browser harness registry is stale: classify every harness exactly once and explain local-only entries");
  }
  return registry;
}

export function harnessEnvironment(environment = process.env) {
  const result = { ...environment };
  // Windows environment variable names are case-insensitive.
  for (const name of Object.keys(result)) {
    if (name.toUpperCase() === "DESKTOP_POB_ORIGIN") delete result[name];
  }
  return result;
}

export function selectHarnesses(registry, args) {
  if (args.length === 0) return registry.ci;
  if (args.length === 1 && args[0] === "--all") return [...registry.ci, ...Object.keys(registry.localOnly)];
  if (args.length === 2 && args[0] === "--only") {
    const name = args[1].endsWith(".mjs") ? args[1] : `${args[1]}.mjs`;
    if (registry.ci.includes(name) || Object.hasOwn(registry.localOnly, name)) return [name];
  }
  throw new Error("Usage: npm run test:browser -- [--all | --only <test-name>]");
}

async function portIsListening() {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: 3010 });
    socket.setTimeout(2_000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Cannot verify port 3010 is unused")); });
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

function managedProcess(file, environment, captureOutput = false, args = []) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root, env: environment, windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", captureOutput ? "pipe" : "inherit", "inherit"],
  });
  const completed = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, completed };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function stopProcess({ child, completed }) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  let timer;
  const exited = await Promise.race([completed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
  clearTimeout(timer);
  if (!exited) {
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (process.platform === "win32") child.kill();
    await completed;
  }
}

async function waitForServer(server, started, aborted) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (aborted()) throw new Error("Browser harness run interrupted");
    if (!server.child.pid || server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("Browser harness development server exited before readiness");
    if (started()) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2_000), redirect: "error" });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* Wait for this server's HTTP listener. */ }
    }
    await delay(100);
  }
  throw new Error("Browser harness development server readiness timed out");
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  if (Object.keys(environment).some(name => name.toUpperCase() === "DESKTOP_POB_ORIGIN")) {
    throw new Error("test:browser refuses DESKTOP_POB_ORIGIN; it owns a loopback server on port 3010");
  }
  const registry = validateRegistry(
    JSON.parse(await readFile(new URL("../tests/browser-harnesses.json", import.meta.url), "utf8")),
    (await readdir(new URL("../tests/browser/", import.meta.url))).filter(name => name.endsWith(".mjs")),
  );
  const selected = selectHarnesses(registry, args);
  if (await portIsListening()) throw new Error("test:browser refuses an existing listener on 127.0.0.1:3010; stop it first");
  const env = harnessEnvironment(environment);
  const lan = selected.includes("test-lan-dev.mjs");
  const server = managedProcess("scripts/dev/dev.mjs", env, true, lan ? ["--lan"] : []);
  let output = "", started = false, interrupted = false, active;
  server.child.stdout.on("data", chunk => {
    process.stdout.write(chunk);
    output = (output + chunk).slice(-4096);
    started ||= output.includes(`Desktop PoB: ${origin}/`);
  });
  const interrupt = () => {
    interrupted = true;
    if (active) void stopProcess(active);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
  let failed = false;
  try {
    await waitForServer(server, () => started, () => interrupted);
    for (const name of selected) {
      if (interrupted) throw new Error("Browser harness run interrupted");
      if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("Browser harness development server exited");
      console.log(`\nBrowser harness: ${name}`);
      const start = performance.now();
      active = managedProcess(`tests/browser/${name}`, env);
      let timer;
      let timedOut = false;
      timer = setTimeout(() => { timedOut = true; void stopProcess(active); }, harnessTimeout);
      const result = await active.completed;
      clearTimeout(timer);
      await stopProcess(active);
      active = undefined;
      const serverRunning = server.child.exitCode === null && server.child.signalCode === null;
      const passed = result.code === 0 && !timedOut && !interrupted && serverRunning;
      failed ||= !passed;
      console.log(`${name}: ${passed ? "PASS" : "FAIL"} ${(performance.now() - start).toFixed(0)} ms${timedOut ? " (timeout)" : ""}${serverRunning ? "" : " (server exited)"}`);
      if (result.error) console.error(result.error.message);
    }
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
    if (active) await stopProcess(active);
    await stopProcess(server);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
