import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../.runtime/import2-release");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".zip": "application/zip" };

// Serve candidate bytes only. Interpret the candidate's static controls, never
// proxy a request or fall back to a development source tree or SPA document.
export async function createReleaseTestServer(directory = root) {
  const base = await realpath(directory);
  const rules = [];
  for (const line of (await readFile(join(base, "_headers"), "utf8")).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim().split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      rules.push({ match: new RegExp(`^${pattern}$`), headers: {} });
    } else {
      const header = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (!header || !rules.length) throw new Error("Invalid candidate headers");
      rules.at(-1).headers[header[1]] = header[2];
    }
  }
  const redirects = (await readFile(join(base, "_redirects"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/));
  return createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) { response.writeHead(403).end(); return; }
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(part => part.startsWith(".")) || /\/(?:_headers|_redirects)$/.test(pathname)) {
        response.writeHead(404).end(); return;
      }
      const headers = Object.assign({}, ...rules.filter(rule => rule.match.test(pathname)).map(rule => rule.headers));
      const redirect = redirects.find(([from]) => from === pathname);
      if (redirect) { response.writeHead(Number(redirect[2]), { ...headers, location: redirect[1] }).end(); return; }
      const file = await realpath(join(base, pathname, pathname.endsWith("/") ? "index.html" : ""));
      const inside = relative(base, file);
      if (!inside || isAbsolute(inside) || inside.startsWith(`..${sep}`) || inside === "..") { response.writeHead(404).end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { ...headers, "content-type": types[extname(file)] ?? "application/octet-stream", "content-length": info.size });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).on("error", () => response.destroy()).pipe(response);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createReleaseTestServer();
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(3011, "127.0.0.1", () => console.log("Candidate test server: http://127.0.0.1:3011/import2/"));
}
