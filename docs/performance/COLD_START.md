# Cold-start findings

This document covers navigation to the Build Editor through the first complete
import result. It distinguishes browser/runtime startup from PoB initialization,
target import and target calculation.

## Browser startup presentation and readiness

The browser host shows a centered, segmented loading bar in a separate startup
surface. It keeps About accessible and editor actions disabled
until DOM attachment and a real nonzero-instance frame complete. A one-shot
frame/attachment latch replaces the 100 ms readiness poll. The startup surface
then disappears; demand loading, terminal errors and Reload keep their existing
panel. PoB initialization, renderer behavior and payload requirements are unchanged.

The timing trial below predates the visual revision from a text placeholder to
the segmented loading bar; its artifact hashes identify that earlier presentation.
The readiness latch is unchanged. The revised presentation passed type checks,
unit tests, startup browser checks and five end-to-end tests; its timing was not
remeasured.

A local trial on 2026-10-14 used five alternating baseline/candidate pairs, each
with a fresh-browser cold launch followed by a same-context warm navigation.
Both were materialized static builds served on the same loopback port, with
identical native binaries and payloads, at 1600x1000 DPR 1 in headless Chrome
155.0.8059.41 on a Ryzen 7 9800X3D (8 logical processors exposed). OS/server
caches were not cleared; no test suite ran during the retained timing sample.
The default empty build selector was measured, not build import or calculation.

Each entry below is p50 / p95 in milliseconds, with five samples per cell.
With this sample size p95 is simply the observed maximum, not a population
estimate. One candidate cold launch took 2.26 seconds; its Lua-ready phase also
rose to 1.96 seconds. Do not turn these numbers into a general speedup claim.

| Navigation milestone | Baseline cold | Candidate cold | Baseline warm | Candidate warm |
| --- | ---: | ---: | ---: | ---: |
| First contentful paint | 183.2 / 184.5 | 140.9 / 154.5 | 22.7 / 26.4 | 23.6 / 25.6 |
| First canonical PoB frame | 1698.8 / 1717.9 | 1731.0 / 2258.9 | 1475.2 / 1726.4 | 1562.9 / 1686.2 |
| Observed editor ready | 1756.1 / 1783.9 | 1732.7 / 2260.1 | 1531.7 / 1752.3 | 1565.4 / 1688.4 |
| Payload ready | 1751.6 / 1781.3 | 1733.5 / 2263.4 | 1527.4 / 1748.0 | 1563.9 / 1687.4 |
| First frame to observed ready | 66.0 / 73.3 | 1.6 / 1.7 | 45.1 / 56.5 | 2.6 / 4.2 |

Ready is observed with the same RAF sampler in both builds; baseline has no
exact editor-ready mark. Candidate's exact first-frame-to-editor-ready median
was 0.02 ms for both cache modes. The observed-ready median ratios were 0.987x
cold and 1.022x warm; payload-ready ratios were 0.990x and 1.024x. Both meet
the local 1.05x regression guard. Cached FCP remained below 250 ms. All samples
had zero settled idle redraws and no runtime/page errors or external requests;
the existing optional texture 404s were explicitly classified by the profiler.

Existing worker phase clocks are relative to worker startup, not navigation,
and overlap; do not add them together:

| Worker phase | Baseline cold | Candidate cold | Baseline warm | Candidate warm |
| --- | ---: | ---: | ---: | ---: |
| Fonts ready | 12.0 / 24.0 | 13.1 / 21.2 | 10.8 / 12.3 | 11.1 / 29.3 |
| Wasm ready | 16.5 / 23.6 | 18.0 / 43.8 | 13.1 / 15.8 | 14.2 / 31.9 |
| Filesystem ready | 407.4 / 423.6 | 407.0 / 480.9 | 381.3 / 390.5 | 393.9 / 435.4 |
| Lua ready | 1515.4 / 1534.7 | 1538.5 / 1963.7 | 1357.7 / 1465.2 | 1362.5 / 1568.3 |

Artifact identity: baseline generation `5fcc4bba07a6eeb706fcadf4`, candidate
`30de8224d1cacecdf5b63b6e`, both based on source HEAD
`734de652ae57a139e8f1594621caff82d11a1ae2`. The candidate host-source diff hash
was `dba6cf08100a5d3634c83c22362d423ac1267d4ee2d1b9b01f1a338c76aa13ac`
(SHA-256 of binary Git diff for index.html/src followed by the NUL-terminated
new `src/startup.ts` path and its bytes); baseline's source diff was empty.
Shared payload manifest SHA-256:
`3a193a89c9b0f430e78691a02108a8d6702e4ae9fa30cc1e9ef90fc43864efb7`;
Wasm SHA-256: `54e0eba3ccd30aa894b7fbdab331d537a1ef4089c41ee390df15f37a88581638`;
native JS SHA-256: `cafaf3bcdd755c8d3c93265df544d8c927f6ae8971fb10d9c90fb1984b0003c4`;
payload provenance SHA-256: `7233f34a404430b0db3e00b11540f1e19643cdf3e9539aad8f0364fc737d1529`.
These are local materializations, not release authorization. The reproducible
[profiler protocol](METHODS_AND_EVIDENCE.md#reproduction-entry-points) records
the complete binary/provenance tuple and milestones without private build data.

Startup, lazy/eager/legacy/fallback, keyboard focus, demand/error/Reload,
comparison, About, header/fullscreen and end-to-end checks passed. Settled
initial canvas captures had zero pixel differences at DPR 1 and 2. The focused
helper boundary command is
`node tests/browser/test-helper-workers.mjs --boundaries-only` against the
development server; it covers mobile serial admission and helper-first payload
failure without rerunning unrelated sort/memory calibration.

## Homepage link launch

The PoB Codes homepage's **Browser PoB** action opens
`/browserpob/#build=<encoded pob.codes link>`. The measured boundary is
navigation start to the first frame of the imported build that is observed
after both the import completed and the startup surface was removed. It is
RAF-sampled, so every arm includes up to one frame of observation delay.

At editor `181d812`, a launch link waited for full startup, revealed the build
selector, and only then resolved the link through the API. The bridge then
initialized an unnamed build and re-initialized it through the import tab, while
helper workers booted alongside the import. Three cold live-site runs on the
machine below showed the selector at 2.4 s and the tree at 4.1 s (p50). A
separate live waterfall resolved the link in 424 ms after the selector appeared
and loaded 217 individual tree images during boot.

An in-memory Lua sampling overlay (one fixture, sampler disabled for wall
times) attributed the import as follows. The unnamed `Build:Init` took 572 ms,
319 ms of it in 248 parse-cache misses for concatenated mastery option lines
that `PassiveTree:ProcessStats` tries when a line does not parse alone. The
imported `Build:Init` took 434 ms (72 ms of misses), with the first calculation
about 55% of its samples, `BuildAllDependsAndPaths` about 33% and mastery
reprocessing about 17%. `Main:Init` took about 400 ms, of which about 300 ms
was loading the latest tree.

Candidates (c3 and the generated supplement are implemented in the working
tree; not yet released):

- **c1 (host):** resolve the link in parallel with runtime startup, import
  before revealing the editor, and do not boot helpers during that import.
- **c2 (host):** c1, plus prefetch of lazy packages named by the decoded launch
  build (tree version, and Timeless Jewel tables named in item text) after the
  startup packages load. The editor is attached before the hidden import so PoB
  lays out at the real canvas size, and is revealed after the import's first frame.
- **c3 (native bridge):** c2, plus `boot.lua` opening a decodable code from the
  selector with one `SetMode("BUILD", …, xml)` instead of an unnamed build and
  an import-tab re-initialization.
- **warm ModCache (overlay only):** 343 parse results captured from a run of
  this fixture appended in memory to `Data/ModCache.lua`. This is identical
  memoization of `parseMod`. Its 248 mastery-option entries are now generated
  at pack time; see [the supplement](#mastery-option-modcache-supplement).

Local loopback A/B on 2026-10-15: interleaved, alternating order, six cold
fresh-browser launches per arm, 1600x1000 DPR 1, headless Chrome 155, Ryzen 7
9800X3D, with the API resolver answered locally after 275 ms. Each cell is the
median and observed range in milliseconds; arms in different rows were measured
in different sessions.

| Session | Baseline | c1 | c1 + skip overlay | c2 | c3 | Warm ModCache added |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Overlay screening | 3,389 (3,351-3,611) | 3,138 (3,035-3,191) | 2,991 (2,899-3,149) | — | — | c1: 2,763; c1 + skip: 2,507 (2,389-2,678) |
| Final | 3,500 (3,345-3,761) | — | — | 3,256 (3,103-3,541) | 3,172 (2,968-3,238) | c3: 2,686 (2,520-2,868) |
| Implemented | 3,315 (3,172-3,580) | — | — | — | 3,038 (2,873-3,266) | c3 + generated supplement: 2,699 (2,534-2,959) |

The best measured combination is therefore about 23-26% faster on this machine.
The implemented combination (c3 plus the pack-time supplement, without this
fixture's own item rolls) was 19% faster than the baseline in the same session.
All runs were error-free. Final stats and tree framing matched the baseline
screenshot for this fixture; an earlier c1 that imported before attaching the
canvas laid the tree out at the worker's 800x600 default and was corrected.

Under Chrome network emulation (40 Mbit/s, 40 ms; five rounds) the medians were
baseline 10.37 s, c1 10.28 s and c2 4.67 s. Treat this as directional only: the
loopback test server is HTTP/1.1, and the demand-loaded 2.27 MB Lethal Pride
table queued behind the 217 image requests (requested at 4.3 s, finished at
9.8 s). Production HTTP/2/3 multiplexes those requests, so the real saving is
smaller. Live, the same package took 73 ms on a fast connection.

Remaining work, in measured order of size (the ModCache supplement is done):

1. Reduce import compute (first calculation, path building, quadratic mastery
   reprocessing). These need exact-behavior PoB patches; moving
   `ProcessStats` out of the mastery loop would change sticky `unknown`/`extra`
   flags and would not remove the unique misses.
2. Reduce Lua boot (about 1.1 s). See the generated representation below.
3. Network: add preload hints for the manifest and startup packages (live, the
   manifest was requested at about 320 ms and packages finished at about 870 ms),
   archive the tree images, and let the homepage prefetch the shell.

`tools/profiles/profile-link-import.mjs` reproduces these measurements against a
materialized release (`--release=`, `--build-file=`, `--link=`, optional
`--throttle=<Mbps>@<ms>` and in-memory `--overlay=`). `--production` is an explicit,
read-only live opt-in. The fixture is identified by its XML SHA-256
`898ff4d0152e9094befb95e3dc9c0983d9f2cd449d0f17017a76f6a171d614d6`.

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

### Mastery-option ModCache supplement

The first passive spec of a cold start builds every unallocated mastery's
option list. `PassiveTree:ProcessStats` retries option lines that do not parse
alone concatenated with the following lines. For tree 3_29 that requests 656
lines, of which 248 combination strings are missing from the shipped
`Data/ModCache.lua`; every one of them runs a full `ModParser` scan. A Lua
sampling overlay on a homepage link launch attributed 319 ms to them.

`npm run pack` now generates PoB's exact parse results for those lines and
appends them to the packaged cache. It proves every entry against PoB's
on-demand parser in the browser's Lua interpreter (see
[Bundled PoB changes](../BUNDLED_POB_CHANGES.md#generated-pob-data)). This adds
109,246 bytes uncompressed and 7,090 bytes to the compressed core package.
It covers mastery options only. Parse misses from a build's own item and
cluster-jewel rolls remain.

Local loopback A/B on 2026-10-15 measured a homepage `#build=` launch with
`tools/profiles/profile-link-import.mjs`, from navigation to the first visible
frame of the imported build. It used six interleaved rounds in alternating
order, a fresh browser per launch, a resolver answered after 275 ms, headless
Chrome 155.0.8059.41 at 1600x1000 DPR 1 and a Ryzen 7 9800X3D. All arms used
the same experimental host shell (link-launch candidate c3, not yet released)
and one build fixture (XML
SHA-256 `898ff4d0152e9094befb95e3dc9c0983d9f2cd449d0f17017a76f6a171d614d6`).
Only the payload differed. The in-memory overlay held these 248 entries plus 95
results captured from this fixture's own items. It is a probe, not a shipped
artifact.

| Arm | Payload manifest | Median (ms) | Range (ms) |
| --- | --- | ---: | ---: |
| c3 | `3a193a89…` (shipped ModCache) | 3,374 | 3,142-3,486 |
| c3 + generated supplement | `e22bfec8…` | 2,945 | 2,763-3,408 |
| c3 + captured in-memory overlay | `3a193a89…` + overlay | 2,728 | 2,626-3,069 |

The supplement saved 429 ms at the median, or 12.7%. The paired-round median
saving was 417 ms. Five of six rounds improved; the sixth was within 11 ms.
All 18 launches were error-free. This is one fixture on one machine; treat the
size of the saving as directional.

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
