// Failure-only Chromium diagnostics. Worker pauses are resumed immediately;
// no application source, request routing, or acceptance deadline is changed.
export async function watchWorkerStacks(context, page) {
  const connection = await context.newCDPSession(page);
  const sessions = new Map();
  const commands = new Map();
  let sequence = 0;
  const send = (sessionId, method) => {
    const id = ++sequence;
    commands.set(id, method);
    return connection.send("Target.sendMessageToTarget", {
      sessionId, message: JSON.stringify({ id, method }),
    }).catch(() => { commands.delete(id); });
  };
  connection.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    sessions.set(sessionId, { url: targetInfo.url, type: targetInfo.type, stack: null });
    void send(sessionId, "Runtime.runIfWaitingForDebugger");
  });
  connection.on("Target.detachedFromTarget", ({ sessionId }) => sessions.delete(sessionId));
  connection.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    const event = JSON.parse(message);
    if (event.id) {
      const method = commands.get(event.id);
      commands.delete(event.id);
      if (method === "Runtime.getHeapUsage" && sessions.has(sessionId)) {
        sessions.get(sessionId).heap = Object.fromEntries(
          ["usedSize", "totalSize", "embedderHeapUsedSize", "backingStorageSize"]
            .filter(key => Number.isFinite(event.result?.[key]))
            .map(key => [key, event.result[key]]),
        );
      }
    }
    if (event.method !== "Debugger.paused") return;
    const session = sessions.get(sessionId);
    if (session) session.stack = event.params.callFrames.slice(0, 12).map(frame => ({
      function: frame.functionName.slice(0, 200), url: frame.url.slice(0, 1_000),
      scriptId: frame.location.scriptId, line: frame.location.lineNumber,
      column: frame.location.columnNumber,
    }));
    void send(sessionId, "Debugger.resume");
  });
  await connection.send("Target.setAutoAttach", {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: false,
  });
  return {
    async capture() {
      for (const [id, session] of [...sessions].slice(0, 8)) {
        session.stack = null;
        void send(id, "Runtime.getHeapUsage");
        // Enabling the debugger deoptimizes WebAssembly. Do that only after
        // acceptance fails, so normal runtime execution retains its real speed.
        void send(id, "Debugger.enable").then(() => send(id, "Debugger.pause"));
      }
      await new Promise(resolve => setTimeout(resolve, 2_000));
      return [...sessions.values()].slice(0, 8).map(session => ({ ...session, url: session.url.slice(0, 1_000) }));
    },
    async close() { await connection.detach().catch(() => {}); },
  };
}
