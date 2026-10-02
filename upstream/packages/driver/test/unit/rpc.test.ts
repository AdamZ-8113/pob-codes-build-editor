import { assertEquals, assertThrows } from "@std/assert";
import { environmentErrorCategory, markEnvironmentError } from "../../src/js/error.ts";
import { createRpcClient, prepareFetchHeaders, restoreRpcError, rpcErrorMetadata } from "../../src/js/rpc.ts";

Deno.test('helper RPC reuses transport storage without changing previously returned bytes', () => {
  const buffers: SharedArrayBuffer[] = [];
  let value = 0;
  const port = { postMessage(request: {shared: SharedArrayBuffer}) {
    buffers.push(request.shared);
    const control = new Int32Array(request.shared,0,4);
    assertEquals([...control], [0,0,0,0]);
    const metadata = new TextEncoder().encode(JSON.stringify({value:++value}));
    const bytes = new Uint8Array(request.shared,16);
    bytes.set(metadata); bytes.set([value], metadata.length);
    Atomics.store(control,1,metadata.length); Atomics.store(control,2,1); Atomics.store(control,0,1);
  }} as MessagePort;
  const call = createRpcClient(port, true);
  const first = call('read'); const second = call('read');
  assertEquals(buffers[0] === buffers[1], true);
  assertEquals(first.data, new Uint8Array([1])); assertEquals(second.data, new Uint8Array([2]));
  call('read', [], undefined, 2 * 2 ** 20);
  assertEquals(buffers[1] === buffers[2], false);
  call('read'); assertEquals(buffers[2] === buffers[3], true);
});

Deno.test("fetch headers reject POESESSID without forwarding it", () => {
  assertThrows(() => prepareFetchHeaders({ cookie: "poesessid=secret" }), Error, "POESESSID");
  assertThrows(() => prepareFetchHeaders({ PoEsEsSiD: "secret" }), Error, "POESESSID");
});

Deno.test("fetch headers preserve content type or supply the legacy default", () => {
  assertEquals(prepareFetchHeaders({ Accept: "application/json" }), {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
  assertEquals(prepareFetchHeaders({ "content-type": "application/json" }), {
    "content-type": "application/json",
  });
  assertEquals(prepareFetchHeaders({ "User-Agent": "Path of Building/0.23.1" }), {
    "User-Agent": "Path of Building/0.23.1",
    "Content-Type": "application/x-www-form-urlencoded",
  });
});

Deno.test("environment error categories survive RPC error serialization", () => {
  const original = markEnvironmentError(new Error("OPFS initialization failed"), "storage");

  const restored = restoreRpcError(rpcErrorMetadata(original), "RPC failed");

  assertEquals(restored.message, original.message);
  assertEquals(environmentErrorCategory(restored), "storage");
});
