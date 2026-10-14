/** First canonical frame and successful DOM attachment are independent events. */
export function createStartupReadiness(timeoutMs = 90_000) {
  let drawn = false;
  let attached = false;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  // A driver error can precede the caller awaiting attachment.
  void promise.catch(() => {});
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const settle = () => { if (attached && drawn && !failure) { clear(); resolve(); } };
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    clear();
    reject(failure);
  };
  return {
    frame(instances: number) {
      if (failure || drawn || instances <= 0) return false;
      drawn = true;
      settle();
      return true;
    },
    attached() {
      if (failure || attached) return;
      attached = true;
      if (!drawn) timer = setTimeout(() => fail(new Error("PoB started but did not draw its interface. Check the runtime diagnostics.")), timeoutMs);
      settle();
    },
    fail,
    async wait() { await promise; if (failure) throw failure; },
    assertHealthy() { if (failure) throw failure; },
  };
}

/** Startup details never replace a later lifecycle state or terminal error. */
export function createStartupPresenter(surface: HTMLElement, detail: HTMLElement) {
  let state: "starting" | "first-frame" | "ready" | "error" = "starting";
  let progress = -1;
  const timer = setTimeout(() => { if (state === "starting") detail.hidden = false; }, 150);
  return {
    update(value: number, _text: string) {
      if (state !== "starting" || value < progress) return;
      progress = value;
      const percent = Math.max(0, Math.min(100, Math.round(value)));
      detail.setAttribute("aria-valuenow", String(percent));
      const squares = detail.querySelectorAll(".payload-progress-square");
      const filled = Math.floor(percent * squares.length / 100);
      squares.forEach((square, index) => {
        square.toggleAttribute("data-filled", index < filled);
        square.toggleAttribute("data-active", index === filled);
      });
    },
    firstFrame() {
      if (state !== "starting") return;
      state = "first-frame";
      clearTimeout(timer);
      detail.hidden = true;
    },
    ready() {
      if (state === "error") return;
      state = "ready";
      clearTimeout(timer);
      surface.remove();
    },
    error() {
      state = "error";
      clearTimeout(timer);
      detail.hidden = true;
      // The shared payload alert owns error text and Reload (one announcement).
      surface.hidden = true;
    },
    dispose() { clearTimeout(timer); },
  };
}
