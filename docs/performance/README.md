# Performance knowledge base

This directory is the durable starting point for performance work in the Build
Editor. It consolidates the conclusions that were previously spread across
pull requests, benchmark reports, experiment decisions, local task notes and
`tmp/` evidence. Raw local evidence remains useful for audit, but an agent
should not need ignored files to learn what is already known.

The measurements summarized here are tied to the repository identities named
in [Methods and evidence](METHODS_AND_EVIDENCE.md). Re-measure after a PoB pin,
runtime, browser, payload or fixture change.

## Start here

- [Cold start](COLD_START.md) explains first-load and first-import latency.
- [Heavy operations](HEAVY_OPERATIONS.md) covers Power Report, unique sorting,
  hover comparisons and interaction responsiveness.
- [Runtime and rendering](RUNTIME_AND_RENDERING.md) separates Wasm/native,
  Lua-memory, filesystem, browser-worker and renderer work.
- [Methods and evidence](METHODS_AND_EVIDENCE.md) defines cold/warm boundaries,
  claim strength, benchmark rules and the source-evidence index.
- [Bundled PoB changes](../BUNDLED_POB_CHANGES.md) is the authoritative shipped
  overlay and adapter inventory. This directory explains performance outcomes;
  it does not replace that source ledger.

## Executive summary

1. **Cold startup is not mainly Wasm instantiation or calculation arithmetic.**
   In the four-fixture cold profile, Wasm initialization was about 15-17 ms and
   target calculation about 57-140 ms, while helper boot, PoB module/data/tree
   construction, import/hydration and unique-catalog construction consumed most
   of a 3.1-4.1 second first result. The best measured low-risk cold improvement
   so far is batched source loading: roughly 6% in the headless four-fixture
   matrix and about 7% in a directional ordinary-app smoke. See
   [Cold start](COLD_START.md).

2. **The largest warm-operation gains came from doing less correct work or
   parallelizing independent work.** Skipping Full DPS/eHP stages that a metric
   cannot read saved 8-12% on ordinary cases and about 70% on a fixture with an
   expensive irrelevant Full DPS stage. Browser node-power helpers reduced one
   eligible Hit DPS report by about 70%. Unique-item helper delegation had a
   similar 68.6% precedent. See [Heavy operations](HEAVY_OPERATIONS.md).

3. **“PoB” and “Wasm” are not interchangeable performance surfaces.** The PoB
   Lua program runs inside the Wasm-hosted Lua runtime, but most observed cold
   time is PoB code building Lua data and object graphs. Wasm module creation is
   a small phase. Native/runtime changes still matter for file crossings and
   value density, while browser changes matter for scheduling, workers and
   rendering. See [Runtime and rendering](RUNTIME_AND_RENDERING.md).

4. **Cold and warm results usually answer different questions.** Cold startup
   uses a fresh browser process/profile, worker, Wasm instance and Lua state.
   A “cold Power Report” in the report harness means the first report on an
   already loaded build, not application startup. Warm report, sort and hover
   trials reuse initialized state. Do not compare these labels without the
   operation boundary. See [Methods and evidence](METHODS_AND_EVIDENCE.md).

5. **Partial readiness is not full completion.** A heatmap-first prototype made
   colors available about 67% sooner but left complete report time unchanged;
   it was declined. Similarly, calculation-only cold requests can be much
   faster because they omit the authoring catalog, but that is a different API
   contract. Report both the milestone and the complete-work boundary.

## Cold versus warm scorecard

| Scenario | Most useful measured gain | What it says | Status |
| --- | ---: | --- | --- |
| Cold application engine, complete first result | Historical JS read-ahead ~6%; native buffered loading ~4-6% headless | Small-read transport matters; current-baseline JS confirmation failed noise admission | [JS declined](READ_AHEAD_DECISION.md); native experiment |
| Cold ordinary app, first complete import | Native buffering ~7% median | Directional support from two pairs/one fixture | Experiment smoke |
| Cold input-aware initialization | 1.29-2.24% | Avoiding the unnamed/default build alone is small | Experiment, not promoted |
| First Power Report on an already loaded build | Stage pruning 8-70%; eligible helpers ~70% | Report cost is PoB stage/evaluation work, not Wasm startup | Shipped mechanisms |
| Warm repeated Power Report | Stage pruning had nearly the same 8-70% pattern | The removed work repeats; benefit is not a cold-only cache effect | Shipped overlay |
| Warm unique sort | Compact Lua values 10.2%; three helpers 68.6% in a retained comparison | Memory density helps modestly; parallel independent work helps much more | Shipped mechanisms, different trials |
| Warm heatmap | Compact Lua values 2.1% | Runtime representation has a small measured effect | Shipped runtime |
| Interaction during a long report | Callback p95 ~62% lower, but report ~18-20% slower | Responsiveness and throughput are independent objectives | Archived, not shipped |

The word “cold” in the Power Report harness means the first report after build
load. It is not comparable to a cold application process. See the taxonomy in
[Methods and evidence](METHODS_AND_EVIDENCE.md).

## Surface map

| Surface | What it owns | Main observed cost or opportunity | Best current evidence |
| --- | --- | --- | --- |
| Network/static delivery | HTML, JS, Wasm and packed Lua packages reaching the browser | Real network and cache state; not isolated by local engine profiles | Benchmark separately under representative network conditions |
| Browser shell | Worker creation, package broker, input scheduling, progress and lifecycle | Coordination, repeated message/file crossings and main-worker responsiveness | File read-ahead cut read RPCs from 5,122 to 417 in one matrix; responsiveness changes trade throughput for latency |
| Wasm/native runtime | Module instantiation, C bridge, allocator, Lua representation and file API | Wasm instantiation itself is small; file-call granularity and memory density are useful surfaces | ~15 ms Wasm initialization; native buffered loading ~4-6% headless; compact values -15.3% private commit |
| PoB initialization | Lua modules, static data, latest/target passive trees, default build and UI models | Largest cold-engine surface | Helper boot ~1.6 s; import/hydration ~0.9 s mean; catalog ~0.64 s mean |
| Target build calculation | Imported build hydration and calculation graph | Fixture-dependent; arithmetic is a minority of first-result time | Target calculation 57-140 ms in the balanced cold matrix |
| PoB heavy operations | Power Report, item comparison and unique sorting | Repeated independent evaluations and irrelevant stages | Stage pruning 8-70%; helpers ~69-71% on eligible trials |
| Renderer | Draw-list transfer, images, text measurement, unchanged frames and culling | Redundant work and retained caches | Shipped PRs reuse images/frames, cull offscreen commands and cache text widths; numeric effects were not isolated per PR |
| Interaction | Input-to-callback delay and work yielded between frames | Responsiveness can improve while total wall/CPU regresses | Archived prototype cut measured p95 delay ~62% but slowed reports ~18-20% |

## Current priorities supported by evidence

- Browser startup uses a centered segmented loading bar until the attached editor
  supplies its first real frame. Readiness is event-driven instead of polled
  every 100 ms. The [built-artifact startup trial](COLD_START.md#browser-startup-presentation-and-readiness)
  separates that host delay from unchanged PoB initialization. Tree rendering
  remains unchanged pending a representative input/presentation diagnosis.

- For a materially faster cold engine, test a generated/hydrated representation
  for `Modules/Data`, `Data/ModCache` and demanded passive-tree structures. The
  input-aware startup experiment saved only 1-2%, showing that avoiding the
  unnamed initial build is not the dominant remaining cost.
- For a smaller cold improvement, revalidate native file buffering before
  considering integration; it applies to every runtime, including helpers.
  [JavaScript read-ahead is declined](READ_AHEAD_DECISION.md): current-baseline
  main-only and all-worker trials did not clear the frozen acceptance gates.
- For Power Report and sort work, first eliminate irrelevant calculations and
  then use the bounded helper pool where evaluations are independent and merge
  semantics remain exact.
- For UI smoothness, measure operation wall time, CPU, input delay and completed
  frames together. Do not accept a latency improvement that hides a large
  throughput or memory regression.

## How to update this knowledge base

When a performance experiment or optimization finishes:

1. Add the result to the surface document, including the exact completion
   boundary, fixture coverage, sample count and whether it shipped.
2. Add the evidence location and identities to
   [Methods and evidence](METHODS_AND_EVIDENCE.md). Summarize durable conclusions
   here even if raw reports remain ignored.
3. Label modeled projections, directional smokes, accepted experiments and
   shipped results distinctly.
4. Preserve negative results. A rejected idea prevents agents from repeating an
   attractive but already falsified experiment.
5. If shipped source ownership changes, update
   [Bundled PoB changes](../BUNDLED_POB_CHANGES.md), `source-pin.json` and
   `upstream/PROVENANCE.md` as required; this directory is not a source ledger.
