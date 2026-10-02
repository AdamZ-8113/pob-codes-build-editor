import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import http from "node:http";
import https from "node:https";
import {X509Certificate} from "node:crypto";
import {privateIPv4, allowedDevHost, devRequestHost, lanAddresses, lanCertificate, lanGateway} from "./dev-network.mjs";
import {createLocalServices} from "./local-services.mjs";

test("LAN hosts are explicit private interfaces, not arbitrary hostnames or public addresses", () => {
  for (const ip of ["10.0.0.2","172.16.1.2","192.168.1.30","::ffff:192.168.1.31"]) assert.equal(privateIPv4(ip),true);
  for (const ip of ["127.0.0.1","1.1.1.1","172.32.1.2","192.168.1.999","192.168.x.1","::1",""]) assert.equal(privateIPv4(ip),false);
  assert.equal(allowedDevHost("127.0.0.1:3010"),true);
  assert.equal(allowedDevHost("192.168.1.30:3010"),false);
  assert.equal(allowedDevHost("192.168.1.30:3010",["192.168.1.30"]),true);
  for (const host of ["evil.test:3010","192.168.1.30.evil.test:3010","192.168.1.30:80","user@192.168.1.30:3010","192.168.1.30:3010/path"]) assert.equal(allowedDevHost(host,["192.168.1.30"]),false);
  assert.throws(() => lanGateway("0.0.0.0",3010,3011));
  assert.equal(devRequestHost({":authority":"192.168.1.30:3010"}),"192.168.1.30:3010");
  assert.equal(devRequestHost({host:"localhost:3010"}),"localhost:3010");
  assert.equal(devRequestHost({host:"localhost:3010",":authority":"evil.test"}),"");
});

test("local CA reuse, HTTPS gateway and same-origin LAN bridge retain their boundaries", async t => {
  const host=lanAddresses()[0];
  if(!host) return t.skip("No private IPv4 interface for LAN listener test");
  const scratch=mkdtempSync(join(tmpdir(),"pob-lan-test-"));
  t.after(() => {
    assert.equal(dirname(scratch),tmpdir());
    rmSync(scratch,{recursive:true,force:true});
  });
  const certificate=lanCertificate(scratch,[host]);
  const root=new X509Certificate(certificate.ca),leaf=new X509Certificate(certificate.cert);
  assert.ok(root.ca); assert.ok(leaf.verify(root.publicKey)); assert.equal(leaf.checkIP(host),host);
  assert.equal(lanCertificate(scratch,[host]).fingerprint,certificate.fingerprint,"Restarts preserve installed CA trust");
  assert.deepEqual(lanCertificate(scratch,[host]).cert,certificate.cert,"Unexpired server certificate reused");
  const renewed=lanCertificate(scratch,[host,"192.168.253.1"]);
  assert.equal(renewed.fingerprint,certificate.fingerprint,"A new LAN IP renews only the server certificate");
  assert.equal(new X509Certificate(renewed.cert).checkIP("192.168.253.1"),"192.168.253.1");
  const services=createLocalServices({lanHosts:[host],remoteRequest:async()=>({status:200,headers:{},body:"public fixture"})});
  const plain=http.createServer((_req,res)=>res.end("setup"));
  const secure=https.createServer({key:certificate.key,cert:certificate.cert},(req,res)=>services.middleware(req,res,()=>res.end("worker shell")));
  await Promise.all([plain,secure].map(s=>new Promise(resolve=>s.listen(0,"127.0.0.1",resolve))));
  const gateway=lanGateway(host,plain.address().port,secure.address().port);
  await new Promise(resolve=>gateway.server.listen(0,host,resolve));
  t.after(async()=>{await gateway.close();services.close();await Promise.all([plain,secure].map(s=>new Promise(resolve=>s.close(resolve))));});
  const port=gateway.server.address().port, origin=`https://${host}:${port}`;
  const call=(path,headers={})=>new Promise((resolve,reject)=>{
    const req=https.request(origin+path,{ca:root.toString(),method:"POST",headers:{"Content-Type":"application/json","X-Pob-Local":"1",Origin:origin,...headers}},res=>{
      const chunks=[];res.on("data",b=>chunks.push(b));res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });req.on("error",reject);req.end(JSON.stringify({url:"https://pobb.in/test"}));
  });
  assert.equal(await (await fetch(`http://${host}:${port}/`)).text(),"setup");
  const result=await call("/fetch");assert.equal(result.status,200);assert.equal(JSON.parse(result.body).body,"public fixture");
  assert.equal((await call("/fetch",{Origin:"https://evil.test"})).status,403);
  assert.equal((await call("/fetch",{"X-Pob-Local":""})).status,403);
  assert.equal((await call("/oauth/start")).status,403,"Loopback OAuth never starts for a LAN device");
  const startup=readFileSync(new URL('./dev.mjs',import.meta.url),'utf8');
  const manifest=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));
  assert.equal(manifest.scripts.dev,"node dev.mjs");
  assert.match(startup,/127\.0\.0\.1:3010/);assert.match(startup,/gateway\.server\.listen\(3010/);assert.match(startup,/process\.argv\.includes\("--lan"\)/);
});
