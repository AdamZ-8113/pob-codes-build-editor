# Performance methods and evidence index

This file defines how to read and extend the performance claims in this
repository. It also maps durable conclusions to their original pull requests,
plans, reports and benchmark output.

## Evidence strength labels

Use these labels when adding or quoting a result:

| Label | Meaning |
| --- | --- |
| Shipped | Present in the current bundled source/runtime. This says nothing by itself about the breadth of measurement. |
| Accepted experiment | Passed its stated correctness/resource gates with a balanced comparison, but may not be productionized. |
| Directional | Small sample, one fixture, smoke, or environment-specific result. Useful for choosing the next test, not a population claim. |
| Modeled | Projection built from measured phases and assumed removable shares. Not an achieved result. |
| Rejected/declined | Tested and found incorrect, too small, too costly, or valuable only under a changed completion contract. |
| Archived | Working implementation/evidence retained outside current `main`; not shipped. |

“Submitted PR” and “shipped” are different facts. The source authority for what
is actually bundled is [Bundled PoB changes](../BUNDLED_POB_CHANGES.md),
`source-pin.json` and `upstream/PROVENANCE.md`.

## Required identity

Every retained comparison should record:

- editor commit and dirty/untracked state;
- PoB revision, composite result identity and applicable patch/adapter hashes;
- driver/native Wasm and payload manifest identity;
- fixture SHA-256 or a privacy-safe opaque hash;
- browser name/version/channel, Node/Deno versions where applicable;
- OS, CPU, physical/logical cores and memory;
- viewport, device-pixel ratio and headless/headful mode;
- helper count, admission outcome, runtime options and diagnostic overrides;
- exact command, arm order, sample count, exclusions and timeout; and
- the measured start/end event, not only a friendly label such as “startup.”

The principal October 11-12 cold investigations used editor
`ad6f78ee712d566e1fea5407c0adfda00c05a26d`, PoB
`a431f3a28823270acbdd6864c644f93678581f1e`, and composite result tree
`be02a4d0fdde4fa194fceac935b744988f4ce5af`. Do not silently combine their
numbers with a newer pin.

## Cold and warm taxonomy

Always name both the state and operation:

| Term | Required meaning in these docs |
| --- | --- |
| Cold application/startup | Fresh browser process/profile, broker, worker, Wasm and Lua state through a named ready/import boundary. State server/OS/network cache treatment separately. |
| Warm application | Existing initialized browser/runtime; may still import a new build. Describe what is retained. |
| Cold operation | First invocation of a specific report/sort/hover after the build is already loaded. This is not application startup. |
| Warm operation | Repeated invocation that may reuse PoB/browser caches, helpers and allocated memory. Describe mutations between repetitions. |
| First result | First complete response under the request's declared contract. A calculation-only result and an authoring-ready editor are different contracts. |

For startup, useful named milestones include navigation start, worker created,
filesystem/packages ready, Wasm instantiated, Lua ready, helper boot complete,
target imported, target calculated, authoring catalog ready and result delivered.
For Power Report, distinguish heatmap-ready from full-report-ready.

## Correctness gates

Performance is accepted only after the behavior contract passes. Select the
strongest applicable checks:

- exact typed MAIN/CALCS player and minion outputs, including non-finite tags;
- active skill, Full DPS enrollment, materials and warnings;
- exact heatmap and full-report snapshots;
- complete tooltip lines, score/order and edit/reimport behavior;
- canonical XML/export plus saved player statistics;
- pixel comparisons for rendering/layout changes;
- cache invalidation, cancellation, stale-reply and fallback behavior;
- balanced opens/closes, no retained read-ahead windows or descriptors;
- helper memory admission, retirement and aggregate whole-browser bounds; and
- source/payload/driver hashes before and after isolated experiments.

Exact calculation-output parity is narrower than identical internal engine
state. Canonical exports do not cover every transient calculation table. State
the oracle's boundary instead of saying only “parity passed.”

## Statistical and timing rules

- Alternate baseline/candidate order. Use balanced AB/BA order when practical.
- Prefer at least three pairs for a claim; use more when the effect approaches
  the noise floor. Label smaller smokes directional.
- Keep arms on the same machine and serialize CPU/memory-heavy samples.
- Report per-fixture values, the aggregation method and paired ranges. A
  geometric ratio is appropriate for multiplicative cross-fixture aggregation.
- Run an A/A calibration when timing noise is material. The retained Power
  Report calibration adopted 3.3918% cold-operation and 3.0% warm-operation
  floors for its matching environment only.
- Never subtract an after-the-fact diagnostic delay to repair a timer. Move the
  diagnostic outside the boundary and rerun, as the cold app smoke did.
- Explain exclusions. Setup failures may be excluded only when they precede the
  measured behavior and the corrected run is retained; mismatches are results,
  not removable outliers.
- Record median and p95 where latency distributions matter. For paired operation
  duration, retain every pair in raw evidence.

Animation-frame callbacks and worker responses measure scheduled CPU progress,
not GPU presentation or input-to-photon latency. Local prefetched/server-cache
tests do not represent WAN download. Memory sampling can miss transient peaks.

## Durable result ledger

| Finding | Evidence level | Production status | Durable source |
| --- | --- | --- | --- |
| Cold first result dominated by PoB/data/tree/helper/import work; Wasm init ~15-17 ms and calculation union ~80.5 ms | Accepted profile | Diagnostic knowledge | [Cold start](COLD_START.md) |
| JS read-ahead ~6% headless; native 256 KiB buffering ~5.6% headless; ordinary-app native smoke ~7% | Accepted experiment plus directional app smoke | Not established as shipped | [Cold start](COLD_START.md) |
| Input-aware initialization alone 1.29-2.24% | Accepted experiment | Not promoted | [Cold start](COLD_START.md) |
| Full bytecode not consistently better and adds ~3.7-4.0 MiB | Rejected experiment | Not shipped | [Cold start](COLD_START.md) |
| PoB #10313 stage pruning 8-12% normally and ~70% on an expensive irrelevant Full DPS case | Accepted 240-sample browser matrix | Shipped overlay | [Heavy operations](HEAVY_OPERATIONS.md) |
| Node-power helpers ~70% on measured eligible Hit DPS/depth 5 case | Accepted bounded trial and packaged confirmation | Shipped; eligibility later broadened | [Heavy operations](HEAVY_OPERATIONS.md) |
| Heatmap-first colors ~67% sooner but full completion unchanged | Accepted partial-milestone evidence; declined | Not shipped | [Heavy operations](HEAVY_OPERATIONS.md) |
| Yielding prototype p95 callback delay ~62% lower but report wall ~18-20% slower | Accepted bounded trial; archived | Not on current `main` | [Heavy operations](HEAVY_OPERATIONS.md) |
| Compact Lua values: private commit -15.3%, warm sorts +10.2%, heatmaps +2.1% | Manual Windows acceptance | Shipped runtime | [Runtime and rendering](RUNTIME_AND_RENDERING.md) |
| Renderer image/frame/culling/text caches reduce redundant work | Mechanism and correctness coverage; no isolated percentage | Shipped | [Runtime and rendering](RUNTIME_AND_RENDERING.md) |
| Generated IR/native architecture gains of 26-39%/33.5% | Modeled only | Unimplemented | [Cold start](COLD_START.md) |

## Original evidence index

### Tracked, public sources

| Source | What it establishes |
| --- | --- |
| `README.md` | User-facing inventory of submitted PoB and pob-web improvements |
| `docs/BUNDLED_POB_CHANGES.md` | Authoritative bundled PoB overlays and browser-only source adapters |
| `upstream/PROVENANCE.md` | Detailed runtime, renderer, worker, memory and adapter provenance |
| `source-pin.json` | Exact PoB revision, ordered adapters, patch identities and result hashes |
| `tools/profiles/` | Reproducible public startup, hover, sort, interaction and memory profiles |
| `reports/benchmark/` | Ignored output from `npm run bench`; review for private inputs before sharing |
| `tools/experiments/` | Retained test-backed experiment implementations; not production entry points |
| `patches/` and `scripts/patches/` | Shipped source transforms and exact drift/identity checks |

Relevant landed history includes:

| Commit/PR | Outcome |
| --- | --- |
| `22ecf20` / PoB #10313 overlay | Bundled unused Full DPS/eHP stage skipping |
| `f7e4a65` / editor PR #2 | Enabled browser node-power helpers after the ~70% eligible trial |
| `f058679` | Bundled Power Report relevance pruning |
| `a1001dd` / PoB #10381 | Bundled context-correct Power Report caching |
| `6b84f09`, `26d584e`, `2794771` | Broadened helper coverage/responsiveness and adjusted bounded memory policy |
| `9a93007` | Runs eligible item-list hover comparisons in background helpers |
| `f8f3e28` | Archive commit for the navigation responsiveness experiment; not current main behavior |

### Local-only plans and decisions

The repository intentionally ignores `to_do/`, `tmp/` and related operating
artifacts. They may exist in a maintainer checkout but are not guaranteed in a
clean clone. Their durable technical conclusions are copied into this directory.
When present, these are the most useful audit entry points:

| Local path | Content |
| --- | --- |
| `to_do/completed/cold-calculation-architecture-research.md` | Research scope and architecture alternatives |
| `tmp/cold-calculation-architecture-research/2026-10-11T233432-379Z/recommendation.md` | Critical-path phases, source inventory, maintenance probe and modeled recommendations |
| `tmp/compiled-calcs-expanded/2026-10-11/decision.md` | Accepted read-ahead/native-buffer matrices, app smoke, bytecode findings and correctness limits |
| `tmp/compiled-calcs-expanded/2026-10-11/*/raw.json` and `summary.md` | Per-sample cold-start evidence and generated summaries |
| `to_do/completed/power-report-speed/00-browser-ab-harness.md` | Power Report A/A noise calibration and harness contract |
| `to_do/completed/power-report-speed/01-skip-unneeded-ehp-full-dps.md` | PoB #10313 experiment/adoption decision |
| `tmp/power-report-speed/01/acceptance.json`, `r1.json`…`r6.json` | 240-sample stage-pruning matrix and resource checks |
| `to_do/wont do/power-report-speed/02-heatmap-first-power-builder.md` | Declined heatmap-first decision and partial-readiness lesson |
| `tmp/power-report-speed/02/` | Heatmap-first H1 and smoke evidence |
| `to_do/completed/power-report-speed/03-helper-worker-node-power.md` | Helper delegation trial, adoption and release record |
| `tmp/power-report-speed/03/acceptance.json`, `w1-fixed.json`, `bundled.json` | Accepted helper and packaged confirmation evidence |
| `to_do/completed/power-report-navigation-responsiveness.md` | Archived latency/throughput investigation |
| `tmp/navigation-power-research/final-summary.json` and `summary.json` | Final responsiveness and cadence summaries |

The October 12 input-aware experiment was executed in a managed worktree rather
than this checkout. Its retained decision reported editor/PoB/composite identities,
16-pair equal-contract and 16-pair ordinary results, exact typed parity, and no
commit/push. The implementation paths were
`tools/experiments/compiled-calcs/expanded/` plus the focused
`tests/unit/compiled-calcs-bootstrap.test.mjs` in that worktree. The durable
outcome is recorded in [Cold start](COLD_START.md); do not assume those files are
tracked or shipped in the current checkout.

### Pull requests represented in the findings

PoB calculation/UI overlays:

- [#10360](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10360)
- [#10371](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10371)
- [#10372](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10372)
- [#10373](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10373)
- [#10313](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313)
- [#10381](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10381)
- calculation-only portion of
  [#9863](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/9863)

pob-web runtime/renderer submissions:

- [#220](https://github.com/atty303/pob-web/pull/220) through
  [#226](https://github.com/atty303/pob-web/pull/226), individually summarized
  in [Runtime and rendering](RUNTIME_AND_RENDERING.md).

Build Editor helper adoption:

- [editor #2](https://github.com/AdamZ-8113/pob-codes-build-editor/pull/2).

## Reproduction entry points

The public aggregate recipe is [Benchmarking](../BENCHMARKING.md). Common
profiles include:

```text
npm run bench
node tools/profiles/profile-startup.mjs
node tools/profiles/profile-item-hover.mjs
node tools/profiles/profile-gem-hover.mjs
node tools/profiles/profile-unique-memory.mjs
node tools/profiles/profile-interactions.mjs
```

Some experiment commands require prepared/packed runtime assets and are not
production interfaces. Read the experiment's `--help`, focused tests and local
decision before running it. Store disposable output in an owned OS temporary
directory; use `tmp/` only when evidence is intentionally retained for review.

Startup profiler schema 2 preserves the positional report path, `--legacy`, and
default five cold/warm pairs; `--runs=1..10` bounds local samples. Each cold
sample now starts a new browser process/context, and its warm sample navigates
again in the same context. It blocks external traffic with a loopback proxy,
without request interception that would disable the HTTP cache. OS/server
caches are not cleared. The development-server default remains suitable for
runtime diagnostics; it is not evidence of bundled shell delivery.

For built startup timing, materialize baseline/candidate snapshots using
`node scripts/release/materialize-import2.mjs` with identical native/payload
inputs. Preserve any existing candidate before replacement. Serve each snapshot
with `createReleaseTestServer(directory)` from
`scripts/release/serve-test-release.mjs` on the same loopback port. Set
`DESKTOP_POB_ORIGIN` to the document base path (for example,
`http://127.0.0.1:3011/browserpob`) and run:

```text
node tools/profiles/profile-startup.mjs <report.json> --runs=2 --artifact=<snapshot-directory> --source-head=<materialization-commit> --source-diff-sha256=<working-source-diff-hash>
```

Record the source identity when materializing, including new source files in
the working-diff hash. The profiler checks served release metadata and immutable
payload manifest/provenance against the snapshot, and records hashes rather
than paths or URLs. It reports FCP, shell JS start, first canonical frame,
editor-ready and payload-ready separately. Older artifacts lack editor-ready;
the identical RAF-sampled ready observation is available for paired comparisons,
with up to a frame of observation delay. It is not a GPU presentation metric.
The [startup trial](COLD_START.md#browser-startup-presentation-and-readiness)
retains a compact result and artifact identities.

## Updating a claim

When later evidence conflicts with this ledger, do not overwrite history with an
unqualified new number. Record:

1. the old identity, boundary and result;
2. the new identity, boundary and result;
3. the reason they are comparable or not comparable;
4. the status change, such as experiment → shipped or shipped → retired; and
5. the raw-evidence location and validation outcome.

Then update the relevant surface document and this ledger in the same change.
