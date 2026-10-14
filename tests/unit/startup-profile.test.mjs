import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, startupTarget, profileStartup } from '../../tools/profiles/profile-startup.mjs';

test('startup profiling refuses production and ambiguous targets', () => {
  for (const url of ['https://pob.codes/browserpob', 'http://localhost:3010', 'http://127.0.0.1:3011/?private=value', 'http://user:secret@127.0.0.1:3011']) {
    assert.throws(() => startupTarget(url));
  }
  assert.equal(startupTarget('http://127.0.0.1:3011/browserpob').pathname, '/browserpob/');
  assert.equal(startupTarget('http://127.0.0.1:3011/browserpob/').pathname, '/browserpob/');
});

test('missing old-build milestones are not reported as zero and small samples are counted', () => {
  assert.deepEqual(distribution([null, undefined, NaN]), { count: 0, p50: null, p95: null });
  assert.deepEqual(distribution([100, 50, null]), { count: 2, p50: 75, p95: 100 });
});

test('run bounds reject before starting a browser or requesting an artifact', async () => {
  for (const runs of [0, 11, 1.5, NaN]) await assert.rejects(profileStartup({ runs }), /Runs must/);
});
