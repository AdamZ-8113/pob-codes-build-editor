import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicConfig } from "../public-config.mjs";

const upstream = dirname(fileURLToPath(import.meta.url));
const root = dirname(upstream);
const publicRuntime = publicConfig();
const release = process.env.POB_IMPORT2_RELEASE;
if (!release || !/^[a-f0-9]{24}$/.test(release)) {
  throw new Error("POB_IMPORT2_RELEASE must be a 24-character lowercase hex fingerprint");
}

const releaseRoot = `${publicRuntime.basePath}/releases/${release}`;

export default defineConfig({
  root,
  base: `${releaseRoot}/shell/`,
  publicDir: join(upstream, "packages/driver/public"),
  cacheDir: join(root, "node_modules/.vite-import2"),
  resolve: {
    alias: {
      dds: join(upstream, "packages/dds/src/index.ts"),
      "pob-game": join(upstream, "packages/game/src/index.ts"),
    },
  },
  define: {
    __BPTC_SUPPORT_OVERRIDE__: "undefined",
    __MAX_RENDERING_DIMENSION_OVERRIDE__: "undefined",
    __IMPORT2_PREVIEW__: "true",
    __IMPORT2_PAYLOAD_PREFIX__: JSON.stringify(`${releaseRoot}/payload`),
    __DESKTOP_DEV_LAN_HOSTS__: "[]",
    __PUBLIC_PRODUCT_NAME__: JSON.stringify(publicRuntime.productName),
    __PUBLIC_REPOSITORY_URL__: JSON.stringify(publicRuntime.repositoryUrl),
    __PUBLIC_API_BASE_URL__: JSON.stringify(publicRuntime.apiBaseUrl),
    __PUBLIC_TELEMETRY_ENDPOINT__: JSON.stringify(publicRuntime.telemetryEndpoint),
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@bokuweb/zstd-wasm"], esbuildOptions: { target: "es2020" } },
  build: {
    outDir: join(root, `.runtime/import2-shell-${release}`),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [{
        src: join(upstream, "node_modules/texture2ddecoder-wasm/wasm/*").replaceAll("\\", "/"),
        dest: "texture2ddecoder",
      }],
    }),
  ],
});
