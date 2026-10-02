import { assertEquals, assertRejects } from '@std/assert';
import { HelperAccess } from '../../src/js/helper-access.ts';

Deno.test('helper capabilities stay within immutable root and owned descriptors', async () => {
  const calls: string[] = [];
  const a = new HelperAccess(async operation => { calls.push(operation); return { value: operation === 'open' ? 7 : 0 }; });
  const b = new HelperAccess(async () => ({ value: 9 }));
  await a.handle('open', ['/root/Classes/ItemDBControl.lua','r']);
  await a.handle('read', [7,32,0]);
  for (const [operation,args] of [
    ['fetch',['https://example.com']], ['paste',[]], ['oauth_authorize',[]], ['subscript_start',[]],
    ['open',['/user/private.xml','r']], ['open',['/root/../user/private.xml','r']],
    ['open',['/root/file','w']], ['open',['/root/file','r+']], ['write',[7]], ['read',[9]],
  ] as [string,unknown[]][]) await assertRejects(() => a.handle(operation,args),Error,'denied');
  await assertRejects(() => b.handle('read',[7]),Error,'denied');
  await a.handle('close',[7]);
  await assertRejects(() => a.handle('read',[7]),Error,'denied');
  assertEquals(calls,['open','read','close']);
});

Deno.test('helper metadata stays root-only and payload faults propagate unchanged', async () => {
  const fault = new Error('terminal payload fault');
  const a = new HelperAccess(async operation => { if (operation === 'open') throw fault; return { value: 0 }; });
  await a.handle('stat',['/root']);
  await a.handle('readdir',['/root/Classes']);
  await assertRejects(() => a.handle('lstat',['/user']),Error,'denied');
  try { await a.handle('open',['/root/file','r']); throw new Error('expected rejection'); }
  catch (error) { assertEquals(error, fault); }
});

Deno.test('closing a helper also closes a descriptor whose open was still in flight', async () => {
  let finish!: (result: {value:number}) => void;
  const closed: number[] = [];
  const access = new HelperAccess((operation,args) => {
    if (operation === 'open') return new Promise(resolve => { finish = resolve; });
    closed.push(args[0] as number); return Promise.resolve({value:0});
  });
  const opening = access.handle('open',['/root/file','r']);
  await access.close(); finish({value:12});
  await assertRejects(() => opening,Error,'closed');
  assertEquals(closed,[12]);
  await assertRejects(() => access.handle('stat',['/root']),Error,'closed');
});
