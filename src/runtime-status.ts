import type { DriverDiagnostic } from "../upstream/packages/driver/src/js/diagnostic.ts";

export type RuntimeStatusNotice = {
  message: string;
  tone: "info" | "warning" | "error";
  durationMs: number;
};

export function runtimeStatusNotice(
  diagnostic: DriverDiagnostic,
): RuntimeStatusNotice | undefined {
  const reason = String(diagnostic.data?.reason ?? "");
  const count = Number(diagnostic.data?.count ?? 0);

  if (diagnostic.event === "helpers-starting") {
    return notice(
      `Starting ${count || "background"} calculation helper${
        count === 1 ? "" : "s"
      }…`,
      "info",
      4_000,
    );
  }
  if (diagnostic.event === "helpers-ready") {
    return notice(
      `${count || "Background"} calculation helper${
        count === 1 ? " is" : "s are"
      } ready.`,
      "info",
      3_000,
    );
  }
  if (diagnostic.event === "helpers-fallback") {
    if (reason === "helper-memory") {
      return notice(
        "A helper exceeded the 1 GB memory cap. Memory was released; continuing with serial processing.",
        "warning",
        9_000,
      );
    }
    if (reason === "ui-memory") {
      return notice(
        "The main worker is near its 2 GB memory cap. Helpers were released; continuing with serial processing.",
        "warning",
        9_000,
      );
    }
    if (reason === "aggregate-memory") {
      return notice(
        "The browser memory safety limit was reached. Helpers were released; continuing with serial processing.",
        "warning",
        9_000,
      );
    }
    return notice(
      "A calculation helper stopped unexpectedly. Continuing with serial processing.",
      "warning",
      9_000,
    );
  }
  if (diagnostic.event === "helpers-unavailable") {
    return notice(
      "Background helpers are unavailable on this device. Using serial processing.",
      "info",
      6_000,
    );
  }
  if (diagnostic.phase === "webgl" && diagnostic.event === "context-lost") {
    return notice(
      "Graphics context lost. Waiting for the browser to restore it…",
      "warning",
      0,
    );
  }
  if (diagnostic.phase === "webgl" && diagnostic.event === "context-restored") {
    return notice("Graphics context restored.", "info", 4_000);
  }
  if (diagnostic.event === "rpc-error") {
    const operation = String(
      diagnostic.data?.operation ?? "background operation",
    ).replaceAll("-", " ");
    return notice(
      `The ${operation} operation failed. You can keep working; retry if needed.`,
      "warning",
      7_000,
    );
  }
  if (diagnostic.event === "image-load-error") {
    return notice(
      "An image could not be decoded. It will be retried if needed.",
      "warning",
      7_000,
    );
  }
  if (
    diagnostic.phase === "worker" &&
    ["error", "messageerror"].includes(diagnostic.event)
  ) {
    return notice(
      "A background worker stopped unexpectedly. Reload if the editor stops responding.",
      "error",
      0,
    );
  }
  return undefined;
}

function notice(
  message: string,
  tone: RuntimeStatusNotice["tone"],
  durationMs: number,
): RuntimeStatusNotice {
  return { message, tone, durationMs };
}
