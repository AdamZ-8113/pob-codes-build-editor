import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The Docker image follows the Emscripten version pinned by pob-web. It contains
// CMake and Make as well, so no machine-wide compiler installation is needed.
const image = 'emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef';
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = path.join(appDirectory, 'upstream');
const buildType = process.argv.includes('--debug') ? 'Debug' : 'Release';
const test = process.argv.includes('--test');
const compactValues = process.argv.find(arg => arg.startsWith('--compact-values='))?.slice('--compact-values='.length) ?? 'on';
if (!['on', 'off'].includes(compactValues)) throw new Error('Compact values must be on or off');
const jobs = process.env.POB_DESKTOP_BUILD_JOBS || '4';
if (!/^\d+$/.test(jobs) || Number(jobs) < 1 || Number(jobs) > 32) {
  throw new Error('POB_DESKTOP_BUILD_JOBS must be an integer from 1 to 32');
}
mkdirSync(path.join(sourceDirectory, 'packages/driver/build'), { recursive: true });

function run(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error('Docker Desktop is required for the desktop PoB compiler. Start Docker and retry.', { cause: result.error });
  if (result.status !== 0) process.exit(result.status || 1);
}

run(['run', '--rm', '--mount', `type=bind,source=${sourceDirectory},target=/source`,
  '--workdir', '/source/packages/driver', image, 'bash', '-lc',
  `emcmake cmake --fresh -G 'Unix Makefiles' -B build/${buildType.toLowerCase()} -S . -DCMAKE_BUILD_TYPE=${buildType} -DPOB_COMPACT_VALUES=${compactValues.toUpperCase()} && EMCC_FORCE_STDLIBS=libc cmake --build build/${buildType.toLowerCase()} --target driver${test ? ' driver_bridge_test driver_lua_syntax_test driver_tooltip_cache_test driver_fs_integration_test' : ''} -j ${jobs}${test ? ` && node test/run-native.mjs build/${buildType.toLowerCase()}/driver_bridge_test.mjs build/${buildType.toLowerCase()}/driver_lua_syntax_test.mjs build/${buildType.toLowerCase()}/driver_tooltip_cache_test.mjs` : ''}`]);

console.log(`Desktop PoB ${buildType} interpreter built in upstream/packages/driver/dist/${buildType.toLowerCase()}.`);
console.log('PoB Lua source and PR changes are packaged separately; repack them without recompiling this interpreter.');
