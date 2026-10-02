const DEFAULTS = Object.freeze({
  basePath: "/import2",
  siteOrigin: "https://pob.codes",
  productName: "PoB Codes Build Editor",
  repositoryUrl: "https://github.com/AdamZ-8113/pob-codes-build-editor",
  apiBaseUrl: "",
  telemetryEndpoint: "",
});

function pathValue(value) {
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/i.test(normalized) || normalized.endsWith("/")) {
    throw new Error(`Invalid PUBLIC_BASE_PATH: ${value}`);
  }
  return normalized;
}

function publicUrl(value, name, { allowEmpty = false } = {}) {
  if (allowEmpty && !value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function publicConfig(env = process.env) {
  const config = {
    basePath: pathValue(env.PUBLIC_BASE_PATH ?? DEFAULTS.basePath),
    siteOrigin: publicUrl(env.PUBLIC_SITE_ORIGIN ?? DEFAULTS.siteOrigin, "PUBLIC_SITE_ORIGIN"),
    productName: env.PUBLIC_PRODUCT_NAME?.trim() || DEFAULTS.productName,
    repositoryUrl: publicUrl(env.PUBLIC_REPOSITORY_URL ?? DEFAULTS.repositoryUrl, "PUBLIC_REPOSITORY_URL"),
    apiBaseUrl: publicUrl(env.PUBLIC_API_BASE_URL ?? DEFAULTS.apiBaseUrl, "PUBLIC_API_BASE_URL", { allowEmpty: true }),
    telemetryEndpoint: publicUrl(env.PUBLIC_TELEMETRY_ENDPOINT ?? DEFAULTS.telemetryEndpoint, "PUBLIC_TELEMETRY_ENDPOINT", { allowEmpty: true }),
  };
  if (config.apiBaseUrl && config.apiBaseUrl !== "https://api.pob.codes") {
    throw new Error("PUBLIC_API_BASE_URL must be https://api.pob.codes");
  }
  if (config.telemetryEndpoint && config.telemetryEndpoint !== "https://api.pob.codes/analytics/events") {
    throw new Error("PUBLIC_TELEMETRY_ENDPOINT must be https://api.pob.codes/analytics/events");
  }
  return Object.freeze(config);
}
