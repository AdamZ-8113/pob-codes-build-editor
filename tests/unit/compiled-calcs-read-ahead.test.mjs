import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadAheadRpc } from '../../tools/experiments/compiled-calcs/expanded/read-ahead.mjs';

function fixture() {
  const data = Uint8Array.from({ length: 100 }, (_, index) => index);
  const calls = [];
  let nextFd = 3;
  const base = (operation, args, bytes, capacity) => {
    calls.push({ operation, args, capacity });
    if (operation === 'open') {
      if (args[0].includes('missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { value: nextFd++ };
    }
    if (operation === 'read') {
      if (args[2] < 0) throw Object.assign(new Error('position'), { code: 'EINVAL' });
      const result = data.slice(args[2], args[2] + args[1]);
      return { value: result.length, data: result.length ? result : undefined };
    }
    if (operation === 'write') { data.set(bytes, args[1]); return { value: bytes.length }; }
    return { value: 0 };
  };
  return { data, calls, base };
}

test('read-ahead preserves bytes, seeks, EOF and independent result ownership', () => {
  const f = fixture(), rpc = createReadAheadRpc(f.base, { chunkBytes: 32, maxRetainedBytes: 64 });
  const fd = rpc('open', ['/root/Modules/Example.lua', 'r']).value;
  for (const [position, length] of [[0, 8], [8, 8], [20, 20], [40, 16], [0, 7], [96, 10], [100, 8], [200, 8]]) {
    const actual = rpc('read', [fd, length, position]);
    const expected = f.data.slice(position, position + length);
    assert.equal(actual.value, expected.length);
    assert.deepEqual(actual.data ?? new Uint8Array(), expected);
    actual.data?.fill(255);
  }
  assert.deepEqual(rpc('read', [fd, 5, 0]).data, f.data.slice(0, 5));
  assert.ok(rpc.profile().windowHits > 0);
  assert.ok(rpc.profile().forwardedCalls.read < rpc.profile().calls.read);
  rpc('close', [fd]);
  assert.equal(rpc.profile().retainedBytes, 0);
  assert.equal(rpc.profile().openFiles, 0);
  assert.equal(rpc.profile().activeDescriptorCount, 0);
  assert.equal(rpc.profile().successfulForwardedCalls.open, rpc.profile().successfulForwardedCalls.close);
});

test('user files, mutable modes, traversal and non-Lua files always use original RPC', () => {
  for (const [path, mode] of [['/user/private.lua', 'r'], ['/root/Modules/x.lua', 'r+'], ['/root/x.json', 'r'], ['/root/../user/x.lua', 'r']]) {
    const f = fixture(), rpc = createReadAheadRpc(f.base, { chunkBytes: 32 });
    const fd = rpc('open', [path, mode]).value;
    rpc('read', [fd, 8, 0], undefined, 4104);
    assert.equal(f.calls.at(-1).args[1], 8);
    assert.equal(f.calls.at(-1).capacity, 4104);
    assert.equal(rpc.profile().windowFetches, 0);
  }
});

test('disabled control forwards exact requests and does not retain source bytes', () => {
  const f = fixture(), rpc = createReadAheadRpc(f.base, { enabled: false, chunkBytes: 32 });
  const fd = rpc('open', ['/root/x.lua', 'r']).value;
  rpc('read', [fd, 8, 0], undefined, 12345);
  assert.deepEqual(f.calls.at(-1), { operation: 'read', args: [fd, 8, 0], capacity: 12345 });
  assert.equal(rpc.profile().retainedBytes, 0);
  assert.equal(rpc.profile().transportedReadBytes, 8);
  assert.equal(rpc.profile().deliveredReadBytes, 8);
});

test('successful open remains the authorization boundary and errors remain observable', () => {
  const f = fixture(), rpc = createReadAheadRpc(f.base, { chunkBytes: 32 });
  assert.throws(() => rpc('open', ['/root/missing.lua', 'r']), { code: 'ENOENT' });
  assert.equal(rpc.profile().eligibleOpens, 0);
  assert.equal(rpc.profile().failedForwardedCalls.open, 1);
  assert.equal(rpc.profile().activeDescriptorCount, 0);
  assert.equal(f.calls.length, 1);
  const fd = rpc('open', ['/root/x.lua', 'r']).value;
  assert.throws(() => rpc('read', [fd, 8, -1]), { code: 'EINVAL' });
});

test('mutation invalidates previously retained windows', () => {
  const f = fixture(), rpc = createReadAheadRpc(f.base, { chunkBytes: 32 });
  const fd = rpc('open', ['/root/x.lua', 'r']).value;
  rpc('read', [fd, 8, 0]);
  rpc('write', [fd, 0], Uint8Array.of(199));
  assert.equal(rpc('read', [fd, 8, 0]).data[0], 199);
  assert.equal(rpc.profile().windowFetches, 2);
});

test('failed close cannot leave readable cached bytes for an invalid descriptor', () => {
  const f = fixture();
  let closed = false;
  const rpc = createReadAheadRpc((operation, ...args) => {
    if (operation === 'close') {
      closed = true;
      throw Object.assign(new Error('interrupted close'), { code: 'EINTR' });
    }
    if (operation === 'read' && closed) throw Object.assign(new Error('bad descriptor'), { code: 'EBADF' });
    return f.base(operation, ...args);
  }, { chunkBytes: 32 });
  const fd = rpc('open', ['/root/x.lua', 'r']).value;
  rpc('read', [fd, 8, 0]);
  assert.throws(() => rpc('close', [fd]), { code: 'EINTR' });
  assert.equal(rpc.profile().retainedBytes, 0);
  assert.equal(rpc.profile().openFiles, 0);
  assert.equal(rpc.profile().failedForwardedCalls.close, 1);
  assert.equal(rpc.profile().activeDescriptorCount, 1, 'failed close must not be reported as proven balanced ownership');
  assert.throws(() => rpc('read', [fd, 8, 0]), { code: 'EBADF' });
});

test('multiple open files retain bounded memory and oversized reads pass through', () => {
  const f = fixture(), rpc = createReadAheadRpc(f.base, { chunkBytes: 32, maxRetainedBytes: 64 });
  for (let i = 0; i < 5; i++) {
    const fd = rpc('open', [`/root/${i}.lua`, 'r']).value;
    rpc('read', [fd, 8, 0]);
  }
  assert.equal(rpc.profile().retainedBytes, 64);
  assert.equal(rpc.profile().peakRetainedBytes, 64);
  rpc('read', [3, 80, 0], undefined, 5000);
  assert.deepEqual(f.calls.at(-1), { operation: 'read', args: [3, 80, 0], capacity: 5000 });
});
