import test from "node:test"; import assert from "node:assert/strict";
import { createBuildTransferV1 } from "../../src/build-transfer-v1.js";
import { readFile } from "node:fs/promises";
const code="abcDEF_0123456789-xyz";
const response=(body,{ok=true,status=200,cache="no-store"}={})=>({ok,status,headers:{get(name){return name.toLowerCase()==="cache-control"?cache:null}},async json(){return body},async text(){return body}});
test("raw codes and owned pob.codes links resolve through only the typed API contract", async () => {
  const calls=[]; const transfer=createBuildTransferV1({apiBaseUrl:"https://api.pob.codes",getBuildCode:async()=>code,fetchImpl:async(...args)=>{calls.push(args);return response(code)}});
  assert.equal(await transfer.resolve(code),code); assert.equal(await transfer.resolve("https://pob.codes/b/abc_1234"),code); assert.equal(calls[0][0],"https://api.pob.codes/abc_1234/raw");
  await assert.rejects(transfer.resolve("https://evil.example/b/abc_1234"),/owned/); await assert.rejects(transfer.resolve("https://pob.codes/other/abc_1234"),/Unsupported/);
  assert.throws(()=>createBuildTransferV1({apiBaseUrl:"https://pob.codes/api",getBuildCode:async()=>code}),/api\.pob\.codes/);
});
test("shell sharing is an explicit user action", async () => {
  const [html,main]=await Promise.all([readFile("index.html","utf8"),readFile("src/main.ts","utf8")]); assert.match(html,/id="share-build"[^>]*disabled/); assert.match(main,/shareButton\.onclick/); assert.match(main,/buildTransfer!\.share\(\)/);
});
test("sharing retries the exact exported snapshot and accepts only canonical viewer links", async () => {
  let attempt=0,exports=0; const bodies=[]; const transfer=createBuildTransferV1({apiBaseUrl:"https://api.pob.codes/",getBuildCode:async()=>{exports++;return code},fetchImpl:async(_url,init)=>{bodies.push(init.body);attempt++;return attempt===1?response({}, {ok:false,status:500}):response({id:"record-id",shortUrl:"/b/share_123"},{status:201})}});
  await assert.rejects(transfer.share(),/retry/); assert.equal(transfer.hasPendingShare,true); assert.equal(await transfer.retry(),"https://pob.codes/b/share_123"); assert.equal(exports,1); assert.equal(bodies[0],bodies[1]); assert.equal(transfer.hasPendingShare,false);
});
