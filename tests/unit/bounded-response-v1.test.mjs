import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { fetchBoundedText } from "../../src/bounded-response-v1.js";

test("response reading counts bytes and decodes UTF-8 across chunks", async () => {
  const bytes = new TextEncoder().encode("a😀b");
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 3));
      controller.enqueue(bytes.slice(3));
      controller.close();
    },
  }));
  const result = await fetchBoundedText("https://example.test", {}, { fetchImpl, maxBytes: 6 });
  assert.equal(result.text, "a😀b");
  await assert.rejects(fetchBoundedText("https://example.test", {}, { fetchImpl, maxBytes: 5 }), /size limit/);
});

test("response timeout spans headers and a real HTTP response body", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("first bytes");
    // Leave the body open so only the client's deadline can finish the read.
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(fetchBoundedText(`http://127.0.0.1:${server.address().port}`, {}, { maxBytes: 1024, timeoutMs: 100 }), /timed out/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("external abort cancels a stalled body even when the transport ignores its signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const request = fetchBoundedText("https://example.test", { signal: controller.signal }, {
    maxBytes: 1024,
    fetchImpl: async () => new Response(new ReadableStream({
      pull() { started(); },
      cancel() { cancelled = true; },
    })),
  });
  await reading;
  await setImmediate();
  controller.abort(new Error("Import reset."));
  await assert.rejects(request, /Import reset/);
  assert.equal(cancelled, true);
});

test("timeout rejects a fetch that ignores cancellation", async () => {
  let signal;
  await assert.rejects(fetchBoundedText("https://example.test", {}, {
    maxBytes: 1024,
    timeoutMs: 10,
    fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}); },
  }), /timed out/);
  assert.equal(signal.aborted, true);
});

test("already-aborted requests do not call fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Already cancelled."));
  let calls = 0;
  await assert.rejects(fetchBoundedText("https://example.test", { signal: controller.signal }, {
    maxBytes: 10,
    fetchImpl: async () => { calls++; return new Response("unused"); },
  }), /Already cancelled/);
  assert.equal(calls, 0);
});

test("a response arriving after cancellation has its body cancelled", async () => {
  let finishFetch;
  let cancelled = false;
  const controller = new AbortController();
  const request = fetchBoundedText("https://example.test", { signal: controller.signal }, {
    maxBytes: 1024,
    fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }),
  });
  controller.abort(new Error("Cancelled before headers."));
  await assert.rejects(request, /Cancelled before headers/);
  finishFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await setImmediate();
  assert.equal(cancelled, true);
});
