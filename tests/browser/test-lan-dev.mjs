import {chromium} from "@playwright/test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {lanAddresses} from "../../scripts/dev/dev-network.mjs";
import {canonical} from "../../scripts/lib/mobile-test-support.mjs";

const host=process.argv[2] ?? lanAddresses()[0];
assert.ok(lanAddresses().includes(host),"Supply an active private LAN interface");
const origin=`https://${host}:3010`;
const code=(await readFile(new URL('../../fixtures/guided import parity desktop 329.txt',import.meta.url),'utf8')).trim();
const browser=await chromium.launch({headless:true,channel:"chrome"});
try {
  const hashes=[], results=[];
  for(const [name,url,options] of [
    ["desktop","http://127.0.0.1:3010/",{}],
    ["phone",origin+"/",{viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,
      userAgent:"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/154 Mobile Safari/537.36"}],
  ]) {
    // Only this test context bypasses OS certificate trust. Real devices must
    // install the CA from the HTTP setup page; Node's HTTPS probe checks trust.
    const context=await browser.newContext({ignoreHTTPSErrors:true,...options});
    try {
      const page=await context.newPage();
      page.on("pageerror",error=>console.error(name+": "+error.message));
      page.on("requestfailed",request=>console.error(name+": "+request.url()+" "+request.failure()?.errorText));
      console.log("Checking "+name+" at "+url);await page.goto(url);
      try {await page.waitForFunction(()=>window.__DESKTOP_POB__?.ready||window.__DESKTOP_POB__?.errors.length,null,{timeout:60000});}
      catch(error){console.error(await page.evaluate(()=>({url:location.href,secure:isSecureContext,isolated:crossOriginIsolated,body:document.body.innerText.slice(0,400),state:window.__DESKTOP_POB__?.errors})));throw error;}
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      const capabilities=await page.evaluate(()=>({secure:isSecureContext,isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer,policy:window.__DESKTOP_POB__.devicePolicy.kind}));
      assert.deepEqual(capabilities,{secure:true,isolated:true,shared:"function",policy:name==="phone"?"mobile":"desktop"});
      await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),code);
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      hashes.push(await canonical(page));
      if(name==="phone") {
        const state=await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile());
        assert.equal(state.helpers.requested,0);
        assert.equal(await page.locator("#mobile-compare").count(),1);
        for(const path of ["/.runtime/lan-dev/root-key.pem","/.runtime/lan-dev/server-key.pem","/@fs/"+fileURLToPath(new URL('../../.runtime/lan-dev/root-key.pem',import.meta.url)).replaceAll("\\","/")]) {
          const response=await context.request.get(origin+path);assert.ok(response.status()>=400,"Private certificate file must not be served: "+path);
        }
        const denied=await page.evaluate(async()=>{
          const r=await fetch("/local-api/oauth/start",{method:"POST",headers:{"Content-Type":"application/json","X-Pob-Local":"1"},body:"{}"});return r.status;
        });assert.equal(denied,403);
      }
      results.push({name,...capabilities,export:hashes.at(-1)});
    } finally {await context.close();}
  }
  assert.equal(hashes[0],hashes[1],"LAN mobile import retains complete desktop export");
  console.log(JSON.stringify({passed:true,origin,devices:results},null,2));
} finally {await browser.close();}
