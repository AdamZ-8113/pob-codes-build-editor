# Public benchmark recipe

Build and start the candidate once, then run `npm run bench`. Use the same
machine and alternate baseline/candidate order. The runner records commands and
identity metadata beneath `reports/benchmark/`; those reports are ignored and
must be reviewed before sharing.

The recipe exercises:

1. cold and warm startup (`tools/profiles/profile-startup.mjs`);
2. repeated and changed item hover (`tools/profiles/profile-item-hover.mjs`);
3. gem dropdown hover (`tools/profiles/profile-gem-hover.mjs`);
4. serial and helper-backed unique sorting (`tools/profiles/profile-unique-memory.mjs`);
5. tree movement and stable frames (`tools/profiles/profile-interactions.mjs`); and
6. whole-browser retained private commit where supported.

Record the fixture SHA-256, `source-pin.json`, payload manifest, driver JS/Wasm,
browser version/channel, CPU, memory, OS, viewport and device-pixel ratio.
Report cold and warm results separately, median and p95 frame CPU, operation
duration, and retained memory. Alternate at least three before/after pairs for
claims. Verify complete tooltip lines and canonical exports; rendering changes
also require fixed-time pixel comparisons.

Animation-frame callbacks measure JavaScript/Lua/renderer CPU scheduling, not
actual GPU presentation latency. Scripted input response is a proxy, not human
input-to-photon latency. State those limitations with every result.
