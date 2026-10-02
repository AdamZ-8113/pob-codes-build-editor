import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDevicePolicy } from '../../src/device-profile.ts';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('vendored Abyss codec retains shared golden-format implementation', async () => {
  const source = await readFile(new URL('../../upstream/abyss-lookup-format.js',import.meta.url));
  const pin = JSON.parse(await readFile(new URL('../../source-pin.json',import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(source).digest('hex'), pin.adapters.abyssRecordDelivery.pureCodecSha256);
});

test('startup recognizes phones and tablets, including desktop-UA iPadOS', () => {
  for (const device of [
    { userAgent: 'iPhone' }, { userAgent: 'Linux; Android 14; Tablet' },
    { userAgent: 'iPad' }, { userAgentData: { mobile: true } },
    { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 },
  ]) {
    const policy = selectDevicePolicy(device);
    assert.equal(policy.kind, 'mobile');
    assert.equal(policy.helpers, false); assert.equal(policy.prefetch, false);
    assert.equal(policy.manualCalculations, false);
    assert.ok(Object.isFrozen(policy));
  }
});
test('ambiguous, narrow and touch-capable desktops remain desktop; overrides are explicit', () => {
  for (const device of [{}, { userAgent: 'Windows', maxTouchPoints: 10 }, { platform: 'MacIntel', maxTouchPoints: 0 }]) {
    assert.equal(selectDevicePolicy(device).kind, 'desktop');
  }
  assert.equal(selectDevicePolicy({userAgent: 'Android'}, 'desktop').kind, 'desktop');
  assert.equal(selectDevicePolicy({}, 'mobile').kind, 'mobile');
  assert.equal(selectDevicePolicy({}, 'invalid').kind, 'desktop');
});
