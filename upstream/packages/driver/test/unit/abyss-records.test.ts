import { assertEquals, assertRejects } from '@std/assert';
import { AbyssRecords } from '../../src/js/abyss-records.ts';
import { loadPayload } from '../../src/js/payload.ts';
import { createPackages } from '../../../packer/src/packages.ts';
import { parseAbyssLookup, buildAbyssMiniatureLookup } from '../../../../abyss-lookup-format.js';

function block(start: number) {
  // Two seeds, one socket, one node with one stat roll, exact native ABYS.
  const bytes = new Uint8Array([65,66,89,83,1,7,start,0,start+1,0,1,0,1,1,187,9,
    1,1,0,1,2,3,1,42,0, 1,1,0,1,2,3,1,43,0]);
  parseAbyssLookup(bytes);
  return bytes;
}
Deno.test('Abyss records coalesce, extract native bytes, evict all package references and skip prefetch', async () => {
  const index = {pin:'a'.repeat(40),format:1,families:[{type:7,format:'ABYS',seedMinimum:100,seedMaximum:103,seedIncrement:1,bucketSize:2,sockets:[2491]}]};
  const {manifest,archives} = await createPackages([
    {path:'GameVersions.lua',data:new TextEncoder().encode('treeVersionList={"3_29"}')},
    {path:'TreeData/3_29/tree.lua',data:new Uint8Array([1])},
    {path:'Data/TimelessJewelData/AbyssRecords/index.json',data:new TextEncoder().encode(JSON.stringify(index))},
    ...[100,102].map((seed,i) => ({path:`Data/TimelessJewelData/AbyssRecords/7-2491-${i}.bin`,data:block(seed)})),
  ],index.pin);
  const requests:string[]=[];
  const payload = await loadPayload('/payload',(async (url:string) => {
    requests.push(url);
    return url.endsWith('manifest.json') ? Response.json(manifest) : new Response(archives.get(url.split('/').at(-1)!.slice(0,-4)));
  }) as typeof fetch);
  payload.controller!.startPrefetch();
  await new Promise(resolve => setTimeout(resolve,10));
  assertEquals(requests.length,3);
  const eager=await loadPayload('/payload',(async(url:string)=>url.endsWith('manifest.json')?Response.json(manifest):new Response(archives.get(url.split('/').at(-1)!.slice(0,-4)))) as typeof fetch,{eager:true});
  assertEquals(eager.controller!.profile().loadedPackages.some(id=>id.startsWith('abyss-')),false,'Diagnostic eager startup also leaves Abyss demand-only');
  const records = new AbyssRecords(payload.controller!,200);
  const [a,b] = await Promise.all([records.read(7,100,2491,false),records.read(7,101,2491,false)]);
  assertEquals(a,buildAbyssMiniatureLookup(parseAbyssLookup(block(100)),{seed:100,socketId:2491}));
  assertEquals(b,buildAbyssMiniatureLookup(parseAbyssLookup(block(100)),{seed:101,socketId:2491}));
  assertEquals(records.profile().loads,1);
  assertEquals(payload.controller!.profile().loadedPackages.some(id => id.startsWith('abyss-')),false,'Released ZIP and mounted sources');
  await records.read(7,102,2491,false);
  assertEquals(records.profile().evictions,1);
  assertEquals(records.profile().bytes <= records.profile().limit,true);
  assertEquals((await records.read(7,100,9999,false)).length,0);
  assertEquals((await records.read(7,99,2491,false)).length,0);
  await assertRejects(() => records.read(6,100,2491,false));
  // Cross-block concurrent demands at a deliberately tiny cache limit.
  const again = await Promise.all([records.read(7,100,2491,true),records.read(7,102,2491,true),records.read(7,101,2491,true)]);
  assertEquals(again[0],block(100));
  assertEquals(again[1],block(102));
  assertEquals(again[2],block(100));
  assertEquals(records.profile().bytes <= records.profile().limit,true);
});

Deno.test('Abyss records reject wrong pins and malformed native blocks', async () => {
  const payload = (pin:string,bytes:Uint8Array) => ({manifest:{sourceRevision:'a'.repeat(40)},
    readVerifiedFile:(path:string) => Promise.resolve(path.endsWith('index.json')
      ? new TextEncoder().encode(JSON.stringify({pin,format:1,families:[{type:7,format:'ABYS',seedMinimum:100,seedMaximum:101,seedIncrement:1,bucketSize:2,sockets:[2491]}]})) : bytes)});
  await assertRejects(() => new AbyssRecords(payload('b'.repeat(40),block(100)) as never).read(7,100,2491,false));
  await assertRejects(() => new AbyssRecords(payload('a'.repeat(40),block(100).slice(0,-1)) as never).read(7,100,2491,false));
});

Deno.test('Zorath search accepts cluster IDs absent from native 16-bit lookup records', async () => {
  const bytes=new Uint8Array([65,66,89,78,1,11,100,0,101,0,1,0,1,0,42,0,
    1,2,3,1,7,0,1,2,3,1,8,0,65,83,67,83,1,0,3,70,111,111,1,42,0,1,42,0]);
  parseAbyssLookup(bytes);
  const payload={manifest:{sourceRevision:'a'.repeat(40)},readVerifiedFile:(path:string)=>Promise.resolve(path.endsWith('index.json')
    ? new TextEncoder().encode(JSON.stringify({pin:'a'.repeat(40),format:1,families:[{type:11,format:'ABYN',seedMinimum:100,seedMaximum:101,seedIncrement:1,bucketSize:2,sockets:[0]}]})):bytes)};
  const records=new AbyssRecords(payload as never,1000);
  const result=await records.read(11,100,0,true,JSON.stringify({nodes:[70000],ascendancy:'Absent'}));
  const lookup=parseAbyssLookup(result);
  assertEquals(lookup.format,'ABYN');
  if(lookup.format==='ABYN') {assertEquals(lookup.nodes.length,0);assertEquals(lookup.ascendancies.length,0);}
  await assertRejects(()=>records.read(11,100,0,true,JSON.stringify({nodes:[-1]})));
});
