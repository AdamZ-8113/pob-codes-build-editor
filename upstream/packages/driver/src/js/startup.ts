/** Native status codes and Lua errors caught by PoB must both fail startup. */
export function startRuntime(
  runtime: { init(): number; start(): number },
  luaError: () => Error | undefined,
): void {
  for (const phase of ["init", "start"] as const) {
    const status = runtime[phase]();
    const error = luaError();
    if (error) throw error;
    if (status !== 0) throw new Error(`Path of Building ${phase} failed (native status ${status})`);
  }
}
