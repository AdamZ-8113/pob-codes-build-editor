import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePowerSnapshots } from '../../tools/profiles/power-snapshot-parity.mjs';
import { sha256 } from '../../tools/profiles/core-package-overlay.mjs';

test('snapshot mismatches identify nodes without exposing calculated values', () => {
  const before = 'mastery:123:456:1:nil:nil\nnode:42:12.000000000000001:nil:nil';
  const after = 'mastery:123:456:1:nil:nil\nnode:42:12:nil:nil';
  assert.equal(comparePowerSnapshots(before, before), null);
  assert.deepEqual(comparePowerSnapshots(before, after), {
    key: 'node:42', baselineSha256: sha256(before.split('\n')[1]), candidateSha256: sha256(after.split('\n')[1]),
  });
  assert.deepEqual(comparePowerSnapshots('mastery:123:456:1:nil:nil', 'mastery:123:456:2:nil:nil').key, 'mastery:123:456');
});

test('snapshot parity catches added/missing rows, changed maxima, and ordering drift', () => {
  assert.equal(comparePowerSnapshots('node:1:0:nil:nil', 'node:1:0:nil:nil\nnode:2:0:nil:nil').baselineSha256, null);
  assert.equal(comparePowerSnapshots('node:1:0:nil:nil\nnode:2:0:nil:nil', 'node:1:0:nil:nil').candidateSha256, null);
  assert.equal(comparePowerSnapshots('max:singleStat:1', 'max:singleStat:2').key, 'max:singleStat');
  assert.equal(comparePowerSnapshots('cluster:Example:1:nil:nil', 'cluster:Example:2:nil:nil').key, 'cluster:Example');
  assert.throws(() => comparePowerSnapshots('node:1:0\nnode:2:0', 'node:2:0\nnode:1:0'), /ordering/);
  assert.throws(() => comparePowerSnapshots('unrecognized:1', 'unrecognized:2'), /Unsupported/);
});
