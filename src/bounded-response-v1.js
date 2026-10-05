// Keep the deadline active until the body has been consumed, and count actual
// streamed bytes rather than trusting Content-Length or buffering first.
export async function fetchBoundedText(url, init, { fetchImpl = fetch, timeoutMs = 12_000, maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid response limits.");
  }
  const controller = new AbortController();
  const externalSignal = init?.signal;
  let reader;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const reason = controller.signal.reason;
    // Cancellation need not finish before rejecting (a transport may stall).
    if (reader) void reader.cancel(reason).catch(() => {});
    rejectAbort(reason);
  };
  const relayAbort = () => controller.abort(externalSignal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  externalSignal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Response request timed out.")), timeoutMs);
  try {
    if (externalSignal?.aborted) relayAbort();
    controller.signal.throwIfAborted();
    const request = Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal })).then(response => {
      if (controller.signal.aborted) {
        void response.body?.cancel(controller.signal.reason).catch(() => {});
        controller.signal.throwIfAborted();
      }
      return response;
    });
    const response = await Promise.race([request, aborted]);
    reader = response.body?.getReader();
    controller.signal.throwIfAborted();
    if (!reader) return { response, text: "" };
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      controller.signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const error = new Error("Response exceeded the size limit.");
        controller.abort(error);
        throw error;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { response, text: parts.join("") };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    else if (reader) void reader.cancel(error).catch(() => {});
    // Ensure an abort before the first race also has a rejection handler.
    void aborted.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}
