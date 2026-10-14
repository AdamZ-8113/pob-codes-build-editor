import { createRpcClient } from '../../../../upstream/packages/driver/src/js/rpc.ts';
import { createReadAheadRpc } from './read-ahead.mjs';

type ProfileModule = EmscriptenModule & { cwrap: typeof cwrap };
let module: ProfileModule | undefined;
let helperCall: ((text: string) => string) | undefined;
let transportProfile: (() => unknown) | undefined;
let lastError = '';

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'boot') {
      const initStarted = performance.now();
      const factory = (await import(/* @vite-ignore */ data.driverUrl)).default;
      const rpc = createReadAheadRpc(createRpcClient(data.port, true), { enabled: data.variant.includes('read-ahead'), chunkBytes: 262144, maxRetainedBytes: 4 * 1024 * 1024 });
      transportProfile = () => rpc.profile();
      module = await factory({
        print: () => {},
        printErr: (message: string) => { lastError = message; console.warn(message); },
        rpcCall: rpc,
        runtimeGCPause: data.gcPause,
        onError: (message: string) => { throw new Error(message); },
      }) as ProfileModule;
      const wasmInitMs = performance.now() - initStarted;
      const helperStarted = performance.now();
      if (!module || module.cwrap('init', 'number', [])() || module.cwrap('helper_boot', 'number', [])()) {
        throw new Error('Profile helper boot failed');
      }
      const helperBootMs = performance.now() - helperStarted;
      helperCall = module.cwrap('helper_call', 'string', ['string']);
      self.postMessage({ id: data.id, ok: true, value: { wasmInitMs, helperBootMs }, bytes: module.HEAPU8.buffer.byteLength });
      return;
    }
    if (!helperCall || !module) throw new Error('Profile helper not initialized');
    const started = performance.now();
    const text = helperCall(JSON.stringify(data.job));
    const jobRoundTripMs = performance.now() - started;
    if (!text) throw new Error(lastError || 'Profile helper calculation failed');
    const value: Record<string, unknown> = { ...JSON.parse(text), jobRoundTripMs };
    // Capture transport state on the first target result as well as the later
    // diagnostic. Bytecode acceptance needs the pre-diagnostic descriptor and
    // read-ahead-window balance; detach must not hide deferred cleanup.
    value.transportProfile = transportProfile?.();
    self.postMessage({ id: data.id, ok: true, value, bytes: module.HEAPU8.buffer.byteLength });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
