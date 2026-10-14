# Cold-start findings

This document covers navigation to the Build Editor through the first complete
import result. It distinguishes browser/runtime startup from PoB initialization,
target import and target calculation.

## What “cold” means here

The strongest cold matrix used a fresh Chrome process and profile, broker,
worker, Wasm instance and Lua state for every sample. Vite transformations were
prefetched so development-server transformation was not counted as engine work.
The local OS and server caches could still be warm. This is a clean engine
startup measurement, not a cold-network or first-ever-disk-cache measurement.

The ordinary-app smoke used the normal application, eager helpers and UI work.
It is closer to user-observed first import, but contains only two alternating
pairs for one public fixture and is therefore directional.

## Where the time goes

The balanced four-fixture source baseline produced complete first results in
3.1-4.1 seconds. Its independently computed phase medians were:

| Fixture | First result | Filesystem | Wasm init | Helper boot | Target import | Target calculation | Catalog drain | Explicit GC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Guided | 3,138.7 ms | 496.2 | 14.7 | 1,582.2 | 316.0 | 61.0 | 626.5 | 83.0 |
| Lightning | 4,064.1 ms | 477.3 | 14.8 | 1,601.1 | 1,241.5 | 57.0 | 619.5 | 106.0 |
| Dominating Blow | 3,699.6 ms | 483.3 | 15.0 | 1,595.5 | 784.5 | 139.5 | 709.0 | 95.0 |
| Full DPS variant | 4,072.7 ms | 484.1 | 15.3 | 1,625.8 | 1,234.5 | 65.0 | 561.5 | 104.0 |

These columns are not additive. Natural GC stays inside its enclosing phase,
and first result also includes module/worker setup, bridge encoding/delivery and
local payload transfer. “Target import” includes target calculation; the
calculation column is an instrumented subset.

A separate coarse four-fixture phase profile averaged 3,755 ms and attributed:

| Exclusive phase | Mean | Share |
| --- | ---: | ---: |
| Pre-bootstrap browser/module work | 110 ms | 2.9% |
| Filesystem/package ready | 492 ms | 13.1% |
| Wasm instantiation | 17 ms | 0.5% |
| PoB helper boot | 1,599 ms | 42.6% |
| Target import/hydration | 897 ms | 23.9% |
| Authoring catalog drain | 644 ms | 17.2% |
| Explicit GC | 97 ms | 2.6% |
| Result bridge | 3 ms | 0.1% |

The same profile found about 567 ms in `Modules/Data`, 230 ms in passive-tree
boot, 432 ms in passive-spec boot, 329 ms in `Main:Init`, and 541 ms constructing
roughly 1,209 unique catalog items. The measured calculation union averaged only
80.5 ms, or 2.1% of the coarse first-result time.

### Conclusion

The cold bottleneck is mostly the PoB program executing inside the Lua runtime:
loading modules, building static data, constructing passive-tree/spec and UI
models, hydrating the target build and constructing the authoring catalog. It is
not primarily the browser instantiating Wasm, crossing the final result bridge,
or running damage formulas.

The source scale supports that interpretation. The profiled generated source
contained 386 Lua files, about 197.7 MB and 5.08 million lines, mostly data. The
Wasm binary was 892,196 bytes, while the guided fixture demanded about 8.16 MB of
packed packages and retained roughly 127-159 MiB of Lua state after results.
Alternate-tree builds construct current/latest tree state as well as the target
tree, explaining part of their larger import/hydration phase.

## Tested improvements

### Source-loading read-ahead and native buffering

The accepted four-fixture matrix used four rounds per fixture with balanced
forward/reverse order and exact calculated-output checks.

| Candidate | Baseline/candidate geometric mean | Median paired saving | Positive pairs | Status |
| --- | ---: | ---: | ---: | --- |
| JavaScript 256 KiB read-ahead | 1.06047x | 221.82 ms | 8/8 | Promising experiment |
| Native 64 KiB stdio buffer | 1.04351x | 155.52 ms | 8/8 | Promising experiment |
| Native 256 KiB stdio buffer | 1.05617x | 180.15 ms | 8/8 | Preferred native candidate |

An earlier 16-pair matrix measured the JS candidate at 1.0644x with a 229.5 ms
median saving, and the native 64 KiB candidate at 1.0414x with a 139.3 ms median
saving. The larger native final matrix kept actual delivered bytes constant at
48,715,641 while median read RPCs fell from 5,122 to 777. JS read-ahead reached
417 RPCs but transported 50,098,046 bytes to deliver the same data.

The mechanism is therefore reduced small-read/RPC overhead, not faster formulas.
The median helper-boot/loadfile spans changed from 1,586.6/656 ms at baseline to
1,383.8/456 ms for JS read-ahead and 1,356.0/460 ms for native 256 KiB buffering.

The corrected ordinary-app smoke measured first-import medians of 3,545.3 ms at
baseline, 3,281.0 ms with JS read-ahead and 3,298.8 ms with native buffering.
Native savings were 234.7 and 258.4 ms across two pairs, or about 7% at the
median. All six app samples matched canonical XML and 87 saved player stats.
Because this used one fixture and two pairs, treat it as directional support for
the broader headless result, not a population estimate.

Coverage differs:

- Native buffering changes every Lua runtime, including eager helpers.
- The tested JS app overlay changed the displayed main worker only.
- JS read-ahead needs bounded cache ownership and invalidation. The prototype
  capped aggregate retained windows at 4 MiB.
- The native prototype used a 256 KiB local stack buffer; a production version
  must revalidate parser-stack headroom or use a separately tested allocation.

Neither candidate is currently described by the shipped-source ledger as a
production optimization. Recheck [Bundled PoB changes](../BUNDLED_POB_CHANGES.md)
and `upstream/PROVENANCE.md` before assuming status.

### Input-aware initialization

An experiment supplied the target before helper boot and selected it as the
initial build while preserving the bundled optimized payload.

| Contract | Pairs | Candidate/reference ratio | Reduction | Mean saving |
| --- | ---: | ---: | ---: | ---: |
| Equal-contract one-shot, no authoring catalog in either arm | 16 | 0.97756 | 2.24% | 65.8 ms |
| Ordinary catalog-ready request | 16 | 0.98708 | 1.29% | 43.8 ms |

Typed player/minion outputs matched and lifecycle/resource checks passed. An
attempt to omit the latest tree failed because `ItemsTab.lua` requires it during
initialization. This falsifies the idea that avoiding the unnamed/default build
or merely supplying input earlier removes most cold work. Static data and tree
construction remain on the critical path. The experiment was retained in a
managed worktree but was not promoted, committed or shipped.

### Calculation-only request

Combining read-ahead with a calculation-only request produced a 1.3147x ratio
and a 901 ms median saving in the earlier matrix. This is not a drop-in speedup:
the request deliberately ends before the authoring unique-item catalog is ready.
It is appropriate for calculation APIs such as node-power or comparison jobs,
not for declaring the full editor ready.

### Lua bytecode

Full static bytecode added roughly 3.7-4.0 MiB and did not consistently beat
source read-ahead. Selective passive-tree bytecode had a smaller transfer cost
but inconclusive incremental benefit. An old combined bytecode candidate was
rejected after binary reopen behavior leaked handles and deferred cleanup
outside the measurement boundary. Parsing alone is not the dominant cold cost.

## Architecture implications

### Best next large experiment

Replace, rather than layer on top of, the packed representation for
`Modules/Data`, `Data/ModCache` and demanded passive-tree structures. A useful
falsifier should hydrate those structures at no more than 25% of current
construction time, preserve exact calculation/import behavior and account for
download size and memory. Input-aware startup without that representation
change is too small to justify production work by itself.

### Rust or another native backend

A full backend rewrite cannot be justified from the current cold profile. A
math-only port attacks roughly 2% of measured first-result time. A broader
native subsystem could help only if it replaces expensive data/tree/object
construction or high-frequency runtime crossings while preserving PoB semantics.
The prior architecture study modeled, but did not measure, roughly 26-39% for a
combined input-aware plus generated data/tree representation and roughly 33.5%
for a coarse native vertical subsystem. These are projections, not benchmark
results, and should not be quoted as achieved gains.

The architecture study compared broader options against a lean equivalent
calculation-worker baseline:

| Architecture family | Modeled reduction | Main unresolved issue |
| --- | ---: | --- |
| Input-aware initialization alone | ~18% | Later experiment achieved only 1-2% under retained dependencies |
| Generated/offline data and tree representation alone | ~18% | Needs a compact replacement payload and exact hydration semantics |
| Combined input-aware + generated representation | 26% conservative to 39% optimistic | Unimplemented; first hydration falsifier must settle the range |
| Initialized-state image | ~35% | Current live state is 127-159 MiB; host rebinding and web payload are unresolved |
| Coarse native vertical subsystem | ~33.5% | Requires broad data/tree/spec/calculation ownership and a stable bridge |

Payload cost can erase a modeled cold gain. The study estimated that an extra
MiB costs about 168 ms at 50 Mbit/s or 839 ms at 10 Mbit/s before decompression,
plus any extra round trip. A generated representation should replace or shrink
source/data packages, not arrive as a large second payload. A raw 100+ MiB heap
image is not a viable web cold-start artifact.

### Warm-start implications

Most cold initialization does not repeat after the Lua state and catalogs are
ready. Warm reports, sorts and hovers are governed by calculation reuse,
relevance pruning, helper parallelism, caches, Lua memory density and rendering.
Use [Heavy operations](HEAVY_OPERATIONS.md) instead of extrapolating cold phase
shares to those operations.
