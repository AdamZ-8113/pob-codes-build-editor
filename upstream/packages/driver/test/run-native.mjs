import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Emscripten 6 emits an ES-module factory for .mjs executables. Merely loading
// the file with `node file.mjs` does not instantiate Wasm or run C main().
for (const file of process.argv.slice(2)) {
  const { default: createModule } = await import(pathToFileURL(resolve(file)).href);
  await createModule();
  if (process.exitCode) throw new Error(`Native test failed: ${file}`);
  console.log(`Native test passed: ${file}`);
}
