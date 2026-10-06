import { sha256 } from './core-package-overlay.mjs';

// Keep snapshot text only in the calling process. Return identifiers and hashes,
// never calculated values, for the first mismatch that stops a browser trial.
export function comparePowerSnapshots(reference, candidate) {
  if (reference === candidate) return null;
  const identify = line => /^(node:\d+|mastery:\d+:\d+|max:[^:]+|cluster:[^:]+):/.exec(line)?.[1];
  const rows = text => new Map(text.split('\n').map(line => {
    const key = identify(line);
    if (!key) throw new Error('Unsupported power snapshot row');
    return [key, line];
  }));
  const before = rows(reference), after = rows(candidate);
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (before.get(key) !== after.get(key)) return {
      key,
      baselineSha256: before.has(key) ? sha256(before.get(key)) : null,
      candidateSha256: after.has(key) ? sha256(after.get(key)) : null,
    };
  }
  throw new Error('Power snapshot ordering changed');
}
