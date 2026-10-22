import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiledRpc } from '../../tools/experiments/compiled-calcs/expanded/rpc-profile.mjs';

test('transport observer preserves requests, capacities and result ownership', () => {
  const args = [4, 8, 16], data = Uint8Array.of(3), result = { value: 2, data: Uint8Array.of(1, 2) };
  let calls = 0;
  const rpc = createProfiledRpc((operation, receivedArgs, receivedData, capacity) => {
    calls++;
    assert.equal(operation, 'read');
    assert.equal(receivedArgs, args);
    assert.equal(receivedData, data);
    assert.equal(capacity, 12345);
    return result;
  });
  assert.equal(rpc('read', args, data, 12345), result);
  assert.equal(rpc('read', args, data, 12345), result);
  assert.equal(calls, 2);
  assert.equal(rpc.profile().transportedReadBytes, 4);
  assert.equal(rpc.profile().requestedReadBytes, 16);
  const snapshot = rpc.profile();
  snapshot.calls.read = 0;
  assert.equal(rpc.profile().calls.read, 2);
});

test('descriptor accounting preserves failed close ownership and original errors', () => {
  const error = Object.assign(new Error('interrupted close'), { code: 'EINTR' });
  let failClose = true;
  const rpc = createProfiledRpc(operation => {
    if (operation === 'open') return { value: 7 };
    if (failClose) throw error;
    return { value: 0 };
  });
  rpc('open', ['/user/private.lua', 'r']);
  assert.deepEqual(rpc.profile().activeDescriptorPaths, ['[non-payload]']);
  assert.throws(() => rpc('close', [7]), actual => actual === error);
  assert.equal(rpc.profile().activeDescriptorCount, 1);
  assert.equal(rpc.profile().failedForwardedCalls.close, 1);
  failClose = false;
  rpc('close', [7]);
  assert.equal(rpc.profile().activeDescriptorCount, 0);
  assert.equal(rpc.profile().successfulForwardedCalls.close, 1);
});
