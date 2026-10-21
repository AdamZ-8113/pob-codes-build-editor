import { assertEquals, assert } from '@std/assert';
import { HelperPool, HELPER_MEMORY, DESKTOP_HELPER_MEMORY, helperMemoryPolicy, type UniqueJob } from '../../src/js/helper-pool.ts';
import { isTooltipOperations, type ItemComparisonJob } from '../../src/js/item-comparison.ts';

const job = (identity = 'build-A:1', count = 180): UniqueJob => ({ identity, xml: identity,
  sortMode: 'TotalDPS', weaponSet: false, uiBytes: 2 ** 30,
  items: Array.from({length: count}, (_, i) => ({key: String(i), raw: 'candidate-' + i})) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

Deno.test('item comparisons reuse one member, preserve operations, and separate snapshot identities', async () => {
  const h = harness();
  const operations = [{name: 'AddLine', args: [14, '^7+12.34 Life']}, {name: 'AddSeparator', args: [10]}];
  const comparison: ItemComparisonJob = {identity: 'public:1', xml: 'public snapshot', uiBytes: 2 ** 30,
    item: {raw: 'public candidate'}, options: {slotOnlyTooltips: false}};
  try {
    await h.pool.start(3);
    h.setBehavior((w, r) => w.reply(r, r.job?.kind === 'comparison' && r.job.item ? operations : undefined));
    assertEquals(await h.pool.runComparison(comparison), operations);
    assertEquals(h.workers.filter(w => w.requests.some((r: any) => r.job?.item)).length, 1);
    const imports = h.workers[0].requests.filter((r: any) => r.job?.xml).length;
    assertEquals(await h.pool.runComparison({...comparison, item: {raw: 'another candidate'}}), operations);
    assertEquals(h.workers[0].requests.filter((r: any) => r.job?.xml).length, imports);
    assertEquals((await h.pool.run(job('public:1', 30)))?.length, 30);
    assertEquals(await h.pool.runComparison(comparison), operations);
    assertEquals(h.workers[0].requests.filter((r: any) => r.job?.xml).length, imports + 2);
  } finally { h.pool.close(); }
});

Deno.test('item comparisons start one member on demand and discard cancelled results', async () => {
  const h = harness();
  const comparison: ItemComparisonJob = {identity: 'public:1', xml: 'public snapshot', uiBytes: 2 ** 30,
    item: {raw: 'public candidate', id: 1}, options: {}};
  try {
    let release: (() => void) | undefined;
    h.setBehavior((w, r) => r.job?.item ? release = () => w.reply(r, []) : w.reply(r));
    const result = h.pool.runComparison(comparison);
    for (let i = 0; i < 20 && !release; i++) await tick();
    assert(release);
    assertEquals(h.workers.length, 1);
    h.pool.cancelComparison(); release();
    assertEquals(await result, null);
    h.setBehavior((w, r) => w.reply(r, r.job?.item ? [] : undefined));
    assertEquals(await h.pool.runComparison(comparison), []);
    assert(isTooltipOperations([]));
    assertEquals(isTooltipOperations([{name: 'Clear', args: [true]}]), false);
    assertEquals(isTooltipOperations([{name: 'AddLine', args: [14, {text: 'bad'}]}]), false);
  } finally { h.pool.close(); }
});

Deno.test('node-power jobs preserve numeric fields, separate hydration kinds, and reject malformed results', async () => {
  const h = harness();
  try {
    await h.pool.start(2);
    h.setBehavior((worker, request) => worker.reply(request, request.job?.kind === 'nodePower' && request.job.items
      ? request.job.items.map((item: any) => ({singleStat: String(item.addNodes[0].id)})) : undefined));
    const nodeJob = {kind: 'nodePower' as const, identity: 'shared:1', xml: 'public test XML', metric: 'Hit DPS', uiBytes: 2 ** 30,
      items: Array.from({length: 80}, (_, i) => ({addNodes: [{id: i}]}))};
    assertEquals(await h.pool.run(nodeJob), nodeJob.items.map(item => ({singleStat: String(item.addNodes[0].id)})));
    assertEquals((await h.pool.run(job('shared:1', 30)))?.length, 30);
    assert(h.workers.every(w => w.requests.filter((r: any) => r.job?.xml).length === 2));
    h.setBehavior((worker, request) => worker.reply(request, request.job?.items ? request.job.items.map(() => ({singleStat: 'NaN'})) : undefined));
    assertEquals(await h.pool.run(nodeJob), null);
    assertEquals(h.pool.profile().ready, 0);
  } finally { h.pool.close(); }
});
function harness(timeout = 1000, memory = HELPER_MEMORY) {
  const workers: any[] = [], detached: number[] = [], available: boolean[] = [], diagnostics: any[] = [];
  let behavior: (worker: any, request: any) => void = (worker, request) => worker.reply(request);
  const pool = new HelperPool(() => {
    const worker = { onmessage: null as any, onerror: null as any, stopped: false, imported: '', requests: [] as any[],
      terminate() { this.stopped = true; },
      reply(request: any, value?: unknown, bytes = 256 * 2 ** 20) {
        if (this.stopped) return;
        if (request.job?.xml) this.imported = request.job.identity;
        this.onmessage({data:{id:request.id,ok:true,bytes,
          value: value ?? (request.job?.items ? request.job.items.map((i: any) => i.key) : {ready:true})}});
      },
      postMessage(request: any) {
        request.port?.close(); this.requests.push(request);
        queueMicrotask(() => { if (!this.stopped) behavior(this, request); });
      },
    };
    workers.push(worker); return worker as unknown as Worker;
  }, async (_id, port) => { port.close(); }, async id => { detached.push(id); }, ready => available.push(ready),
    timeout, 400, (event, data, level) => diagnostics.push({event, data, level}), undefined, memory);
  return {pool, workers, detached, available, diagnostics, setBehavior(fn: typeof behavior) { behavior = fn; }};
}

Deno.test('helper batches preserve candidate order across out-of-order workers and build lifetimes', async () => {
  const h = harness();
  try {
    await h.pool.start(3);
    let delayed: (() => void) | undefined;
    h.setBehavior((worker, request) => {
      if (request.job?.items && !delayed) delayed = () => worker.reply(request);
      else { worker.reply(request); delayed?.(); }
    });
    assertEquals(await h.pool.run(job()), Array.from({length:180}, (_,i) => String(i)));
    h.setBehavior((w,r) => w.reply(r));
    assertEquals(await h.pool.run(job('build-B:1', 75)), Array.from({length:75}, (_,i) => String(i)));
    assert(h.workers.every(w => w.imported === 'build-B:1'));
    assertEquals(h.available, [true]);
  } finally { h.pool.close(); }
  assertEquals(h.detached.length, 3);
});

Deno.test('cancelled jobs cannot publish late scores or progress', async () => {
  const h = harness();
  try {
    await h.pool.start(1);
    let reply: (() => void) | undefined;
    h.setBehavior((w,r) => r.job?.items ? reply = () => w.reply(r) : w.reply(r));
    const progress: number[] = [];
    const pending = h.pool.run(job(), count => progress.push(count)); await tick();
    assert(reply); h.pool.cancel(); reply();
    assertEquals(await pending, null); assertEquals(h.pool.profile().completed, 0);
    assertEquals(progress, []);
    h.setBehavior((w,r) => w.reply(r));
    assertEquals((await h.pool.run(job('new:1')))?.length, 180);
  } finally { h.pool.close(); }
});

Deno.test('helper progress counts validated chunks per job before the last worker returns', async () => {
  const h = harness();
  try {
    await h.pool.start(2);
    const held: (() => void)[] = [];
    h.setBehavior((worker, request) => request.job?.items
      ? held.push(() => worker.reply(request)) : worker.reply(request));
    const progress: number[] = [];
    const pending = h.pool.run(job('chunks', 50), count => progress.push(count));
    await tick(); assertEquals(held.length, 2); assertEquals(progress, []);
    held[1](); await tick(); assertEquals(progress, [25]);
    held[0](); assertEquals((await pending)?.length, 50); assertEquals(progress, [25, 50]);
    h.setBehavior((worker, request) => worker.reply(request));
    const next: number[] = [];
    await h.pool.run(job('next', 10), count => next.push(count));
    assertEquals(next, [10], 'Progress is relative to this request, not the pool lifetime');
    h.setBehavior((worker, request) => worker.reply(request, request.job?.items ? ['bad'] : undefined));
    const invalid: number[] = [];
    assertEquals(await h.pool.run(job('invalid', 50), count => invalid.push(count)), null);
    assertEquals(invalid, [], 'Invalid chunks cannot advance progress');
  } finally { h.pool.close(); }
});

for (const fault of ['timeout', 'crash', 'invalid-result', 'memory-growth']) {
  Deno.test('helper ' + fault + ' retires busy workers, permits serial fallback and recovers on next start', async () => {
    const h = harness(15);
    try {
      await h.pool.start(2);
      h.setBehavior((w,r) => {
        if (!r.job?.items) return w.reply(r);
        if (fault === 'timeout') return;
        if (fault === 'crash') return w.onerror({message:'test crash'});
        w.reply(r, fault === 'invalid-result' ? ['not-a-score'] : undefined,
          fault === 'memory-growth' ? 2 ** 30 + 65536 : 256 * 2 ** 20);
      });
      assertEquals(await h.pool.run(job()), null);
      assertEquals(h.pool.profile().ready, 0);
      assert(h.workers.every(w => w.stopped));
      h.setBehavior((w,r) => w.reply(r)); await h.pool.start();
      assertEquals((await h.pool.run(job('recovered:1')))?.length, 180);
    } finally { h.pool.close(); }
  });
}

Deno.test('unadmitted UI memory and teardown cannot keep a helper pool alive', async () => {
  const h = harness();
  await h.pool.start(8); assertEquals(h.pool.profile().ready, 3);
  assertEquals(await h.pool.run({...job(), uiBytes: 2 ** 31 + 65536}), null);
  assertEquals(h.pool.profile().ready, 0);
  h.pool.close(); await h.pool.start(1);
  assertEquals(h.pool.profile().ready, 0);
  assertEquals(await h.pool.run(job()), null);
});

for (const bytes of [742326272, 2 ** 30, 2 ** 30 + 65536]) {
  Deno.test(`helper capacity ${bytes} respects the 1 GiB per-helper boundary`, async () => {
    const h = harness();
    try {
      await h.pool.start(1);
      h.setBehavior((worker, request) => worker.reply(request, undefined, bytes));
      const result = await h.pool.run(job());
      if (bytes <= 2 ** 30) {
        assertEquals(result, Array.from({length: 180}, (_, i) => String(i)));
        assertEquals(h.pool.profile().state, 'ready');
      } else {
        assertEquals(result, null);
        assertEquals(h.pool.profile().state, 'retired');
        assertEquals(h.diagnostics.at(-1)?.event, 'helpers-fallback');
        assertEquals(h.diagnostics.at(-1)?.data.reason, 'helper-memory');
      }
    } finally { h.pool.close(); }
  });
}

Deno.test('three larger helpers remain subject to the aggregate memory ceiling', async () => {
  const h = harness();
  try {
    await h.pool.start(3);
    h.setBehavior((worker, request) => worker.reply(request, undefined, 742326272));
    assertEquals((await h.pool.run(job()))?.length, 180);
    assertEquals(h.pool.profile().ready, 3);
    h.setBehavior((worker, request) => worker.reply(request, undefined, 2 ** 30));
    assertEquals(await h.pool.run(job('larger-build:1')), Array.from({length: 180}, (_, i) => String(i)));
    assertEquals(h.pool.profile().ready, 2);
    assertEquals(h.pool.profile().reduced, 1);
    assertEquals(h.workers.filter(worker => worker.stopped).length, 1);
  } finally { h.pool.close(); }
});

Deno.test('desktop memory policy is independent of CPU count and respects low-memory/mobile signals', () => {
  for (const hardwareConcurrency of [2, 4, 6, 8, 16]) {
    const desktop = {userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/158', hardwareConcurrency};
    assertEquals(helperMemoryPolicy(desktop), DESKTOP_HELPER_MEMORY);
    assertEquals(helperMemoryPolicy({...desktop, deviceMemory: 8}), DESKTOP_HELPER_MEMORY);
    for (const deviceMemory of [2, 4, NaN]) {
      assertEquals(helperMemoryPolicy({...desktop, deviceMemory}), HELPER_MEMORY);
    }
  }
  for (const userAgent of ['Android', 'iPhone', 'iPad', 'Mobile']) {
    assertEquals(helperMemoryPolicy({userAgent, deviceMemory: 8}), HELPER_MEMORY);
  }
});

for (const memory of [HELPER_MEMORY, DESKTOP_HELPER_MEMORY]) {
  Deno.test(`combined Power Report preserves all results under ${memory.admissionBytes / 2 ** 30} GiB admission`, async () => {
    const h = harness(1000, memory);
    try {
      await h.pool.start(3);
      const nodeJob = {kind: 'nodePower' as const, identity: 'combined:1', xml: 'public test XML',
        metric: 'Offence-Defence', uiBytes: 876675072,
        items: Array.from({length: 180}, (_, i) => ({addNodes: [{id: i}]}))};
      const expected = nodeJob.items.map(item => ({offence: String(item.addNodes[0].id), defence: '1.2345678901234567'}));
      h.setBehavior((w, r) => w.reply(r, r.job?.items
        ? r.job.items.map((item: any) => expected[item.addNodes[0].id]) : undefined, 924057600));
      const progress: number[] = [];
      assertEquals(await h.pool.run(nodeJob, count => progress.push(count)), expected);
      assertEquals(progress.at(-1), 180);
      assert(progress.every((count, i) => !i || count > progress[i - 1]));
      const remaining = memory === HELPER_MEMORY ? 2 : 3;
      assertEquals(h.pool.profile().ready, remaining);
      assertEquals(h.pool.profile().reduced, 3 - remaining);
      assertEquals(h.pool.profile().recycled, 0);
      assert(!h.diagnostics.some(d => d.event === 'helpers-fallback'));
      if (remaining === 2) assertEquals(h.diagnostics.at(-1)?.data.count, 2);
      assertEquals(await h.pool.run(nodeJob), expected);
      assertEquals(h.workers.length, 3, 'Reduced pools do not automatically regrow');
    } finally { h.pool.close(); }
  });

  Deno.test(`maximum legal heaps reduce the ${memory.admissionBytes / 2 ** 30} GiB pool without losing work`, async () => {
    const h = harness(1000, memory);
    try {
      await h.pool.start(3);
      h.setBehavior((w, r) => w.reply(r, undefined, 2 ** 30));
      assertEquals(await h.pool.run({...job(), uiBytes: 2 ** 31}), job().items.map(i => i.key));
      assertEquals(h.pool.profile().ready, memory === HELPER_MEMORY ? 1 : 2);
      h.setBehavior((w, r) => w.reply(r, undefined, 2 ** 30 + 65536));
      assertEquals(await h.pool.run({...job('oversized'), uiBytes: 2 ** 31}), null);
      assertEquals(h.pool.profile().state, 'retired');
    } finally { h.pool.close(); }
  });
}

for (const cancel of [false, true]) {
  Deno.test(`memory reduction drains in-flight chunks and ${cancel ? 'honors cancellation' : 'retains completed results'}`, async () => {
    const h = harness();
    try {
      await h.pool.start(3);
      const held: (() => void)[] = [];
      h.setBehavior((w, r) => r.job?.items ? held.push(() => w.reply(r, undefined, 2 ** 30)) : w.reply(r));
      const progress: number[] = [];
      const pending = h.pool.run({...job(), uiBytes: 2 ** 31}, count => progress.push(count));
      await tick(); assertEquals(held.length, 3);
      held[0](); await tick();
      assertEquals(progress, [25]);
      assertEquals(held.length, 3, 'No new chunk is dispatched while memory is over budget');
      assert(h.workers.every(w => !w.stopped), 'In-flight workers must not be terminated');
      if (cancel) h.pool.cancel();
      h.setBehavior((w, r) => w.reply(r, undefined, 2 ** 30));
      held[2](); held[1]();
      if (cancel) {
        assertEquals(await pending, null);
        assertEquals(progress, [25], 'Cancelled replies cannot publish progress');
      } else {
        assertEquals(await pending, job().items.map(i => i.key));
        assertEquals(h.pool.profile().ready, 1);
        assertEquals(h.pool.profile().reduced, 2);
        assertEquals(progress.at(-1), 180);
        const keys = h.workers.flatMap(w => w.requests.flatMap((r: any) => r.job?.items?.map((i: any) => i.key) ?? []));
        assertEquals(keys.length, 180);
        assertEquals(new Set(keys).size, 180, 'No completed work is repeated');
      }
    } finally { h.pool.close(); }
  });
}

Deno.test('retirement preserves bounded memory diagnostics until the next populated pool retires', async () => {
  const h = harness();
  try {
    assertEquals(h.pool.profile().lastRetiredBytes, []);
    await h.pool.start(2);
    const oversizedBytes = 2 ** 30 + 65536;
    h.setBehavior((worker, request) => worker.reply(request, undefined, oversizedBytes));
    assertEquals(await h.pool.run(job()), null);
    const retired = h.pool.profile();
    assertEquals(retired.bytes, []);
    assertEquals(retired.lastRetiredBytes, [oversizedBytes, oversizedBytes]);
    retired.lastRetiredBytes[0] = 0;
    assertEquals(h.pool.profile().lastRetiredBytes, [oversizedBytes, oversizedBytes]);

    h.setBehavior((worker, request) => worker.reply(request));
    await h.pool.start(1);
    assertEquals(h.pool.profile().lastRetiredBytes, [oversizedBytes, oversizedBytes]);
    assertEquals(await h.pool.run({...job(), uiBytes: 2 ** 31 + 65536}), null);
    assertEquals(h.pool.profile().lastRetiredBytes, [256 * 2 ** 20]);
    h.pool.close();
    assertEquals(h.pool.profile().lastRetiredBytes, [256 * 2 ** 20]);
  } finally { h.pool.close(); }
});

Deno.test('armed helper capacity allocates only on a sort request and reuses the ready pool', async () => {
  const h = harness();
  try {
    assertEquals(h.pool.prepare(0), 0);
    assertEquals(h.pool.profile().state, 'disabled');
    assertEquals(h.pool.prepare(8), 3);
    assertEquals(h.pool.profile().state, 'armed');
    assertEquals(h.pool.profile().ready, 0);
    assertEquals(h.workers.length, 0);
    assertEquals(h.available, []);
    assertEquals((await h.pool.run(job()))?.length, 180);
    assertEquals(h.workers.length, 3);
    assertEquals(h.pool.profile().state, 'ready');
    assertEquals(h.pool.profile().starts, 1);
    assert(h.pool.profile().startupMs >= 0);
    assertEquals(await h.pool.run(job('build-B:1', 75)), Array.from({length:75}, (_,i) => String(i)));
    assertEquals(h.workers.length, 3);
    assertEquals(h.pool.profile().starts, 1);
    assert(h.workers.every(w => w.imported === 'build-B:1'));
  } finally { h.pool.close(); }
});

Deno.test('cancel during lazy boot prevents imported build and scores from the cancelled request', async () => {
  const h = harness();
  let boot: (() => void) | undefined;
  h.setBehavior((w,r) => {
    if (r.kind === 'boot' && !boot) boot = () => w.reply(r);
    else w.reply(r);
  });
  try {
    h.pool.prepare(2);
    const pending = h.pool.run(job()); await tick();
    assert(boot);
    assertEquals(h.pool.profile().state, 'booting');
    assertEquals(h.pool.profile().ready, 1); // Second concurrent worker is ready; the batch still waits.
    h.pool.cancel(); boot();
    assertEquals(await pending, null);
    assertEquals(h.pool.profile().completed, 0);
    assert(h.workers.every(w => w.requests.every((r: any) => r.kind === 'boot')));
    assertEquals((await h.pool.run(job('new:1')))?.length, 180);
    assert(h.workers.every(w => w.imported === 'new:1'));
  } finally { h.pool.close(); }
});

Deno.test('a newer queued request supersedes the request that initiated helper boot', async () => {
  const h = harness();
  let boot: (() => void) | undefined;
  h.setBehavior((w,r) => r.kind === 'boot' ? boot = () => w.reply(r) : w.reply(r));
  try {
    h.pool.prepare(1);
    const old = h.pool.run(job('old:1')); await tick();
    assert(boot);
    const current = h.pool.run(job('current:1', 30)); boot();
    assertEquals(await old, null);
    assertEquals((await current)?.length, 30);
    assertEquals(h.workers[0].imported, 'current:1');
    assertEquals(h.pool.profile().completed, 30);
  } finally { h.pool.close(); }
});

Deno.test('lazy boot failure permits serial fallback and requires explicit rearming before recovery', async () => {
  const h = harness();
  try {
    h.pool.prepare(2);
    h.setBehavior((w,r) => w.onmessage({data:{id:r.id,ok:false,error:'boot failed'}}));
    assertEquals(await h.pool.run(job()), null);
    assertEquals(h.pool.profile().state, 'retired');
    assertEquals(h.pool.profile().ready, 0);
    assertEquals(h.pool.profile().armed, false);
    assert(h.workers.every(w => w.stopped));
    assertEquals(await h.pool.run(job('not-rearmed:1')), null);
    assertEquals(h.workers.length, 2); // Both concurrent boots were attempted and retired.
    h.setBehavior((w,r) => w.reply(r)); h.pool.prepare();
    assertEquals((await h.pool.run(job('rearmed:1')))?.length, 180);
    assertEquals(h.pool.profile().starts, 2);
  } finally { h.pool.close(); }
});

Deno.test('unadmitted UI memory is rejected before lazy helper allocation', async () => {
  const h = harness();
  try {
    h.pool.prepare(3);
    assertEquals(await h.pool.run({...job(), uiBytes: 2 ** 31 + 65536}), null);
    assertEquals(h.workers.length, 0);
    assertEquals(h.pool.profile().starts, 0);
    assertEquals(h.pool.profile().state, 'retired');
  } finally { h.pool.close(); }
});

Deno.test('teardown during lazy boot cannot create additional workers or publish scores', async () => {
  const h = harness();
  h.setBehavior(() => {});
  h.pool.prepare(3);
  const pending = h.pool.run(job()); await tick();
  assertEquals(h.workers.length, 3);
  h.pool.close();
  assertEquals(await pending, null);
  assertEquals(h.workers.length, 3);
  assertEquals(h.pool.profile().state, 'closed');
  assertEquals(h.pool.profile().completed, 0);
  assert(h.workers.every(w => w.stopped));
});

Deno.test('a report submitted during eager startup waits for the ready pool', async () => {
  const h = harness();
  let boot: (() => void) | undefined;
  h.setBehavior((w,r) => {
    if (r.kind === 'boot' && !boot) boot = () => w.reply(r);
    else w.reply(r);
  });
  try {
    const starting = h.pool.start(2); await tick();
    const pending = h.pool.run(job('eager:1', 180)); await tick();
    assert(boot); assertEquals(h.pool.profile().completed, 0);
    boot(); await starting;
    assertEquals((await pending)?.length, 180);
    assertEquals(h.pool.profile().completed, 180);
    assertEquals(h.pool.profile().starts, 1);
    assert(h.workers.every(w => w.imported === 'eager:1'));
  } finally { h.pool.close(); }
});
Deno.test('cancelled reports waiting for eager boot cannot import or publish results', async () => {
  const h = harness();
  let boot: (() => void) | undefined;
  h.setBehavior((w,r) => {
    if (r.kind === 'boot' && !boot) boot = () => w.reply(r);
    else w.reply(r);
  });
  try {
    const starting = h.pool.start(2); await tick();
    const pending = h.pool.run(job('cancelled:1')); await tick();
    assert(boot); h.pool.cancel(); boot(); await starting;
    assertEquals(await pending, null);
    assertEquals(h.pool.profile().completed, 0);
    assert(h.workers.every(w => w.requests.every((r: any) => r.kind === 'boot')));
    assertEquals((await h.pool.run(job('new:1')))?.length, 180);
  } finally { h.pool.close(); }
});

Deno.test('concurrent helper startup retires all workers when one boot fails', async () => {
  const h = harness();
  let fail: (() => void) | undefined;
  h.setBehavior((w,r) => {
    if (r.kind === 'boot' && !fail) fail = () => w.onmessage({data:{id:r.id,ok:false,error:'boot failure'}});
    else w.reply(r);
  });
  try {
    const starting = h.pool.start(3); await tick();
    assertEquals(h.workers.length,3); assert(fail);
    const pending = h.pool.run(job()); fail(); await starting;
    assertEquals(await pending,null);
    assertEquals(h.pool.profile().state,'retired');
    assert(h.workers.every(w=>w.stopped));
    assertEquals(h.pool.profile().completed,0);
    assert(h.available.every(value=>!value));
  } finally { h.pool.close(); }
});
