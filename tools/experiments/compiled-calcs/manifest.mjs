import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// The experiment is intentionally independent of normal application entry points.
export const manifest = Object.freeze({
  version: 1,
  stage: 'cold-opportunity-profile',
  sourceRevision: 'a431f3a28823270acbdd6864c644f93678581f1e',
  compilerImage: 'emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef',
  stopBelowEngineCeiling: 1.5,
  denominatorAllowance: 0.1,
  primaryFixtureIds: Object.freeze(['guided-329', 'lightning-strike-328', 'dominating-blow-328']),
  // These are LF-normalized source locks, not generated artifact identities.
  sourceLocks: Object.freeze({
    'upstream/packages/driver/CMakeLists.txt': 'be5e62d44921b7848b012c0cba54ea903e2d95bd1da5b8d0ae9a7a08dba69a85',
    'upstream/packages/driver/helper-boot.lua': '1455f5c0cefd53a36aabfbe280daaf99f5c9c27fb9ce9eca00c2be993442b2c2',
    'upstream/packages/driver/runtime-profile.lua': '0754e88caf7c26fc41eef767da742d078acd748f7dbca927336dfb88a4083e21',
    'Modules/CalcDefence.lua': '9e82a0c71ebb4b6005c6fd850ea0057cf2e6668c3c8e480b8d5310149d3db331',
  }),
});

export function assertSourceIdentity(path, source) {
  const expected = manifest.sourceLocks[path];
  assert.ok(expected, `Unregistered experiment source: ${path}`);
  const actual = createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');
  assert.equal(actual, expected, `Experiment source drift: ${path}`);
}

export function calculationUnion(coarse) {
  assert.equal(coarse.stackDepthAtReport, 0, 'Incomplete calculation/profile stack');
  const region = coarse.regions.calculation;
  assert.ok(region.outerCalls > 0, 'Missing first-import calculation');
  assert.ok(Number.isFinite(region.inclusiveMs) && region.inclusiveMs > 0, 'Invalid calculation union');
  // MAIN/CALCS diagnostic samples may nest. The probe records inclusive time
  // only for outermost calculation spans, so never sum diagnostic parents.
  return region.inclusiveMs;
}

export function geometricMean(values) {
  assert.ok(values.length > 0, 'Missing opportunity samples');
  assert.ok(values.every(value => typeof value === 'number' && value >= 1 && !Number.isNaN(value)), 'Invalid opportunity ceiling');
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

export function summarizeRound(pairs, round) {
  const selected = pairs.filter(pair => pair.round === round);
  assert.deepEqual(selected.map(pair => pair.fixture).sort(), [...manifest.primaryFixtureIds].sort(), 'Every primary fixture must appear exactly once');
  return {
    round,
    conservativeEngineCeilingGeometricMean: geometricMean(selected.map(pair => pair.conservativeEngineCeiling)),
    simpleControlEngineCeilingGeometricMean: geometricMean(selected.map(pair => pair.simpleControlEngineCeiling)),
    adjustedControlEngineCeilingGeometricMean: geometricMean(selected.map(pair => pair.adjustedControlEngineCeiling)),
  };
}

export function needsConfirmation(round) {
  return round.conservativeEngineCeilingGeometricMean < manifest.stopBelowEngineCeiling;
}

export function decideProfile(rounds) {
  assert.ok(rounds.length === 1 || rounds.length === 2, 'Expected one round and at most one confirmation');
  for (const [index, round] of rounds.entries()) {
    assert.equal(round.round, index + 1, 'Profile rounds must be sequential');
    geometricMean([round.conservativeEngineCeilingGeometricMean]);
  }
  const negativeConfirmed = rounds.length === 2 && rounds.every(needsConfirmation);
  if (negativeConfirmed) return {
    outcome: 'negative-feasibility',
    reason: 'Both fresh-browser rounds kept the conservative equal-weight geometric-mean optimistic engine ceiling below 1.5x.',
    nextWave: 'Wave 0B is not justified by this measured gate.',
  };
  if (rounds.length === 1 && needsConfirmation(rounds[0])) return {
    outcome: 'confirmation-required',
    reason: 'A single low-share round cannot establish the negative opportunity gate.',
    nextWave: 'Repeat the three primary fixtures once in fresh browser processes.',
  };
  return {
    outcome: 'continue-or-inconclusive',
    reason: 'The conservative opportunity bound did not establish the confirmed below-1.5x stop condition.',
    nextWave: 'Resolve bounded-kernel feasibility; this is not a measured acceleration.',
  };
}
