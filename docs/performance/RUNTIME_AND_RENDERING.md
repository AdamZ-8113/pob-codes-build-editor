# Runtime, Wasm and rendering findings

The editor has several nested layers: the browser host starts workers and moves
packages; an Emscripten/Wasm native layer hosts Lua and bridges drawing/files;
the PoB Lua program loads data and performs calculations; JavaScript/WebGL draws
the resulting commands. A change in one layer should not be described as a
change in another.

## Wasm is the container, not the whole backend

The balanced cold profiles measured Wasm initialization at roughly 15 ms per
fixture, about 0.5% of a coarse 3.75 second first result. This phase is module
instantiation. It does not include PoB Lua modules executing inside that Wasm
instance, building tables/trees, importing the build or calculating outputs.

Therefore:

- “Wasm starts quickly” does not mean “the PoB backend starts quickly.”
- A Lua or PoB algorithm can dominate while still running inside Wasm.
- Replacing formula arithmetic with Rust/C++ would not remove data/tree/UI model
  construction unless the rewrite also owns those representations and semantics.
- Native changes can still help high-frequency bridge calls, memory layout,
  allocation and file-read granularity.

## Native/Lua runtime results

### Compact Lua values and allocator

The bundled runtime enables the vendored Lua implementation's `LUA_NANTRICK`
little-endian representation, so tagged Lua values occupy 8 bytes on wasm32
instead of 16. It uses the growable mimalloc heap and retains the 2 GiB Wasm
ceiling. Numeric/table/GC tests cover NaN, infinities, signed zero, subnormals,
large exact numbers and the project's parser behavior. A runtime switch can
restore the wide representation for diagnostic A/B comparisons.

Manual Windows acceptance and final-build remeasurement found:

| Metric | Candidate change |
| --- | ---: |
| Median whole-browser private-commit peak | -15.3% |
| Warm unique sorts | 10.2% faster |
| Heatmaps | 2.1% faster |

The measured dlmalloc alternative was rejected and removed. These results show
that memory density can improve warm, allocation-heavy operations even though it
does not eliminate PoB initialization work.

### File bridge and source loading

Cold source profiles found thousands of small reads crossing the broker/runtime
boundary. In the final matrix, native 256 KiB buffering reduced median reads from
5,122 to 777 without changing delivered bytes and saved a median 180 ms headless.
JavaScript read-ahead reduced reads to 417 with a modest over-read and saved
222 ms. These are historical measurements. JS read-ahead was subsequently
[declined after current-baseline confirmation](READ_AHEAD_DECISION.md);
see [Cold start](COLD_START.md) for the older result and caveats.

This is a runtime/transport optimization whose visible effect occurs while PoB
loads source. It should not be called a calculation-kernel improvement.

### Native bridge work without isolated percentages

The bundled driver also:

- retains and geometrically grows draw-command storage instead of allocating
  temporary command/text buffers repeatedly;
- dynamically indexes and interns image resources;
- caches text widths with collision checks, an LRU bound of 4,096 entries and a
  1 MiB text cap; and
- records bounded runtime diagnostics for startup, bridge calls, draw buffers,
  Wasm capacity, filesystem reads and image decoding.

These mechanisms have focused regression and pixel/behavior coverage. Unless a
result is added to the evidence ledger, do not invent an aggregate percentage or
attribute an end-to-end run to one of them.

## Browser startup and worker layer

[pob-web #224](https://github.com/atty303/pob-web/pull/224) overlaps independent
font, data and Wasm loading and restores streaming instantiation with an
ArrayBuffer fallback. This reduces avoidable serialization in the browser shell.
It is separate from the later PoB initialization that dominates the local cold
profile. Network latency and cache state were not represented by the local
prefetched-transform matrices, so benchmark real delivery separately.

The application also uses lazy, integrity-checked data packages. Background
package requests do not automatically represent user-blocking time; record which
package and readiness boundary a startup result waits for. Helper workers consume
additional startup and memory but can reduce long parallel operations after they
are ready.

## Renderer work

The following submitted pob-web changes are bundled here:

| PR | Mechanism | Surface and expected effect |
| --- | --- | --- |
| [#220](https://github.com/atty303/pob-web/pull/220) | Align glyph bitmaps to physical pixels | Sharper text without changing layout; visual quality, not a speed claim |
| [#221](https://github.com/atty303/pob-web/pull/221) | Intern/reuse matching images and coalesce loads | Prevent repeated loads, idle redraw requests and texture/cache growth |
| [#222](https://github.com/atty303/pob-web/pull/222) | Cull wholly offscreen static quads | Reduce draw transfer/GPU work, especially on the passive tree |
| [#223](https://github.com/atty303/pob-web/pull/223) | Reuse an unchanged rendered frame | Avoid rebuilding and resubmitting identical draw commands while idle |
| [#224](https://github.com/atty303/pob-web/pull/224) | Parallel startup prerequisites and streaming Wasm | Browser startup scheduling |
| [#225](https://github.com/atty303/pob-web/pull/225) | Compact Lua values | Runtime memory and allocation-heavy warm work |
| [#226](https://github.com/atty303/pob-web/pull/226) | Native text-width cache | Avoid repeated Wasm-to-JavaScript measurement crossings |

The renderer also disables WebGL2 multisample antialiasing because Chrome's
multisampled blended triangles produced visible seams on solid dark panels.
That is a correctness/visual decision, not a general performance result.

### Passive-tree dragging

The `treeConnectorCulling` adapter rejects offscreen connectors before PoB
selects colors/artwork, transforms vertices and emits native draw commands.
Bounds are computed with connector geometry, contain all three artwork states,
and cover each half of split arcs. The view uses PoB's logical full-screen size
(including DPI overrides), with a two-pixel margin. Invalid bounds retain the
original path. Asset drawing also rejects images outside the logical screen,
using complete extents rather than node centers. Hit testing, tree editing,
search-edge markers, tooltips and jewel-radius calculations remain live.

Ordinary drags retain the world-artwork commands once, then translate and cull
them in the native driver. The first eligible frame captures the complete tree,
including offscreen artwork that can enter view later. The tiled background and
jewel radii remain live. Hovered nodes, searches, comparison builds, heat maps,
tracing, modifier keys, input events, popups and pending build edits use the live
path. A new revision, spec/tree, scale, viewport, DPI or texture identity forces
a rebuild; mouse release frees storage. Hosts without the optional cache API
keep ordinary PoB drawing. The recording limit is four MiB; the public fixture
uses two MiB of native buffer capacity while dragging. Original double
coordinates are retained so translation precedes float/DPI conversion and does
not accumulate rounding drift. GPU buffers and the rendering protocol are
unchanged.

The native bridge also emits parsed color escapes as the existing five-byte
RGBA command, avoiding a temporary allocation/copy/free and a second parse in
JavaScript. Eight-character hex colors formerly occupied eleven command bytes.
Lua's floating-point color state and the exact rendered palette are preserved;
in particular indexed `^8` remains byte value 179 while numeric 0.7 retains its
existing truncation to 178.

`tests/browser/test-tree-connector-culling.mjs` reverses the exact Lua patch in
memory for its baseline and keeps the same native binary in every run. A third
arm disables retention while keeping culling, isolating command-reuse savings.
It uses the public guided-import fixture, a 1600×1000 viewport, Chrome headless,
DPR 1/2, three zoom/camera positions and three drag rounds per position. Mouse
events are dispatched inside the page every 8 ms, avoiding per-move Playwright
RPC waits. CPU timings include Lua/native and renderer work, not presentation
latency. Captures freeze only PoB's animation clock. The harness checks the
existing 0.1% pixel tolerance both at rest and during translated drags, fewer
native command bytes, actual cache replays, mouse-up cleanup, unchanged player
stats and no runtime errors; timing is reported rather than used as a flaky
absolute CI threshold. LuaJIT/Busted covers connector bounds and retained PoB
tree specs, cache invalidation and asset bounds. Native tests cover all color
byte values, translated command parity, state/scale/texture invalidation,
offscreen artwork entering view, memory limits, allocation failure and cleanup.

For the initial connector-only change on 2026-10-22, Chrome 155.0.8059.85 on
Windows produced the following medians
of three per-round median worker-frame times (milliseconds):

| View | DPR 1, original → culled | DPR 2, original → culled | Native command bytes, original → culled |
| --- | ---: | ---: | ---: |
| Overview | 8.47 → 8.09 | 8.17 → 8.29 | 577,137 → 545,731 |
| Three zoom steps closer | 8.57 → 7.95 | 8.45 → 7.22 | 579,934 → 421,100 |
| Six zoom steps closer | 8.43 → 6.13 | 8.43 → 6.34 | 579,934 → 356,238 |

The closest view saved about 25–27% of worker-frame work and 39% of command
bytes; overview timing was effectively flat. All six scenes had zero pixels
above the existing two-channel-value difference threshold. These results isolate
connector culling with packed colors in both arms; they do not quantify the
additional color-encoding gain or claim an input-to-photon improvement. This is
a one-fixture local result, not a universal device or build guarantee.

The subsequent retained-command implementation, measured with the same browser
and public fixture, produced these medians of three drag-round medians. Both
arms below include connector/asset culling and packed colors; only retention
differs:

| View | DPR 1, live → retained (ms) | DPR 2, live → retained (ms) |
| --- | ---: | ---: |
| Overview | 8.42 → 2.61 | 8.54 → 2.50 |
| Three zoom steps closer | 7.19 → 2.80 | 7.26 → 2.73 |
| Six zoom steps closer | 6.08 → 2.47 | 6.01 → 2.30 |

This saved about 59–71% of worker-frame work beyond the live culling path.
All six resting scenes matched exactly above the two-channel-value threshold.
All nine DPR-1 drag captures also matched; DPR-2 drag captures differed by 0–123
pixels, below 0.003% and the unchanged 0.1% tolerance. Each adapted context
recorded over 2,100 replays, no native replay misses, and zero retained buffer
capacity after mouse release. The first eligible frame still builds the cache;
these steady-drag medians do not describe capture cost, GPU presentation latency,
or the dynamic modes that intentionally use live drawing.

### What renderer profiles can and cannot prove

The startup host retains its own loading bar in a separate mount until both
DOM attachment and a nonzero-instance canonical frame complete. The native
canvas then fills the same viewport and receives initial keyboard focus unless
the user has focused another control. Settled baseline/candidate canvas captures
on 2026-10-14 had zero changed pixels at DPR 1 and DPR 2. Demand loading and
terminal payload errors still use the existing progress/Reload panel.

This does not optimize passive-tree motion. The current interaction profiler
serializes mouse moves with 16 ms waits, so completed-frame gaps include the
driver's input cadence. Worker duration includes the Lua callback and rendering;
subtracting render time leaves Lua/bridge work, not isolated Lua or GPU time.
Whole-command reuse avoids renderer submission but still executes Lua. No
authoritative active-tree/camera bridge is exposed to a browser transform.
Before proposing retained layers or a presentation transform, reproduce the
reported symptom on the relevant browser/DPR and identify removable input,
worker, renderer or presentation cost. Use actual dispatch timestamps and a
relative baseline improvement; an already-passing absolute frame budget cannot
establish a benefit. The connector-specific harness above instead compares
identical input paths against the original PoB draw path.

Animation-frame callback and worker tick timing measures scheduled CPU work. It
does not directly measure scan-out, compositor latency, GPU presentation or
human input-to-photon delay. Pixel comparisons prove rendered equivalence at
sampled times and DPRs, not that every device performs identically.

For renderer changes record at least:

- stable-frame CPU and completed-frame gap;
- draw command count/bytes and bridge crossings;
- image/texture and text-cache counts;
- viewport, DPR, browser version and whether the run is headless;
- fixed-time pixels for geometry/text changes; and
- operation wall time when rendering overlaps a calculation.

## Memory scopes

Do not compare unlike memory values:

- `luaKiB` is allocator-accounted Lua memory, not total Wasm or process memory.
- Wasm capacity is reserved/committed linear-memory capacity, not live objects.
- Whole-browser private commit includes browser, workers and supporting process
  memory and is the best available aggregate for admission decisions.
- Per-helper capacity multiplied by helper count is only part of the total; use
  the pool's conservative aggregate admission model.

The compact-value result used whole-browser private commit. Power-report helper
trials reported UI and per-helper Wasm capacities plus a conservative aggregate.
Keep those scopes explicit when comparing changes.

## Where to change what

| Symptom | First owner to inspect |
| --- | --- |
| Long time before the worker/runtime exists | Browser module loading, broker, fonts, Wasm fetch/instantiate |
| Runtime exists but first build is still loading | PoB Lua modules, data/tree construction, catalog and import |
| Thousands of tiny reads | Native file API; [JS read-ahead declined](READ_AHEAD_DECISION.md) after current-baseline confirmation |
| High memory in every Lua-heavy worker | Lua value layout, GC policy, representations and helper count |
| Slow node report or unique sort | PoB relevance/stages, cache correctness, helper delegation |
| High idle renderer CPU | Frame reuse, redraw causes, image load completion and animation state |
| High draw traffic while panning | Offscreen culling, draw buffer and command generation |
| Repeated text-measure bridge calls | Native text-width cache and invalidation |
