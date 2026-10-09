import { isTooltipOperations, type ItemComparisonJob, type TooltipOperation } from './item-comparison.ts';

export type UniqueJob = { identity: string; xml: string; sortMode: string; weaponSet: boolean;
  items: { key: string; raw: string }[]; uiBytes: number };
export type NodePowerItem = { addNodes?: { id?: number; effect?: number; cluster?: string }[];
  removeNodes?: { id?: number; effect?: number; cluster?: string }[] };
export type NodePowerJob = { kind: 'nodePower'; identity: string; xml: string; metric: string;
  items: NodePowerItem[]; uiBytes: number };
export type HelperJob = UniqueJob | NodePowerJob;
export type HelperDiagnostic = (event: string, data?: Record<string, unknown>, level?: 'info' | 'error') => void;

const numberText = (v: unknown) => typeof v === 'string' &&
  /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) && Number.isFinite(Number(v));
const nodePowerResult = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length > 0 && Object.entries(v).every(([key, value]) =>
    ['singleStat', 'offence', 'defence'].includes(key) && numberText(value));

type Member = { id: number; worker: Worker; bytes: number; identity?: string;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> };
export const HELPER_MEMORY = { hardBytes: 6 * 2 ** 30, admissionBytes: 5.5 * 2 ** 30,
  uiMaximum: 2 * 2 ** 30, helperMaximum: 2 ** 30, maximumCount: 3 };
const GiB = 2 ** 30;

export class HelperPool {
  private members: Member[] = [];
  private sequence = 0;
  private generation = 0;
  private comparisonGeneration = 0;
  private startupFinished: Promise<void> = Promise.resolve();
  private closed = false;
  private starting = false;
  private armed = false;
  private starts = 0;
  private startupMs = 0;
  private bootStartedAt: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private errors: string[] = [];
  private completed = 0;
  private requested = 0;
  private recycled = 0;
  private lastRetiredBytes: number[] = [];
  constructor(private createWorker: () => Worker,
    private attach: (id: number, port: MessagePort) => Promise<void>,
    private detach: (id: number) => Promise<void>,
    private availability: (ready: boolean) => void = () => {},
    private timeoutMs = 15000, private gcPause = 400,
    private onDiagnostic: HelperDiagnostic = () => {},
    private setPurpose: (id: number, purpose: 'demand' | 'comparison') => Promise<void> = async () => {}) {}
  profile() { return { requested: this.requested, ready: this.members.filter(m => m.bytes).length,
    state: this.closed ? 'closed' : this.starting ? 'booting' : this.members.length ? 'ready'
      : this.armed ? 'armed' : this.requested ? 'retired' : 'disabled',
    armed: this.armed, booting: this.starting, starts: this.starts,
    startupMs: this.starting && this.bootStartedAt !== undefined
      ? performance.now() - this.bootStartedAt : this.startupMs,
    bytes: this.members.map(m => m.bytes), lastRetiredBytes: this.lastRetiredBytes.slice(),
    errors: this.errors.slice(-5), completed: this.completed,
    recycled: this.recycled, gcPause: this.gcPause, memory: HELPER_MEMORY }; }
  // Declare eligible capacity without allocating interpreters. Lua may then
  // delegate the first actual sort request, which boots this pool on demand.
  prepare(count = this.requested) {
    if (this.closed || !Number.isInteger(count) || count < 1) return 0;
    this.requested = Math.min(count, HELPER_MEMORY.maximumCount);
    this.armed = true;
    return this.requested;
  }
  async start(count = this.requested) {
    if (this.closed || this.starting || this.members.length || !Number.isInteger(count) || count < 1) return;
    this.prepare(count);
    this.starting = true;
    let finishStartup!: () => void;
    this.startupFinished = new Promise(resolve => { finishStartup = resolve; });
    this.starts++;
    this.bootStartedAt = performance.now();
    this.onDiagnostic('helpers-starting', {count: this.requested});
    try {
      for (let i = 0; i < this.requested && !this.closed; i++) {
        const worker = this.createWorker();
        const member: Member = { id: ++this.sequence, worker, bytes: 0, pending: new Map() };
        this.members.push(member);
        worker.onmessage = ({data}) => {
          const pending = member.pending.get(data.id);
          if (!pending) return;
          member.pending.delete(data.id);
          if (data.ok && Number.isSafeInteger(data.bytes) && data.bytes > 0) {
            member.bytes = data.bytes; pending.resolve(data.value);
          } else pending.reject(new Error(data.error || 'Invalid helper memory report'));
        };
        worker.onerror = event => {
          for (const p of member.pending.values()) p.reject(new Error(event.message));
          member.pending.clear();
          this.retire();
        };
        const channel = new MessageChannel();
        try {
          await this.attach(member.id, channel.port1);
          if (this.closed) { channel.port2.close(); await this.detach(member.id); return; }
          await this.send(member, { kind: 'boot', port: channel.port2, gcPause: this.gcPause }, [channel.port2]);
        } catch (error) { channel.port1.close(); channel.port2.close(); throw error; }
        if (this.closed) return;
      }
      this.availability(this.members.length === this.requested);
      this.onDiagnostic('helpers-ready', {count: this.members.length});
    } catch (error) {
      this.errors.push(String(error));
      this.reportFallback('startup', error);
      this.retire();
    }
    finally {
      this.startupMs = performance.now() - this.bootStartedAt;
      this.bootStartedAt = undefined;
      this.starting = false;
      finishStartup();
    }
  }
  private send(member: Member, data: Record<string, unknown>, transfer: Transferable[] = [], timeout = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { member.pending.delete(id); reject(new Error('Helper timeout')); }, timeout);
      member.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      try { member.worker.postMessage({ ...data, id }, transfer); }
      catch (error) { member.pending.get(id)?.reject(error as Error); member.pending.delete(id); }
    });
  }
  private admitted(uiBytes: number) {
    return this.admissionFailure(uiBytes) === undefined;
  }
  private admissionFailure(uiBytes: number): 'ui-memory' | 'helper-memory' | 'aggregate-memory' | 'invalid-memory' | undefined {
    // Calibrated against Windows process-tree private commit, not just Wasm.
    // Conservative admission model, not an OS process-memory limiter.
    if (!Number.isSafeInteger(uiBytes) || uiBytes <= 0) return 'invalid-memory';
    if (uiBytes > HELPER_MEMORY.uiMaximum) return 'ui-memory';
    if (this.members.some(member => member.bytes > HELPER_MEMORY.helperMaximum)) return 'helper-memory';
    if (1.75 * GiB + uiBytes + this.members.reduce((sum, member) =>
        sum + Math.max(member.bytes + .125 * GiB, .5 * GiB), 0) > HELPER_MEMORY.admissionBytes) {
      return 'aggregate-memory';
    }
    return undefined;
  }
  private reportFallback(reason: string, error?: unknown) {
    this.onDiagnostic('helpers-fallback', {
      reason,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
      helperMaximumBytes: HELPER_MEMORY.helperMaximum,
      uiMaximumBytes: HELPER_MEMORY.uiMaximum,
      helperBytes: this.members.map(member => member.bytes),
    });
  }
  cancel() { this.generation++; }
  cancelComparison() { this.comparisonGeneration++; }
  failMember(id: number) {
    if (this.members.some(member => member.id === id)) this.retire();
  }
  runComparison(job: ItemComparisonJob): Promise<TooltipOperation[] | null> {
    const generation = ++this.comparisonGeneration;
    const run = async () => {
      await this.startupFinished;
      if (this.closed || generation !== this.comparisonGeneration) return null;
      if (this.admissionFailure(job.uiBytes)) return null;
      // Reuse one admitted member, including on devices where parallel sorting
      // is disabled. Never allocate a fourth interpreter for hover work.
      if (!this.members.length) await this.start(1);
      if (this.closed || generation !== this.comparisonGeneration || !this.members.length) return null;
      if (this.admissionFailure(job.uiBytes)) { this.retire(); return null; }
      const member = this.members[0];
      try {
        await this.setPurpose(member.id, 'comparison');
        const identity = `comparison:${job.identity}`;
        if (member.identity !== identity) {
          await this.send(member, {job: {kind: 'comparison', identity: job.identity, xml: job.xml}}, [], 120_000);
          member.identity = identity;
        }
        if (generation !== this.comparisonGeneration) return null;
        const result = await this.send(member, {job: {kind: 'comparison', identity: job.identity,
          item: job.item, slot: job.slot, options: job.options}}, [], 120_000);
        if (generation !== this.comparisonGeneration) return null;
        if (!isTooltipOperations(result)) throw new Error('Invalid item comparison result');
        // A validated result remains usable after retiring its interpreter.
        // Release large retained jewel tables before admitting another job.
        if (this.admissionFailure(job.uiBytes)) this.retire();
        return result;
      } catch {
        // Never fall back to a blocking comparison on the UI worker.
        this.retire();
        return null;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result;
    return result;
  }
  run(job: HelperJob, onProgress: (completed: number) => void = () => {}): Promise<unknown[] | null> {
    const nodePower = 'kind' in job && job.kind === 'nodePower';
    const identity = `${nodePower ? 'nodePower' : 'unique'}:${job.identity}`;
    const generation = ++this.generation;
    const run = async () => {
      if (this.closed || generation !== this.generation || this.starting || (!this.members.length && !this.armed)) return null;
      const initialFailure = this.admissionFailure(job.uiBytes);
      if (initialFailure) { this.reportFallback(initialFailure); this.retire(); return null; }
      if (!this.members.length) await this.start();
      if (this.closed || generation !== this.generation || this.starting || !this.members.length) return null;
      const bootFailure = this.admissionFailure(job.uiBytes);
      if (bootFailure) { this.reportFallback(bootFailure); this.retire(); return null; }
      try {
        await Promise.all(this.members.map(async member => {
          await this.setPurpose(member.id, 'demand');
          if (member.identity !== identity) {
            await this.send(member, { job: { identity: job.identity, xml: job.xml, ...(nodePower ? {kind: 'nodePower'} : {}) } });
            member.identity = identity;
          }
        }));
        if (generation !== this.generation) return null;
        const values: unknown[] = Array(job.items.length);
        let cursor = 0, completed = 0;
        await Promise.all(this.members.map(async member => {
          let first = true;
          while (cursor < job.items.length && generation === this.generation) {
            if (!this.admitted(job.uiBytes)) throw new Error('Helper memory reserve exhausted');
            const offset = cursor; cursor += first || member.bytes > .4 * GiB ? 25 : 100;
            first = false;
            const items = job.items.slice(offset, cursor);
            const details = 'kind' in job ? {kind: job.kind, metric: job.metric}
              : {sortMode: job.sortMode, weaponSet: job.weaponSet};
            const results = await this.send(member, { job: { identity: job.identity, operation: generation,
              ...details, items } }) as unknown[];
            if (generation !== this.generation) return;
            if (!Array.isArray(results) || results.length !== items.length || results.some(v =>
                nodePower ? !nodePowerResult(v) : v !== '-inf' && !numberText(v))) throw new Error('Invalid helper result');
            results.forEach((value, index) => values[offset + index] = value);
            this.completed += results.length;
            completed += results.length;
            onProgress(completed);
          }
        }));
        if (!this.admitted(job.uiBytes)) throw new Error('Helper memory reserve exhausted');
        return generation === this.generation ? values : null;
      } catch (error) {
        this.errors.push(String(error));
        this.reportFallback(this.admissionFailure(job.uiBytes) ?? 'worker-error', error);
        this.retire();
        return null;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result; return result;
  }
  private retire() {
    this.generation++;
    this.comparisonGeneration++;
    this.armed = false;
    if (this.members.length) {
      this.recycled++;
      this.lastRetiredBytes = this.members.map(member => member.bytes);
    }
    this.availability(false);
    for (const member of this.members) {
      member.worker.terminate();
      for (const pending of member.pending.values()) pending.reject(new Error('Helper stopped'));
      member.pending.clear(); void this.detach(member.id).catch(() => {});
    }
    this.members = [];
  }
  close() { this.closed = true; this.retire(); }
}
