import * as Comlink from 'comlink';
import BrokerWorker from '../../../upstream/packages/driver/src/js/broker.ts?worker';
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
const instrumentCandidates = query.get('instrument') === '1';
if (!fixture || !driverUrl) throw new Error('Missing profile fixture or driver URL');

let sequence = 0;
const startedAt = performance.now();
const phases: Record<string, number> = { bootstrapStartedAtMs: startedAt };
const brokerWorker = new BrokerWorker();
const broker = Comlink.wrap<Broker>(brokerWorker);
const helper = new ProfileWorker();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

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
  phases.filesystemReadyMs = performance.now() - filesystemStarted;

  const helperChannel = new MessageChannel();
  await broker.attachHelper(1, Comlink.transfer(helperChannel.port1, [helperChannel.port1]));
  const boot = await send({ kind: 'boot', port: helperChannel.port2, driverUrl, gcPause: 400 }, [helperChannel.port2]);
  phases.wasmInitMs = boot.wasmInitMs;
  phases.helperBootMs = boot.helperBootMs;

  const xml = await (await fetch(`/tools/experiments/compiled-calcs/fixture/${encodeURIComponent(fixture)}`)).text();
  const firstResult = await send({ job: { kind: 'compiled-calcs-profile', identity: fixture, xml, instrumentCandidates } });
  phases.headlessEngineColdFirstResultMs = performance.now();
  const diagnostic = await send({ job: { kind: 'compiled-calcs-profile-report', identity: fixture } });
  const filesystem = await broker.getFilesystemProfile();
  await broker.detachHelper(1);
  helper.terminate();
  brokerWorker.terminate();
  return { phases, filesystem, ...firstResult, runtimeProfile: diagnostic.runtimeProfile,
    coarseProfile: diagnostic.coarseProfile, diagnosticRoundTripMs: diagnostic.jobRoundTripMs };
}

declare global { interface Window { __COMPILED_CALCS_PROFILE__?: { done: boolean; result?: unknown; error?: string } } }
window.__COMPILED_CALCS_PROFILE__ = { done: false };
run().then(result => { window.__COMPILED_CALCS_PROFILE__ = { done: true, result }; }, error => {
  window.__COMPILED_CALCS_PROFILE__ = { done: true, error: error instanceof Error ? error.stack ?? error.message : String(error) };
});
