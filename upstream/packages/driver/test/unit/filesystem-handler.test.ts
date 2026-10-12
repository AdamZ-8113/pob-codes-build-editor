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

Deno.test("only mutating local-user operations require the shared import lock", async () => {
  await configure({ mounts: { "/": InMemory } });
  await fs.promises.mkdir("/user/Path of Building/Builds/Cloud", { recursive: true });
  await fs.promises.writeFile("/user/local.xml", "local");
  const handler = new FilesystemRpcHandler();
  handler.reset("/user/Path of Building/Builds/Cloud");
  assertEquals(handler.requiresLocalWriteLock("open", ["/user/local.xml", "r"]), false);
  assertEquals(handler.requiresLocalWriteLock("open", ["/user/local.xml", "w+"]), true);
  assertEquals(handler.requiresLocalWriteLock("mkdir", ["/root/not-user"]), false);
  assertEquals(handler.requiresLocalWriteLock("mkdir", ["/user/local"]), true);
  assertEquals(handler.requiresLocalWriteLock("unlink", ["/user/Path of Building/Builds/Cloud/build.xml"]), false);
  assertEquals(handler.requiresLocalWriteLock("rename", ["/user/a", "/user/b"]), true);
  assertEquals(handler.requiresLocalWriteLock("rename", ["/user/a", "/root/b"]), true);
  assertEquals(handler.requiresLocalWriteLock("rename", ["/user/Path of Building/Builds/Cloud/a", "/root/b"]), false);
  const opened = await handler.handle("open", ["/user/local.xml", "r+"]);
  assertEquals(handler.requiresLocalWriteLock("write", [opened.value, 0]), true);
  assertEquals(handler.requiresLocalWriteLock("ftruncate", [opened.value, 0]), true);
  await handler.handle("close", [opened.value]);
});

