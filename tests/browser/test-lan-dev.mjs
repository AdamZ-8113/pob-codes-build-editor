import {chromium} from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {inflateSync} from "node:zlib";
import {lanAddresses} from "../../scripts/dev/dev-network.mjs";
import {canonicalExportTree} from "../../scripts/lib/canonical-export.mjs";

const host=process.argv[2] ?? lanAddresses()[0];
assert.ok(lanAddresses().includes(host),"Supply an active private LAN interface");
const origin=`https://${host}:3010`;
const code=(await readFile(new URL('../../fixtures/guided import parity desktop 329.txt',import.meta.url),'utf8')).trim();
const browser=await chromium.launch({headless:true,channel: browserChannel()});
try {
  const hashes=[], results=[];
  for(const [name,url,options] of [
    ["desktop","http://127.0.0.1:3010/",{}],
    ["lan",origin+"/",{}],
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
      const capabilities=await page.evaluate(()=>({secure:isSecureContext,isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer}));
      assert.deepEqual(capabilities,{secure:true,isolated:true,shared:"function"});
      await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),code);
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      hashes.push(await canonical(page));
      if(name==="lan") {
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
  assert.equal(hashes[0],hashes[1],"LAN import retains complete desktop export");
  console.log(JSON.stringify({passed:true,origin,devices:results},null,2));
} finally {await browser.close();}

async function canonical(page) {
  const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
  const xml = inflateSync(Buffer.from(code,"base64url")).toString();
  const tree = await page.evaluate(value => {
    const root = new DOMParser().parseFromString(value,"application/xml");
    const walk = node => node.nodeType === 1 ? [node.tagName,[...node.attributes].map(a=>[a.name,a.value]),
      [...node.childNodes].map(walk).filter(v=>v!==null)] : node.textContent.trim() || null;
    return walk(root.documentElement);
  },xml);
  return createHash("sha256").update(JSON.stringify(canonicalExportTree(tree))).digest("hex");
}
