import test from "node:test";
import assert from "node:assert/strict";

import { publicConfig } from "./public-config.mjs";

test("public API and telemetry configuration accepts only the owned production endpoints", () => {
  assert.deepEqual(
    {
      apiBaseUrl: publicConfig({ PUBLIC_API_BASE_URL: "" }).apiBaseUrl,
      telemetryEndpoint: publicConfig({ PUBLIC_TELEMETRY_ENDPOINT: "" }).telemetryEndpoint,
    },
    { apiBaseUrl: "", telemetryEndpoint: "" },
  );
  assert.equal(publicConfig({ PUBLIC_API_BASE_URL: "https://api.pob.codes" }).apiBaseUrl, "https://api.pob.codes");
  assert.equal(
    publicConfig({ PUBLIC_TELEMETRY_ENDPOINT: "https://api.pob.codes/analytics/events" }).telemetryEndpoint,
    "https://api.pob.codes/analytics/events",
  );
  assert.throws(() => publicConfig({ PUBLIC_API_BASE_URL: "https://pob.codes/api" }), /api\.pob\.codes/);
  assert.throws(() => publicConfig({ PUBLIC_TELEMETRY_ENDPOINT: "https://example.com/analytics/events" }), /api\.pob\.codes/);
});
