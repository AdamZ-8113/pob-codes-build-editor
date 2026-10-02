export type UniqueJob = { identity: string; xml: string; sortMode: string; weaponSet: boolean;
  items: { key: string; raw: string }[]; uiBytes: number };

type Member = { id: number; worker: Worker; bytes: number; identity?: string;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> };
export const HELPER_MEMORY = { hardBytes: 6 * 2 ** 30, admissionBytes: 5.5 * 2 ** 30,
  uiMaximum: 2 * 2 ** 30, helperMaximum: .65 * 2 ** 30, maximumCount: 3 };
const GiB = 2 ** 30;

export class HelperPool {
  private members: Member[] = [];
  private sequence = 0;
  private generation = 0;
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
  constructor(private createWorker: () => Worker,
    private attach: (id: number, port: MessagePort) => Promise<void>,
    private detach: (id: number) => Promise<void>,
    private availability: (ready: boolean) => void = () => {},
    private timeoutMs = 15000, private gcPause = 400) {}
  profile() { return { requested: this.requested, ready: this.members.filter(m => m.bytes).length,
    state: this.closed ? 'closed' : this.starting ? 'booting' : this.members.length ? 'ready'
      : this.armed ? 'armed' : this.requested ? 'retired' : 'disabled',
    armed: this.armed, booting: this.starting, starts: this.starts,
    startupMs: this.starting && this.bootStartedAt !== undefined
      ? performance.now() - this.bootStartedAt : this.startupMs,
    bytes: this.members.map(m => m.bytes), errors: this.errors.slice(-5), completed: this.completed,
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
    this.starts++;
    this.bootStartedAt = performance.now();
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
    } catch (error) { this.errors.push(String(error)); this.retire(); }
    finally {
      this.startupMs = performance.now() - this.bootStartedAt;
      this.bootStartedAt = undefined;
      this.starting = false;
    }
  }
  private send(member: Member, data: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { member.pending.delete(id); reject(new Error('Helper timeout')); }, this.timeoutMs);
      member.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      try { member.worker.postMessage({ ...data, id }, transfer); }
      catch (error) { member.pending.get(id)?.reject(error as Error); member.pending.delete(id); }
    });
  }
  private admitted(uiBytes: number) {
    // Calibrated against Windows process-tree private commit, not just Wasm.
    // Conservative admission model, not an OS process-memory limiter.
    return Number.isSafeInteger(uiBytes) && uiBytes > 0 && uiBytes <= HELPER_MEMORY.uiMaximum &&
      this.members.every(m => m.bytes <= HELPER_MEMORY.helperMaximum) &&
      1.75 * GiB + uiBytes + this.members.reduce((s,m) => s + Math.max(m.bytes + .125 * GiB, .5 * GiB), 0)
        <= HELPER_MEMORY.admissionBytes;
  }
  cancel() { this.generation++; }
  run(job: UniqueJob): Promise<unknown[] | null> {
    const generation = ++this.generation;
    const run = async () => {
      if (this.closed || generation !== this.generation || this.starting || (!this.members.length && !this.armed)) return null;
      if (!this.admitted(job.uiBytes)) { this.retire(); return null; }
      if (!this.members.length) await this.start();
      if (this.closed || generation !== this.generation || this.starting || !this.members.length) return null;
      if (!this.admitted(job.uiBytes)) { this.retire(); return null; }
      try {
        await Promise.all(this.members.map(async member => {
          if (member.identity !== job.identity) {
            await this.send(member, { job: { identity: job.identity, xml: job.xml } });
            member.identity = job.identity;
          }
        }));
        if (generation !== this.generation) return null;
        const values: unknown[] = Array(job.items.length);
        let cursor = 0;
        await Promise.all(this.members.map(async member => {
          let first = true;
          while (cursor < job.items.length && generation === this.generation) {
            if (!this.admitted(job.uiBytes)) throw new Error('Helper memory reserve exhausted');
            const offset = cursor; cursor += first || member.bytes > .4 * GiB ? 25 : 100;
            first = false;
            const items = job.items.slice(offset, cursor);
            const results = await this.send(member, { job: { identity: job.identity, operation: generation,
              sortMode: job.sortMode, weaponSet: job.weaponSet, items } }) as unknown[];
            if (generation !== this.generation) return;
            if (!Array.isArray(results) || results.length !== items.length || results.some(v => v !== '-inf' &&
                (typeof v !== 'string' || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) || !Number.isFinite(Number(v))))) throw new Error('Invalid helper result');
            results.forEach((value, index) => values[offset + index] = value);
            this.completed += results.length;
          }
        }));
        if (!this.admitted(job.uiBytes)) throw new Error('Helper memory reserve exhausted');
        return generation === this.generation ? values : null;
      } catch (error) {
        this.errors.push(String(error)); this.retire(); return null;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result; return result;
  }
  private retire() {
    this.generation++;
    this.armed = false;
    if (this.members.length) this.recycled++;
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
