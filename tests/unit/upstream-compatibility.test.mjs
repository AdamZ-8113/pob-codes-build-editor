import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilitySpecs, selectCompatibilitySpecs } from '../../scripts/test-upstream-compatibility.mjs';

test('upstream compatibility cannot pass with empty, unknown or duplicated specs', () => {
  for (const selection of [[], ['missing'], ['TestPowerReport','TestPowerReport']]) assert.throws(() => selectCompatibilitySpecs(selection));
  assert.equal(selectCompatibilitySpecs([...compatibilitySpecs]).length, 10);
});
