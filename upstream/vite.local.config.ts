import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createLocalServices } from "../local-services.mjs";
import { allowedDevHost, devRequestHost } from "../dev-network.mjs";
import { publicConfig } from "../public-config.mjs";

const upstream = dirname(fileURLToPath(import.meta.url));
const root = dirname(upstream);
const payload = join(root, ".runtime/payload");
const publicRuntime = publicConfig();

export default defineConfig({
  root,
  publicDir: join(upstream, "packages/driver/public"),
  cacheDir: join(root, "node_modules/.vite"),
  resolve: {
    alias: {
      dds: join(upstream, "packages/dds/src/index.ts"),
      "pob-game": join(upstream, "packages/game/src/index.ts"),
    },
    dedupe: ["react", "react-dom"],
  },
  define: {
    __BPTC_SUPPORT_OVERRIDE__: "undefined",
    __MAX_RENDERING_DIMENSION_OVERRIDE__: "undefined",
    __IMPORT2_PREVIEW__: "false",
    __IMPORT2_PAYLOAD_PREFIX__: JSON.stringify(""),
    __DESKTOP_DEV_LAN_HOSTS__: "[]",
    __PUBLIC_PRODUCT_NAME__: JSON.stringify(publicRuntime.productName),
    __PUBLIC_REPOSITORY_URL__: JSON.stringify(publicRuntime.repositoryUrl),
    __PUBLIC_API_BASE_URL__: JSON.stringify(""),
    __PUBLIC_TELEMETRY_ENDPOINT__: JSON.stringify(""),
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@bokuweb/zstd-wasm"], esbuildOptions: { target: "es2020" } },
  server: {
    host: "127.0.0.1", port: 3010, strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    fs: { strict: true, allow: [root], deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.runtime/lan-dev/**"] },
  },
  plugins: [
    react(), tailwindcss(),
    viteStaticCopy({ targets: [{ src: join(upstream, "node_modules/texture2ddecoder-wasm/wasm/*").replaceAll("\\", "/"), dest: "texture2ddecoder" }] }),
    {
      name: "localhost-desktop-services",
      configureServer(server) {
        if (!existsSync(join(payload, "root.zip"))) throw new Error("Build Editor assets are missing. Run npm run pack first.");
        if (!existsSync(join(upstream, "packages/driver/dist/release/driver.wasm"))) throw new Error("Desktop PoB WASM is missing. Run the desktop runtime build first.");
        const lanHosts: string[] = JSON.parse(server.config.define?.__DESKTOP_DEV_LAN_HOSTS__ as string ?? "[]");
        const services = createLocalServices({ lanHosts: server.config.server.https ? lanHosts : [] });
        server.httpServer?.on("close", () => services.close());
        server.middlewares.use((req, res, next) => {
          if (!allowedDevHost(devRequestHost(req.headers), lanHosts)) {
            res.writeHead(403).end("Unsupported local Host"); return;
          }
          next();
        });
        server.middlewares.use("/local-api", services.middleware);
        server.middlewares.use("/payload", async (req, res) => {
          try {
            if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
            const name = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
            const file = resolve(payload, `.${name}`);
            if (!file.startsWith(payload + "/") && !file.startsWith(payload + "\\")) { res.writeHead(403).end(); return; }
            const info = await stat(file);
            if (!info.isFile()) { res.writeHead(404).end(); return; }
            const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
            const cache = /^\/packages\/[a-f0-9]{64}\.zip$/.test(name) ? "public, max-age=31536000, immutable" : "no-cache";
            res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Cache-Control": cache, "Cross-Origin-Resource-Policy": "same-origin" });
            if (req.method === "HEAD") res.end(); else createReadStream(file).on("error", () => res.destroy()).pipe(res);
          } catch { res.writeHead(404).end("Desktop PoB asset not found"); }
        });
      },
    },
  ],
});
