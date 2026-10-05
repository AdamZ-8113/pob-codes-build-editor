// Keep standalone local runs on installed Chrome; CI opts into bundled Chromium.
export function browserChannel(environment = process.env) {
  return environment.BUILD_EDITOR_BROWSER_CHANNEL === undefined
    ? "chrome"
    : environment.BUILD_EDITOR_BROWSER_CHANNEL || undefined;
}
