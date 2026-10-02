import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createPackages } from "../../../packer/src/packages.ts";
import { loadPayload, PayloadFileSystem } from "../../src/js/payload.ts";

const gameVersions = {
  path: "GameVersions.lua",
  data: new TextEncoder().encode('treeVersionList = { "3_28", "3_29" }'),
};

function payloadEntries() {
  return [
    gameVersions,
    { path: "Launch.lua", data: new TextEncoder().encode("launch") },
    { path: "TreeData/3_29/tree.lua", data: new TextEncoder().encode("current") },
    { path: "TreeData/3_28/tree.lua", data: new TextEncoder().encode("old-tree") },
    { path: "TreeData/3_28/sprites.lua", data: new TextEncoder().encode("old-sprites") },
    { path: "Data/TimelessJewelData/LethalPride.zip", data: new TextEncoder().encode("timeless") },
  ];
}

Deno.test("lazy packages expose the complete namespace and coalesce first reads", async () => {
  const entries = payloadEntries();
  const { manifest, archives } = await createPackages(entries, "a".repeat(40), ["Assets/ascendants"]);
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    requests.push(url);
    return url.endsWith("manifest.json")
      ? Response.json(manifest)
      : new Response(archives.get(url.split("/").at(-1)!.slice(0, -4)));
  }) as typeof fetch;
  const payload = await loadPayload("/payload", fetcher);
  const fs = payload.filesystem;
  assertEquals(requests.length, 3, "Manifest, core and latest tree are the complete startup fetch set");
  assertEquals(requests.some((request) => request.includes(manifest.packages.find((p) => p.id === "tree-3_28")!.sha256)), false);

  for (const entry of entries) assertEquals((await fs.stat("/" + entry.path)).size, entry.data.length);
  assertEquals(await fs.readdir("/TreeData"), ["3_28", "3_29"]);
  assertEquals(await fs.readdir("/Assets"), ["ascendants"]);
  assertEquals(await fs.readdir("/Assets/ascendants"), []);
  assertEquals(requests.length, 3, "Metadata operations do not fetch lazy archives");

  const tree = new Uint8Array(8);
  const sprites = new Uint8Array(11);
  await Promise.all([
    fs.read("/TreeData/3_28/tree.lua", tree, 0, tree.length),
    fs.read("/TreeData/3_28/sprites.lua", sprites, 0, sprites.length),
  ]);
  assertEquals(new TextDecoder().decode(tree), "old-tree");
  assertEquals(new TextDecoder().decode(sprites), "old-sprites");
  assertEquals(requests.length, 4, "Concurrent reads share one package request");
  assertThrows(() => (fs as PayloadFileSystem).readSync("/TreeData/3_28/tree.lua", tree, 0, tree.length));
  await assertRejects(() => fs.write("/Launch.lua", new Uint8Array([1]), 0));
});

Deno.test("eager mode fetches every package before returning", async () => {
  const entries = payloadEntries();
  const { manifest, archives } = await createPackages(entries, "a".repeat(40));
  const requests: string[] = [];
  const payload = await loadPayload(
    "/payload",
    (async (url: string) => {
      requests.push(url);
      return url.endsWith("manifest.json")
        ? Response.json(manifest)
        : new Response(archives.get(url.split("/").at(-1)!.slice(0, -4)));
    }) as typeof fetch,
    { eager: true },
  );
  assertEquals(requests.length, manifest.packages.length + 1);
  for (const entry of entries) {
    const data = new Uint8Array(entry.data.length);
    await payload.filesystem.read("/" + entry.path, data, 0, data.length);
    assertEquals(data, entry.data);
  }
});

Deno.test("legacy is explicit or manifest-404 only; other failures cannot silently downgrade", async () => {
  const { manifest, archives } = await createPackages([
    gameVersions,
    { path: "TreeData/3_29/tree.lua", data: new Uint8Array([1]) },
    { path: "Launch.lua", data: new Uint8Array([42]) },
  ], "a".repeat(40));
  const archive = archives.get(manifest.packages.find((pkg) => pkg.id === "core")!.sha256)!;
  for (const explicit of [false, true]) {
    const requests: string[] = [];
    const payload = await loadPayload(
      "/payload",
      (async (url: string) => {
        requests.push(url);
        return url.endsWith("manifest.json") ? new Response(null, { status: 404 }) : new Response(archive);
      }) as typeof fetch,
      { legacy: explicit },
    );
    assertEquals(requests, explicit ? ["/payload/root.zip"] : ["/payload/manifest.json", "/payload/root.zip"]);
    const bytes = new Uint8Array(1);
    await payload.filesystem.read("/Launch.lua", bytes, 0, 1);
    assertEquals(bytes, new Uint8Array([42]));
    await assertRejects(() => payload.filesystem.write("/Launch.lua", bytes, 0));
  }
  const strictRequests: string[] = [];
  await assertRejects(
    () => loadPayload(
      "/payload",
      (async (url: string) => {
        strictRequests.push(url);
        return new Response(null, { status: 404 });
      }) as typeof fetch,
      { allowLegacyFallback: false },
    ),
    Error,
    "Desktop payload manifest unavailable",
  );
  assertEquals(strictRequests, ["/payload/manifest.json"]);
  assertEquals(archives.size > 0, true);
  for (const response of [new Response(null, { status: 503 }), Response.json({ schemaVersion: 99 })]) {
    const requests: string[] = [];
    await assertRejects(() =>
      loadPayload(
        "/payload",
        (async (url: string) => {
          requests.push(url);
          return response;
        }) as typeof fetch,
      )
    );
    assertEquals(requests, ["/payload/manifest.json"]);
  }
});

Deno.test("matching package hash cannot conceal missing or extra archive members", async () => {
  const { manifest, archives } = await createPackages([
    gameVersions,
    { path: "TreeData/3_29/tree.lua", data: new Uint8Array([1]) },
    { path: "Launch.lua", data: new Uint8Array([1]) },
    { path: "HeadlessWrapper.lua", data: new Uint8Array([2]) },
  ], "a".repeat(40));
  for (const variant of ["extra", "missing", "size"]) {
    const corrupt = structuredClone(manifest);
    const p = corrupt.packages.find((candidate) => candidate.id === "core")!;
    if (variant === "extra") {
      p.files.pop();
      p.uncompressedBytes--;
    }
    if (variant === "missing") {
      p.files.push({ path: "installed.cfg", bytes: 1 });
      p.uncompressedBytes++;
    }
    if (variant === "size") {
      p.files[0].bytes++;
      p.uncompressedBytes++;
    }
    await assertRejects(() =>
      loadPayload(
        "/payload",
        (async (url: string) =>
          url.endsWith("manifest.json")
            ? Response.json(corrupt)
            : new Response(archives.get(url.split("/").at(-1)!.slice(0, -4)))) as typeof fetch,
      )
    );
  }
});
