import { createServer as createTcpServer, connect } from "node:net";
import { networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";

export function privateIPv4(address = "") {
  const parts = address.replace(/^::ffff:/, "").split(".");
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || +p > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}

export function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(a =>
    a && !a.internal && a.family === "IPv4" && privateIPv4(a.address)).map(a => a.address))];
}

export function allowedDevHost(value = "", lan = []) {
  try {
    const url = new URL(`http://${value}`);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" &&
      [url.hostname, `${url.hostname}:3010`].includes(value.toLowerCase()) &&
      ["localhost", "127.0.0.1", "[::1]", ...lan].includes(url.hostname);
  } catch { return false; }
}

export function devRequestHost(headers) {
  const host = headers.host, authority = headers[":authority"];
  if (host !== undefined && authority !== undefined && host !== authority) return "";
  const value = host ?? authority;
  return typeof value === "string" ? value : "";
}

function findOpenSSL() {
  if (process.env.POB_DESKTOP_OPENSSL) return process.env.POB_DESKTOP_OPENSSL;
  try { execFileSync("openssl", ["version"], {stdio:"ignore", windowsHide:true}); return "openssl"; } catch {}
  if (process.platform === "win32") {
    const git = execFileSync("where.exe", ["git.exe"], {encoding:"utf8", windowsHide:true}).trim().split(/\r?\n/)[0];
    const candidate = join(dirname(dirname(git)), "usr/bin/openssl.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("LAN HTTPS requires OpenSSL (included with Git for Windows), or POB_DESKTOP_OPENSSL pointing to it.");
}

// Devices trust this CA, so limit it to the addresses it serves: a leaked key
// then cannot impersonate public sites. Older unconstrained CAs are replaced.
const caNameConstraints = "nameConstraints=critical,permitted;DNS:localhost,permitted;IP:127.0.0.0/255.0.0.0," +
  "permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0";
const nameConstraintsOid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]); // DER OID 2.5.29.30

/** Persistent local development CA. Never install trust or expose its private key. */
export function lanCertificate(directory, addresses) {
  if (!addresses.length || addresses.some(a => !privateIPv4(a))) throw new Error("LAN certificates require private IPv4 addresses.");
  mkdirSync(directory, {recursive:true, mode:0o700});
  const file = name => join(directory, name);
  const rootCert = file("root-cert.pem"), rootKey = file("root-key.pem");
  const cert = file("server-cert.pem"), key = file("server-key.pem");
  const valid = (certificate, privateKey) => {
    try {
      const x509 = new X509Certificate(readFileSync(certificate));
      return Date.parse(x509.validTo) > Date.now() + 7 * 86400_000 &&
        x509.checkPrivateKey(createPrivateKey(readFileSync(privateKey))) && x509;
    } catch { return false; }
  };
  let openssl;
  const run = args => {
    openssl ??= findOpenSSL();
    execFileSync(openssl, args, {stdio:"pipe", windowsHide:true});
  };
  const newKey = path => writeFileSync(path, generateKeyPairSync("rsa", {modulusLength:2048,
    privateKeyEncoding:{type:"pkcs8",format:"pem"}, publicKeyEncoding:{type:"spki",format:"pem"}}).privateKey, {mode:0o600});
  let root = valid(rootCert, rootKey);
  if (!root || !root.ca || !root.verify(root.publicKey) || !root.raw.includes(nameConstraintsOid)) {
    newKey(rootKey);
    run(["req", "-new", "-x509", "-sha256", "-days", "730", "-key", rootKey, "-out", rootCert,
      "-subj", "/CN=PoB Codes Local Development CA", "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", caNameConstraints]);
    root = new X509Certificate(readFileSync(rootCert));
  }
  const leaf = valid(cert, key);
  if (!leaf || !leaf.verify(root.publicKey) || addresses.some(a => !leaf.checkIP(a))) {
    newKey(key);
    const request = file("server.csr"), extensions = file("server.cnf");
    writeFileSync(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1," +
      addresses.map(a => `IP:${a}`).join(",") + "\n");
    run(["req", "-new", "-sha256", "-key", key, "-out", request, "-subj", "/CN=PoB Codes LAN Editor"]);
    run(["x509", "-req", "-sha256", "-days", "30", "-in", request, "-CA", rootCert, "-CAkey", rootKey,
      "-set_serial", "0x" + randomBytes(16).toString("hex"), "-extfile", extensions, "-out", cert]);
  }
  return {key:readFileSync(key), cert:readFileSync(cert), ca:root.raw,
    fingerprint:root.fingerprint256, certificatePath:rootCert};
}

/** A private-interface port can route HTTPS and the HTTP setup page on 3010. */
export function lanGateway(host, httpPort, httpsPort) {
  if (!privateIPv4(host)) throw new Error("LAN listener must use a private IPv4 interface.");
  const sockets = new Set();
  const server = createTcpServer(socket => {
    if (!privateIPv4(socket.remoteAddress)) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once("data", first => {
      socket.pause(); socket.setTimeout(0);
      const upstream = connect({host:"127.0.0.1", port:first[0] === 22 ? httpsPort : httpPort});
      sockets.add(upstream); upstream.once("close", () => { sockets.delete(upstream); socket.destroy(); });
      upstream.once("error", () => socket.destroy()); socket.once("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("connect", () => { upstream.write(first); socket.pipe(upstream); upstream.pipe(socket); socket.resume(); });
    });
    socket.on("error", () => {});
  });
  return {server, close:() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); }};
}

export function lanSetupPlugin(addresses, certificate) {
  return {name:"desktop-lan-setup", enforce:"pre", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const host = devRequestHost(req.headers);
      if (!allowedDevHost(host, addresses)) return next();
      const hostname = new URL(`http://${host}`).hostname;
      if (!addresses.includes(hostname)) return next();
      const pathname = new URL(req.url, "http://localhost").pathname;
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      if (pathname === "/lan-ca.cer") {
        res.writeHead(200, {"Content-Type":"application/pkix-cert", "Content-Disposition":"attachment; filename=pob-codes-dev-ca.cer"});
        res.end(req.method === "HEAD" ? undefined : certificate.ca); return;
      }
      const url = `https://${hostname}:3010/`;
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(req.method === "HEAD" ? undefined : `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PoB LAN setup</title><style>body{font:18px system-ui;max-width:42rem;margin:2rem auto;padding:1rem;line-height:1.5}a{display:inline-block;padding:.6rem 0;overflow-wrap:anywhere}code{overflow-wrap:anywhere}</style><h1>PoB build editor on your local network</h1><p>The browser worker needs trusted HTTPS. Install this PC's development certificate once, then open the editor.</p><p><a href="/lan-ca.cer">Download development CA certificate</a></p><p>Android: Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate (names vary by device).</p><p>iPhone/iPad: Settings → General → VPN &amp; Device Management → install the downloaded profile, then General → About → Certificate Trust Settings → enable full trust.</p><p>Certificate fingerprint: <code>${certificate.fingerprint}</code></p><p><a href="${url}">Open ${url}</a></p><p>This development certificate only covers private network addresses and is for your own PC. Account OAuth is available from the PC's localhost editor; paste an exported build code to test on other devices.</p></html>`);
    });
  }};
}
