import { parseAbyssLookup, buildAbyssMiniatureLookup, encodeAbyssLookupSlice } from '../../../../abyss-lookup-format.js';
import { PayloadLoadError, type PayloadController } from './payload.ts';

type Metadata = { type: number; format: string; seedMinimum: number; seedMaximum: number; seedIncrement: number; bucketSize: number; sockets: number[] };
type Index = { pin: string; format: number; families: Metadata[] };
type Lookup = ReturnType<typeof parseAbyssLookup>;
type Entry = {lookup: Lookup; bytes: number; pins: number};
type RecordSource = {manifest: {sourceRevision: string}; readVerifiedFile: PayloadController['readVerifiedFile']};

/** Broker-shared, verified native blocks. In-flight consumers pin entries until extraction. */
export class AbyssRecords {
  private entries = new Map<string, Entry>();
  private searchEntries = new Map<string, Uint8Array>();
  private pending = new Map<string, Promise<Entry>>();
  private index?: Index;
  private bytes = 0;
  private loads = 0;
  private requests = 0;
  private evictions = 0;
  constructor(private payload: RecordSource, private limit = 16 * 1024 * 1024) {}
  profile() { return {bytes: this.bytes, limit: this.limit, blocks: this.entries.size, searchBlocks: this.searchEntries.size, loads: this.loads, requests: this.requests, evictions: this.evictions}; }
  async read(type: number, seed: number, socket: number, bulk: boolean, selector = '') {
    this.requests++;
    try {
      if (!this.index) {
        const bytes = await this.payload.readVerifiedFile('/root/Data/TimelessJewelData/AbyssRecords/index.json');
        const index: Index = JSON.parse(new TextDecoder().decode(bytes));
        if (index?.pin !== this.payload.manifest.sourceRevision || index?.format !== 1) throw new Error('Abyss pin/format mismatch');
        this.index = index;
      }
      const family = this.index!.families.find(f => f.type === type);
      if (!family || !Number.isInteger(seed) || !Number.isInteger(socket) || typeof bulk !== 'boolean') throw new Error('Invalid Abyss request');
      if (seed < family.seedMinimum || seed > family.seedMaximum || (seed-family.seedMinimum) % family.seedIncrement) return new Uint8Array();
      socket = type === 11 ? 0 : socket;
      if (!family.sockets.includes(socket)) return new Uint8Array();
      const bucket = Math.floor((seed-family.seedMinimum) / family.seedIncrement / family.bucketSize);
      const path = `/root/Data/TimelessJewelData/AbyssRecords/${type}-${socket}-${bucket}.bin`;
      const selected = selector ? JSON.parse(selector) as {nodes:number[]; ascendancy?:string} : undefined;
      if (selected && (!bulk || type !== 11 || !Array.isArray(selected.nodes) || selected.nodes.length > 10000 ||
          selected.nodes.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) ||
          (selected.ascendancy !== undefined && (typeof selected.ascendancy !== 'string' || selected.ascendancy.length > 100)))) throw new Error('Invalid Abyss search selector');
      if (selected) selected.nodes.sort((a,b)=>a-b);
      const searchKey = path + ':' + JSON.stringify(selected);
      if (bulk && this.searchEntries.has(searchKey)) {
        const bytes = this.searchEntries.get(searchKey)!;
        this.searchEntries.delete(searchKey);this.searchEntries.set(searchKey,bytes);
        return bytes.slice();
      }
      let entry = this.entries.get(path);
      if (!entry) {
        let pending = this.pending.get(path);
        if (!pending) {
          pending = (async () => {
            const bytes = await this.payload.readVerifiedFile(path, true);
            const lookup = parseAbyssLookup(bytes);
            if (lookup.jewelType !== type || lookup.format !== family.format ||
                lookup.seedMinimum !== family.seedMinimum + bucket * family.bucketSize * family.seedIncrement ||
                lookup.seedCount !== Math.min(family.bucketSize, (family.seedMaximum-lookup.seedMinimum)/family.seedIncrement+1) ||
                (lookup.format === 'ABYS' && (lookup.sockets.length !== 1 || lookup.sockets[0].socketId !== socket))) throw new Error('Abyss block identity mismatch');
            const offsets = lookup.format === 'ABYS' ? lookup.sockets : [...lookup.nodes, ...lookup.ascendancies];
            const weight = bytes.byteLength + offsets.reduce((n, r) => n + r.offsets.byteLength + 128, 0);
            if (weight > this.limit) throw new Error('Abyss block exceeds broker budget');
            this.loads++;
            return {lookup, bytes: weight, pins: 0};
          })().finally(() => this.pending.delete(path));
          this.pending.set(path, pending);
        }
        entry = await pending;
      }
      // Hold the promise result directly: another completed demand may evict
      // an unpinned map entry before this consumer resumes.
      entry.pins++;
      if (!this.entries.has(path)) this.bytes += entry.bytes;
      this.entries.delete(path); this.entries.set(path, entry);
      try {
        if (!bulk) return buildAbyssMiniatureLookup(entry.lookup, {seed, socketId: socket});
        let lookup = entry.lookup;
        if (selected && lookup.format === 'ABYN') {
          const ascendancies = lookup.ascendancies.filter(a => !selected.ascendancy || a.name === selected.ascendancy);
          const nodes = new Set(selected.nodes);
          // Include the complete native ascendancy selections for every seed
          // in the block, so the unchanged Lua reader can resolve their rolls.
          for (const a of ascendancies) for (let i=0;i<lookup.seedCount;i++) {
            let offset=a.offsets[i]; const count=a.data[offset++];
            for (let n=0;n<count;n++,offset+=2) nodes.add(a.data[offset] | a.data[offset+1]<<8);
          }
          lookup = {...lookup, nodes:lookup.nodes.filter(n=>nodes.has(n.nodeId)), ascendancies};
        }
        const bytes = encodeAbyssLookupSlice(lookup,{seedStartIndex:0,seedCount:lookup.seedCount,socketId:socket});
        if (bytes.byteLength > this.limit) throw new Error('Abyss search block exceeds broker budget');
        this.bytes -= this.searchEntries.get(searchKey)?.byteLength ?? 0;
        this.searchEntries.set(searchKey,bytes);this.bytes+=bytes.byteLength;
        return bytes.slice();
      } finally { entry.pins--; this.evict(); }
    } catch (cause) {
      if (cause instanceof PayloadLoadError) throw cause;
      throw new PayloadLoadError('abyss-records', 'Abyss record delivery failed', {cause});
    }
  }
  private evict() {
    for (const [path, entry] of this.entries) {
      if (this.bytes <= this.limit) break;
      if (entry.pins || this.pending.has(path)) continue;
      this.entries.delete(path); this.bytes -= entry.bytes; this.evictions++;
    }
    for (const [key, bytes] of this.searchEntries) {
      if (this.bytes <= this.limit) break;
      this.searchEntries.delete(key);this.bytes-=bytes.byteLength;this.evictions++;
    }
  }
}
