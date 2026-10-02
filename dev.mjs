import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { lanAddresses, lanCertificate, lanGateway, lanSetupPlugin } from "./dev-network.mjs";

const root = dirname(fileURLToPath(import.meta.url));
// Deno pins/installs this app's dependencies independently of the npm workspaces.
// Node runs the local HTTP services (including address-pinned HTTPS requests).
const vite = join(root, "upstream/node_modules/vite/dist/node/index.js");
if (!existsSync(vite)) throw new Error("Run npm run prepare:runtime before starting the app.");
const {createServer} = await import(pathToFileURL(vite).href);
const addresses = process.argv.includes("--lan") ? lanAddresses() : [];
const certificate = addresses.length ? lanCertificate(join(root, ".runtime/lan-dev"), addresses) : undefined;
const servers = [], gateways = [];
const base = {configFile:join(root,"upstream/vite.local.config.ts"),
  define:{__DESKTOP_DEV_LAN_HOSTS__:JSON.stringify(addresses)}};
let closing;
const close = () => closing ??= (async () => {
  await Promise.all(gateways.map(g => g.close()));
  await Promise.all(servers.map(s => s.close()));
})();
try {
  const local = await createServer({...base, ...(certificate ? {plugins:[lanSetupPlugin(addresses,certificate)]} : {})});
  servers.push(local); await local.listen();
  console.log("Desktop PoB: http://127.0.0.1:3010/");
  if (certificate) {
    const secure = await createServer({...base, cacheDir:join(root,"node_modules/.vite-lan"), server:{host:"127.0.0.1", port:0, strictPort:true,
      https:{key:certificate.key,cert:certificate.cert}, hmr:{clientPort:3010}}});
    servers.push(secure); await secure.listen();
    const tlsPort = secure.httpServer.address().port;
    for (const address of addresses) {
      const gateway = lanGateway(address,3010,tlsPort); gateways.push(gateway);
      await new Promise((resolve,reject) => { gateway.server.once("error",reject); gateway.server.listen(3010,address,resolve); });
      console.log(`LAN editor: https://${address}:3010/`);
      console.log(`First-time certificate setup: http://${address}:3010/`);
    }
    console.log(`Development CA fingerprint: ${certificate.fingerprint}`);
  } else if (process.argv.includes("--lan")) console.warn("No private IPv4 network interface found; desktop PoB is available on localhost.");
  for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => void close());
} catch (error) { await close(); throw error; }
