import { assertEquals, assert } from '@std/assert';
import { HelperPool, type UniqueJob } from '../../src/js/helper-pool.ts';

const job = (identity = 'build-A:1', count = 180): UniqueJob => ({ identity, xml: identity,
  sortMode: 'TotalDPS', weaponSet: false, uiBytes: 2 ** 30,
  items: Array.from({length: count}, (_, i) => ({key: String(i), raw: 'candidate-' + i})) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

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
function harness(timeout = 1000) {
  const workers: any[] = [], detached: number[] = [], available: boolean[] = [];
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
  }, async (_id, port) => { port.close(); }, async id => { detached.push(id); }, ready => available.push(ready), timeout);
  return {pool, workers, detached, available, setBehavior(fn: typeof behavior) { behavior = fn; }};
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
    const pending = h.pool.run(job()); await tick();
    assert(reply); h.pool.cancel(); reply();
    assertEquals(await pending, null); assertEquals(h.pool.profile().completed, 0);
    h.setBehavior((w,r) => w.reply(r));
    assertEquals((await h.pool.run(job('new:1')))?.length, 180);
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
          fault === 'memory-growth' ? 2 ** 30 : 256 * 2 ** 20);
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

Deno.test('retirement preserves bounded memory diagnostics until the next populated pool retires', async () => {
  const h = harness();
  try {
    assertEquals(h.pool.profile().lastRetiredBytes, []);
    await h.pool.start(2);
    const oversizedBytes = 768 * 2 ** 20;
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
    assertEquals(h.pool.profile().ready, 0);
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
    assertEquals(h.workers.length, 1);
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
  assertEquals(h.workers.length, 1);
  h.pool.close();
  assertEquals(await pending, null);
  assertEquals(h.workers.length, 1);
  assertEquals(h.pool.profile().state, 'closed');
  assertEquals(h.pool.profile().completed, 0);
  assert(h.workers.every(w => w.stopped));
});
