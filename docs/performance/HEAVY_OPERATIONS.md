# Heavy-operation findings

This document covers work performed after the editor and build are initialized:
Power Reports, unique-item sorting, hover comparisons and responsiveness while
long calculations run. These are normally warm-engine operations even when an
individual harness labels the first operation “cold.”

## Power Report baseline and noise

The report A/A calibration ran five rounds and retained 40 target samples. On
the reference report its two identical arms measured:

| Operation boundary | Arm A median | Arm B median | Adopted noise floor |
| --- | ---: | ---: | ---: |
| First report on a loaded build (“cold report”) | 27.136 s | 26.630 s | 3.3918% |
| Repeated report on that build (“warm report”) | 26.916 s | 26.884 s | 3.0% |

These cold and warm report medians are nearly the same because application,
Wasm, Lua and build initialization occurred before the report timer. This is
evidence about report repeatability, not evidence that application cold startup
and a warm application cost the same.

## Skipping calculation stages a metric cannot consume

[PoB #10313](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313)
lets the node-power calculation omit Full DPS and eHP stages when the selected
metric cannot read them. The browser trial covered six rows, each with five
alternating pairs and three warm samples per arm: 240 measured samples total.
Heatmap and full-report snapshots matched exactly, errors were zero, and sampled
resume/memory limits passed.

| Row | Cold baseline → candidate | Warm baseline → candidate | Interpretation |
| --- | ---: | ---: | --- |
| R1 | 27.050 → 24.247 s (-10.36%) | 27.621 → 24.432 s (-11.54%) | Clear ordinary gain |
| R2 | 26.947 → 24.076 s (-10.65%) | 27.549 → 24.240 s (-12.01%) | Clear ordinary gain |
| R3 | 11.135 → 10.211 s (-8.30%) | 11.265 → 10.329 s (-8.30%) | Clear smaller-workload gain |
| R4 | 44.590 → 13.427 s (-69.89%) | 44.415 → 13.439 s (-69.74%) | Expensive irrelevant Full DPS stage removed |
| R5 | 43.857 → 43.460 s (-0.91%) | 44.319 → 43.776 s (-1.23%) | Within noise; needed stage retained |
| R6 | 26.894 → 26.926 s (+0.12%) | 27.376 → 27.292 s (-0.31%) | Within noise; needed stage retained |

The result is build- and metric-dependent by design. A large gain occurs only
when an expensive stage is both present in the build and irrelevant to the
requested metric. The similar cold/warm percentages show that this optimization
removes report work rather than application startup work. It is bundled in the
current source composite.

Related shipped PoB work includes:

- [PoB #10373](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10373),
  which skips cluster-passive work in Offence/Defence mode.
- The required local relevance-pruning patch, which avoids a redundant
  calculation when a node addition cannot affect the selected metric. It
  applies to serial and helper-backed reports.
- [PoB #10381](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10381),
  which makes cache keys context-correct. Treat this as a correctness boundary:
  never recover speed by merging radius-jewel, tattoo, Timeless/conquered,
  mastery, structured or post-parsing modifier contexts incorrectly.

## Browser helper delegation

Node-power evaluation consists of many independent candidate-node calculations,
which makes it suitable for the bounded browser helper pool. The original
accepted trial used eligible Hit DPS, depth 5 reports and three helpers.

| Measure | Serial baseline | Helper candidate | Change |
| --- | ---: | ---: | ---: |
| Full-report wall median, two alternating pairs | 27,207.92 ms | 7,977.15 ms | -70.68% |
| Lua median | 26,840.5 ms | 7,609.5 ms | -71.65% |
| Packaged confirmation, one pair | 28,213.53 ms | 8,495.09 ms | -69.89% |

Snapshots matched exactly and zero errors occurred. Each accepted run delegated
2,408 evaluations and retained 802 on the UI worker. The candidate waited for
the eager helper-ready handshake before beginning, so helper startup was outside
the timer. This is a report-throughput result, not an application-startup result.

The trial also documents the memory cost: three helpers were approximately
260,243,456 bytes each, UI peak Wasm capacity was 641,597,440 bytes, and the
conservative admission estimate was about 4.13 GiB against a 5.91 GiB budget.
Helper parallelism trades memory for elapsed time and must retain the aggregate
admission and retirement controls.

The shipped adapter has since expanded eligibility beyond the narrow measured
trial. It preserves serial fallback for small/unsupported/invalid work, uses PoB's
authoritative calculations and merge order, and has a diagnostic serial override.
Do not quote the ~70% result as proven for every metric, depth, browser, Timeless
family or helper count; remeasure the specific surface.

Unique-item sorting established the same pattern earlier: one retained result
improved from 15.221 s to 4.781 s with three helpers, or 68.6%. The current helper
pool is also used for eligible item-list hover comparisons. Exact tooltip,
PlayerStats, ordering, edit/reimport and canonical-export parity are mandatory,
because a fast stale comparison is a correctness failure.

## Caches and relevance reduction

The bundled PoB and browser adaptations also reduce repeated work:

| Change | Surface | Expected behavior |
| --- | --- | --- |
| PoB #10371 (now in the pinned dev base) | Item-stat sorting | Hidden equipment slots neither distort nor consume calculations |
| PoB #10372 | Unique-item sorting | Reuses results until the build changes; filter changes need not recalculate every item |
| Limited unique comparisons | Item editing/list operations | Bounds comparison work while preserving supported results and fallback |
| Calculation-only jewel specs | Radius-jewel comparison | Avoids authoring-only clone work in temporary calculation specs |
| Gem-hover tooltip patch | Gem selector | Avoids unnecessary repeated tooltip calculations |
| Item tooltip operation cache | Renderer/PoB bridge | Memoizes up to 64 supported operation sequences per build/calculator revision |
| Calculation scheduler | Editing | Coalesces only known numeric-control changes and flushes before consumers that require completed outputs |

Many of these have correctness and invalidation tests but no isolated public
percentage. Describe them as shipped mechanisms, not quantified gains.

## Rejected or archived experiments

### Heatmap-first report builder

A prototype separated visible heatmap readiness from full list completion.

| Scenario | Baseline → candidate | Result |
| --- | ---: | --- |
| Hidden Hit DPS heatmap, 40 samples | 27.598 → 8.998 s cold; 28.329 → 9.178 s warm | About 67% earlier colors; full list intentionally absent |
| Shown full report, smoke | 27.230 → 27.229 s | No complete-report gain |
| Hidden then open full report, smoke | 27.209 → 27.820 s | Deferred completion regressed |
| Offence/Defence, smoke | 11.116 → 10.693 s | Small gain; skipped allocated/cluster groups |

The experiment was declined because the valued complete-report boundary was not
faster. Keep it as a lesson: report an early milestone separately and never call
it an end-to-end speedup unless the product accepts the changed contract.

### Navigation responsiveness during reports

An archived prototype yielded more often while helpers calculated. Across three
alternating cold/warm pairs it reduced median per-run measured input p95 from
83.605 to 31.835 ms cold and 84.950 to 31.300 ms warm, improvements of 61.9% and
63.2%. However, report wall time increased 17.9%/19.6% and CPU increased about
15.7%. The measurement ends at a CPU frame callback, not GPU presentation or
input-to-photon latency.

A 144 Hz pacing prototype saved only 4.8% CPU, left report time unchanged and
worsened p95 from 32.0 to 34.1 ms. Pacing was omitted. The responsiveness branch
was archived as commit `f8f3e28`; it is not installed on current `main`.

This is the clearest latency/throughput warning in the evidence: always report
input delay, operation wall time, CPU and frame cadence together.

## Practical optimization order

For a slow report, sort or comparison:

1. Confirm the requested output and completion boundary.
2. Identify whole stages or candidates that provably cannot influence it.
3. Verify cache keys and invalidation before adding reuse.
4. Delegate independent calculations only after serial parity is exact.
5. Include helper startup and memory if the user-visible scenario pays them.
6. Measure responsiveness separately; yielding can make the UI smoother while
   making the operation slower.
