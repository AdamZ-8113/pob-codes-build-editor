import * as Comlink from 'comlink';
import BrokerWorker from '../../../../upstream/packages/driver/src/js/broker.ts?worker';
import ProfileWorker from './profile-worker.ts?worker';

type Broker = {
  start: (...args: unknown[]) => Promise<void>;
  attachHelper: (id: number, port: MessagePort) => Promise<void>;
  detachHelper: (id: number) => Promise<void>;
  getFilesystemProfile: () => Promise<unknown>;
};

const query = new URLSearchParams(location.search);
const fixture = query.get('fixture');
const driverUrl = query.get('driver');
const variant = query.get('variant') || 'baseline';
if (!fixture || !driverUrl) throw new Error('Missing profile fixture or driver URL');

let sequence = 0;
const startedAt = performance.now();
const phases: Record<string, number> = { bootstrapStartedAtMs: startedAt };
const brokerWorker = new BrokerWorker();
const broker = Comlink.wrap<Broker>(brokerWorker);
const helper = new ProfileWorker();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

brokerWorker.onerror = event => {
  const detail = JSON.stringify({ message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno,
    error: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error) });
  window.__COMPILED_CALCS_PROFILE__ = { ...window.__COMPILED_CALCS_PROFILE__!, done: true, error: `Broker worker error: ${detail}` };
};
brokerWorker.onmessageerror = () => {
  window.__COMPILED_CALCS_PROFILE__ = { ...window.__COMPILED_CALCS_PROFILE__!, done: true, error: 'Broker worker message error' };
};

helper.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.ok) request.resolve({ ...data.value, wasmBytes: data.bytes });
  else request.reject(new Error(data.error || 'Invalid profile helper response'));
};
helper.onerror = event => {
  for (const request of pending.values()) request.reject(new Error(event.message));
  pending.clear();
};

function send(data: Record<string, unknown>, transfer: Transferable[] = []) {
  return new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    helper.postMessage({ ...data, id }, transfer);
  });
}

async function run() {
  window.__COMPILED_CALCS_PROFILE__!.progress = 'starting-filesystem';
  const filesystemChannel = new MessageChannel();
  const eventChannel = new MessageChannel();
  const filesystemStarted = performance.now();
  const filesystemReady = broker.start(
    Comlink.transfer(filesystemChannel.port1, [filesystemChannel.port1]),
    Comlink.transfer(eventChannel.port1, [eventChannel.port1]),
    '/payload',
    {
      legacyPayload: false,
      allowLegacyPayloadFallback: false,
      eagerPayload: false,
      userDirectory: `Compiled Calcs PoC ${crypto.randomUUID()}`,
      settingsRootElement: 'PathOfBuilding',
      cloudflareKvPrefix: '',
      cloudflareKvAccessToken: undefined,
      cloudflareKvUserNamespace: undefined,
    },
    Comlink.proxy(async () => { throw new Error('External fetch disabled in compiled-calcs profile'); }),
    Comlink.proxy(async () => { throw new Error('OAuth disabled in compiled-calcs profile'); }),
    Comlink.proxy(async () => { throw new Error('Clipboard disabled in compiled-calcs profile'); }),
    Comlink.proxy(() => {}),
    Comlink.proxy((message: string) => { throw new Error(message); }),
  );
  await filesystemReady;
  window.__COMPILED_CALCS_PROFILE__!.progress = 'filesystem-ready';
  phases.filesystemReadyMs = performance.now() - filesystemStarted;

  const helperChannel = new MessageChannel();
  await broker.attachHelper(1, Comlink.transfer(helperChannel.port1, [helperChannel.port1]));
  window.__COMPILED_CALCS_PROFILE__!.progress = 'helper-attached';
  const boot = await send({ kind: 'boot', port: helperChannel.port2, driverUrl, gcPause: 400, variant }, [helperChannel.port2]);
  window.__COMPILED_CALCS_PROFILE__!.progress = 'helper-booted';
  phases.wasmInitMs = boot.wasmInitMs;
  phases.helperBootMs = boot.helperBootMs;

  const xml = await (await fetch(`/tools/experiments/compiled-calcs/expanded/fixture/${encodeURIComponent(fixture)}`)).text();
  window.__COMPILED_CALCS_PROFILE__!.progress = 'fixture-loaded';
  const calculationOnly = variant.includes('calc-only');
  const comparisonSnapshot = variant.startsWith('comparison');
  const firstResult = await send({ job: { kind: comparisonSnapshot ? 'comparison' : calculationOnly ? 'compiled-calcs-expanded-calc-only' : 'compiled-calcs-expanded', identity: fixture, xml } });
  phases.headlessEngineColdFirstResultMs = performance.now();
  const publicState = window.__COMPILED_CALCS_PROFILE__!;
  publicState.firstResult = { variant, phases: { ...phases }, ...firstResult };
  publicState.firstResultReady = true;
  const diagnostic = await send({ job: { kind: 'compiled-calcs-expanded-report', identity: fixture, includeOutput: true } });
  const filesystem = await broker.getFilesystemProfile();
  await broker.detachHelper(1);
  helper.terminate();
  brokerWorker.terminate();
  return { variant, phases, filesystem, ...firstResult, profile: diagnostic.profile, bootProfile: diagnostic.bootProfile,
    firstResultTransportProfile: firstResult.transportProfile,
    transportProfile: diagnostic.transportProfile, diagnosticRoundTripMs: diagnostic.jobRoundTripMs };
}

declare global { interface Window { __COMPILED_CALCS_PROFILE__?: { done: boolean; firstResultReady: boolean; progress?: string; firstResult?: unknown; result?: unknown; error?: string } } }
window.__COMPILED_CALCS_PROFILE__ = { done: false, firstResultReady: false, progress: 'module-loaded' };
run().then(result => { window.__COMPILED_CALCS_PROFILE__ = { ...window.__COMPILED_CALCS_PROFILE__!, done: true, result }; }, error => {
  window.__COMPILED_CALCS_PROFILE__ = { ...window.__COMPILED_CALCS_PROFILE__!, done: true, error: error instanceof Error ? error.stack ?? error.message : String(error) };
});
