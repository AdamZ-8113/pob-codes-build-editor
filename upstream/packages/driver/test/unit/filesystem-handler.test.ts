import { assertEquals } from "@std/assert";
import { configure, fs, InMemory } from "@zenfs/core";
import { FilesystemRpcHandler } from "../../src/js/filesystem-handler.ts";

Deno.test("cloud mount stats are always writable for WasmFS", async () => {
  await configure({ mounts: { "/": InMemory } });
  const cloudDirectory = "/user/Path of Building/Builds/Cloud";
  await fs.promises.mkdir(cloudDirectory, { recursive: true, mode: 0 });
  await fs.promises.writeFile(`${cloudDirectory}/build.xml`, "build", { mode: 0 });

  const handler = new FilesystemRpcHandler();
  handler.reset(cloudDirectory);

  const directory = await handler.handle("lstat", [cloudDirectory]);
  const file = await handler.handle("stat", [`${cloudDirectory}/build.xml`]);
  assertEquals((directory.value as { mode: number }).mode & 0o777, 0o777);
  assertEquals((file.value as { mode: number }).mode & 0o777, 0o777);
});

Deno.test("manifest-owned root opens await the payload gate while metadata stays non-fetching", async () => {
  await configure({ mounts: { "/": InMemory } });
  await fs.promises.mkdir("/root/TreeData/3_28", { recursive: true });
  await fs.promises.writeFile("/root/TreeData/3_28/tree.lua", "tree");
  const events: string[] = [];
  const handler = new FilesystemRpcHandler();
  handler.reset();
  handler.setPayloadGate({
    packageIdForPath: (path) => path.endsWith("tree.lua") ? "tree-3_28" : undefined,
    ensurePath: async (path) => { events.push(path); },
  });
  await handler.handle("stat", ["/root/TreeData/3_28/tree.lua"]);
  await handler.handle("readdir", ["/root/TreeData/3_28"]);
  assertEquals(events, []);
  const opened = await handler.handle("open", ["/root/TreeData/3_28/tree.lua", "r"]);
  assertEquals(events, ["/root/TreeData/3_28/tree.lua"]);
  await handler.handle("close", [opened.value]);
});

