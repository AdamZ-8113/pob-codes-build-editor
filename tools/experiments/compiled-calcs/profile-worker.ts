import { createRpcClient } from '../../../upstream/packages/driver/src/js/rpc.ts';

type ProfileModule = EmscriptenModule & { cwrap: typeof cwrap };
let module: ProfileModule | undefined;
let helperCall: ((text: string) => string) | undefined;
let lastError = '';

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'boot') {
      const initStarted = performance.now();
      const factory = (await import(/* @vite-ignore */ data.driverUrl)).default;
      module = await factory({
        print: () => {},
        printErr: (message: string) => { lastError = message; console.warn(message); },
        rpcCall: createRpcClient(data.port, true),
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
    self.postMessage({ id: data.id, ok: true, value: { ...JSON.parse(text), jobRoundTripMs }, bytes: module.HEAPU8.buffer.byteLength });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
