import { createRpcClient } from './rpc.ts';

let module: (EmscriptenModule & { cwrap: typeof cwrap }) | undefined;
let call: ((text: string) => string) | undefined;
let lastError = '';
// One instance, one job at a time. Parent owns timeout and termination.
self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'boot') {
      const factory = (await import('../../dist/release/driver.mjs')).default;
      module = await factory({ print: () => {}, printErr: (message: string) => { lastError = message; console.warn(message); }, rpcCall: createRpcClient(data.port, true),
        runtimeGCPause: data.gcPause ?? 400,
        onError: (message: string) => { throw new Error(message); } });
      if (!module || module.cwrap('init', 'number', [])() || module.cwrap('helper_boot', 'number', [])()) throw new Error('Helper boot failed');
      call = module.cwrap('helper_call', 'string', ['string']);
      self.postMessage({ id: data.id, ok: true, value: { ready: true }, bytes: module.HEAPU8.buffer.byteLength });
    } else {
      if (!call || !module) throw new Error('Helper not initialized');
      const result = call(JSON.stringify(data.job));
      if (!result) throw new Error(lastError || 'Helper calculation failed');
      self.postMessage({ id: data.id, ok: true, value: JSON.parse(result), bytes: module.HEAPU8.buffer.byteLength });
    }
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
