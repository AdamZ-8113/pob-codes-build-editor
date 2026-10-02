import { assertEquals, assertThrows } from "@std/assert";
import { startRuntime } from "../../src/js/startup.ts";

Deno.test("startup rejects failed initialization before calling the application", () => {
  let started = false;
  assertThrows(() =>
    startRuntime({
      init: () => 1,
      start: () => {
        started = true;
        return 0;
      },
    }, () => undefined)
  );
  assertEquals(started, false);
});

Deno.test("startup rejects native Lua boot failure with its original error", () => {
  const error = new Error("Modules/Main.lua:342: syntax error near '+'");
  let reported: Error | undefined;
  const thrown = assertThrows(() =>
    startRuntime({
      init: () => 0,
      start: () => {
        reported = error;
        return 1;
      },
    }, () => reported)
  );
  assertEquals(thrown, error);
});

Deno.test("startup rejects a Lua error caught internally by PoB even with zero native status", () => {
  let error: Error | undefined;
  assertThrows(() =>
    startRuntime({
      init: () => 0,
      start: () => {
        error = new Error("Init failed");
        return 0;
      },
    }, () => error)
  );
});

Deno.test("startup succeeds only after initialization and application start succeed", () => {
  const calls: string[] = [];
  startRuntime({
    init: () => {
      calls.push("init");
      return 0;
    },
    start: () => {
      calls.push("start");
      return 0;
    },
  }, () => undefined);
  assertEquals(calls, ["init", "start"]);
});
