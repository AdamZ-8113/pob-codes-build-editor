# Development guide

This repository combines adopted Path of Building and pob-web code with a small
owned host, checked source adapters, build tooling, and release controls.

## Repository map

- `src/`: owned browser host contracts, UI entry point, and styles.
- `upstream/`: adopted pob-web driver, renderer, and packer source. Preserve the
  recorded adaptations in `upstream/PROVENANCE.md` when refreshing it.
- `patches/`: exact, hash-ledgered Path of Building overlays.
- `scripts/build/`: native build, payload pack, and source-ledger entry points.
  `scripts/build/mod-cache/` generates and verifies the pack-time ModCache supplement.
- `scripts/dev/`: loopback/LAN development server and narrow local services.
- `scripts/patches/`: checked adapters that apply the files in `patches/`.
- `scripts/release/`: release materialization, verification, archives, and
  predecessor controls.
- `scripts/lib/`: shared test and tooling helpers.
- `tests/unit/`: fast Node contract and safety tests.
- `tests/browser/`: executable headless browser acceptance harnesses.
- `tests/e2e/`: Playwright-discovered end-to-end tests.
- `tools/profiles/`: reproducible performance and production-smoke profiles.
- `tools/experiments/`: retained, test-backed research implementations that are
  not production entry points.
- `docs/performance/`: durable performance findings, cold/warm boundaries,
  shipped and rejected experiments, and the evidence index. Start at
  [`docs/performance/README.md`](performance/README.md) before proposing a new
  performance investigation.
- `contracts/` and `fixtures/`: bounded host contracts and reviewed public test
  inputs.

## Source and generated-data discipline

Path of Building's Lua UI and calculations are the behavior authority.
`source-pin.json` records the exact revision, upstream pull requests, local
patches, application order, input blobs, and result blobs. Update it and
`upstream/PROVENANCE.md` together when upstream inputs change.

Do not edit `.runtime/`, prepared Path of Building source, packed payloads,
native compiler output, or generated Path of Building Data/TreeData files.
Change the authoritative source, exporter, or checked adapter and regenerate.
Keep third-party licenses and notices with every published generation.

`npm run pack` also generates the mastery-option ModCache supplement under
`generated` in `source-pin.json`. It runs PoB headless in the driver's vendored
Lua interpreter through Docker, without network access, and proves the packed
entries against PoB's on-demand parser. Rerun that proof for an existing payload
with `node scripts/build/mod-cache/supplement.mjs [payload-dir]`. See
[Bundled PoB changes](BUNDLED_POB_CHANGES.md#generated-pob-data).

Use `npm run clean:runtime` to preview verified stale archives and shell outputs; stop build producers before `-- --apply`, and use repeated `--include <name>` only for reviewed direct children (protected inputs and the archive container cannot be included).

## Upstream overlay drift and pin bumps

`npm run drift:upstream` shallow-fetches the pin and PoB `dev` into a disposable
OS temporary directory and compares their trees. It never edits the pin,
patches, prepared source, or payload. Use `-- --ref <SHA>` for a historical
probe, `--json` for the versioned envelope, and `--output <path>` to persist it.
The weekly `upstream-drift.yml` workflow also supports manual dispatch and retains
only `report.json` as `upstream-drift-report` for 30 days, including conflict and
incomplete results. This advisory workflow is separate from release eligibility.

Entries distinguish unchanged locked paths (`untouched`), changed paths whose
patch still applies (`touched-applies`), failed exact context (`conflict`), all
retained change blocks already in the target tree (`absorbed`), and mixed
absorption (`partial`). PR state is informational; a merged flag never proves
absorption. Individual PRs are diagnosed independently because their recorded
composite includes an overlap resolution. That composite prepares the candidate
source, including the required local Power Report patches, followed by the
authoritative pack-time transforms in packer order. Source-local patches have
separate absorption entries; prerequisite resolution follows the composite.
Failure blocks dependent stages. Result-only adapters report locked-path drift.
The report's `touchedPaths` remain separate from patch applicability.

Exit codes are 0 for a completed acceptable check, 1 for the selected drift
policy, and 2 for incomplete collection or invalid invocation. The default
`--fail-on=conflict` also fails on `partial`; `--fail-on=touched` additionally
fails on changed/absorbed entries. `--fail-on=never` still fails incomplete
collection. Report output is written before applying the classification exit.

JSON schema version 2 includes entry-catalog version 4, the fixed public
`repository`, `editorSha`, `workflowRunId`/`workflowRunAttempt` (null locally),
UTC `capturedAt`, `targetRef`/`targetSha`, `pinSha`, `completion`, sanitized
`errorCode`, bounded `entries` and `counts`, informational PR states, and fetch
size/duration. Incomplete reports cannot be interpreted as clean. Historical
dispatch probes are identifiable by `targetRef`; consumers should bind reports
to trusted default-branch workflow metadata and treat their contents as data.

The entry catalog is a cross-repository contract with the private PoB Codes
monitor. Adding, removing, or renaming any emitted drift entry requires bumping
`DRIFT_ENTRY_CATALOG_VERSION`, updating `DRIFT_ENTRY_IDS` and its unit test, and
coordinating the matching private-monitor allowlist and fixtures in the same
maintenance batch. Catalog validation deliberately fails collection when the
source ledger changes without that explicit update; do not replace it with
producer-defined or dynamically trusted entry names.

GitHub can disable public scheduled workflows after 60 days without repository
activity. Open Actions → Upstream overlay drift → Enable workflow to restore
the schedule, then dispatch a check and inspect its report.

For an upstream pin bump:

Candidate source identities can be reproduced with
`python scripts/build/generate-source-chain.py --pin <candidate-pin> --checkout <exact-target-checkout> --pr-layer <pr.json> --relevance-layer <relevance.json> --final-layer <reuse.json> --out <new-directory>`.
The reviewed layer inputs are complete UTF-8 JSON path-to-text maps (null means
absent), composed in that order from original diffs and resolved overlaps. Keep
these authoring inputs separately from prepared runtime trees. The generator
uses a private Git index to independently check the full patch and result tree.
Its twelve-line diff context may change historical patch formatting while
preserving every blob and tree identity. Run its negative tests with
`python tests/source-chain-generator.test.py`.

Generate adapter identities with
`node scripts/build/generate-adapter-identities.mjs --source-root=<authored-final-checkout> --pin=<generated-pin> --out=<new-pin-file>`.
It verifies the composite blobs and retained patch identities before applying
the authoritative transforms in order. Regenerate the ModCache supplement
through its existing generator; its result hash must come from that output.
Install reviewed candidate files only after comparing them, then run normal
source-ledger checks and `npm run pack`; generation does not waive those guards.

1. Run the report against the intended exact SHA and review every touched,
   conflicting, or partially absorbed overlay. Rebase retained patches where
   necessary; retain the exact upstream diffs and recorded composite resolution.
2. Run `npm run drift:upstream -- --ref <SHA> --identities --fail-on=never`.
   Its print-only candidate identities distinguish prepared, source,
   intermediate, and result blobs. After reviewing the patches and candidates,
   update `source-pin.json` and `upstream/PROVENANCE.md` together. Never hash
   prepared files by hand: chained results exist only in memory. Missing
   candidate identities mean the applicable stage must be repaired first.
   Verify the selected upstream `LICENSE.md` against `PATH_OF_BUILDING_LICENSE.md`
   and refresh `PATH_OF_BUILDING_LICENSE.provenance.json` to the selected revision,
   even when the license bytes and SHA-256 have not changed.
3. Drop an overlay only with complete target-tree absorption evidence. Update
   the fixed inventories in `scripts/build/source-ledger.mjs` and
   `tests/unit/source-ledger.test.mjs` when inventory changes. Partial absorption
   requires a rebase, never automatic removal.
4. Preserve local edits and move the prior versioned `.runtime/source-<hash>`
   directory aside when pack requests it; never overwrite generated source.
   Pack regenerates the ModCache supplement and reports a changed ModCache
   identity, tree version, entry count or exclusion. Review the generated
   entries before recording the reported identities under `generated`.
5. Run `npm run pack` to verify every identity, then `npm run test:unit`,
   `npm run test:native`, `npm run build:release`, and `npm run test:e2e:release`.
   Follow the release handoff contract before publishing an artifact.

## Validation routing

- Documentation or narrow host changes: `npm run check` and affected unit tests.
- Ordinary code changes: `npm run check` and `npm run test:unit`.
- Native driver changes: add `npm run test:native`.
  This includes independent gzip/zlib bridge interoperability. For a source
  update carrying gzip trade helpers, additionally run
  `node scripts/test-compression-compatibility.mjs --source-root=<PoB checkout>`
  against the exact selected source. The runner reports helper/module hashes,
  permits compiler dependency retrieval, and disables network during execution.
- Payload, adapter, or pinned-source changes: add `npm run pack` and relevant
  `tests/browser/` harnesses.
- Passive-tree culling or retained-drawing changes: add `node scripts/test-tree-connectors.mjs`
  for retained LuaJIT/Busted tree specs, geometry bounds and drag-cache lifecycle, plus
  `npm run test:browser -- --only test-tree-connector-culling` for original/adapted
  pixel parity and drag work at DPR 1 and 2.
- Browser UI or integration changes: add `npm run test:e2e`.
- Driver, renderer or payload integration changes: add `npm run test:browser`
  for the registered development-server harnesses, after preparing and packing
  the runtime.
- Release tree, archive, packaging or native acceptance changes: run `npm run build:release` followed by
  `npm run verify:release`, `npm run test:e2e:release`, and the release safety tests.
- CI scheduling and release provenance selection without changed candidate
  bytes: run `npm run check`, `npm run test:unit`, and the affected browser group.
  The complete hosted native/browser release gates remain required before release.
  Reuse unchanged local evidence across commit/push/release; commits themselves
  do not automatically run tests. Expand for changed inputs or actual failures.

Install the browser for candidate checks with `npx playwright install chromium`.
The standalone harness registry in `tests/browser-harnesses.json` classifies
every `tests/browser/*.mjs` file as CI or manual and fails if a file is missing,
duplicated or has no manual exclusion reason. `npm run test:browser` runs the CI
subset sequentially, prints outcomes and durations, and owns its development
server on `127.0.0.1:3010`. Stop an existing server first and unset
`DESKTOP_POB_ORIGIN`; the runner refuses both an occupied port and an origin
override. Each harness has a ten-minute deadline, including payload probes that
deliberately wait for transport timeouts. The server is stopped on completion,
failure, timeout or interruption.

Use `npm run test:browser -- --group comparisons` or
`npm run test:browser -- --group interaction-and-loading` for the two CI groups.
The registry checks they cover the CI subset exactly once. `--only` and `--all`
retain their existing meanings. CI uses isolated runners; do not run groups
concurrently against the same local port. Avoid editing editor files during a
measurement: the development server reloads clients when those files change.

Local runs keep installed Chrome by default. Set
`BUILD_EDITOR_BROWSER_CHANNEL` to an empty string to use Playwright's installed
Chromium (POSIX: `BUILD_EDITOR_BROWSER_CHANNEL='' npm run test:browser`).
Shells that remove empty environment values need a Node launcher to set this
variable. CI uses bundled Chromium in the dedicated `browser-harnesses` job,
which prepares, builds and packs its own runtime. Candidate acceptance remains
in `native-and-browser`. That job creates and verifies the canonical release
tuple before acceptance, reverifies it afterward, and publishes it only for
successful push/main producers. `fast-gates`, `native-and-browser`, and
`browser-harnesses` must all pass in the selected run attempt for exact-SHA
release eligibility.
The curated development subset checks input latency, payload integrity, startup
paths and unique databases. Native editing/save/reload is covered by the release
suite. The older development editing harness remains manual pending conversion
of its burst typing; renderer pixel-parity harnesses retain their separate manual
investigations and unchanged assertions.

Use `npm run test:browser -- --only test-mouse-release` to select one registered
harness, including a manual entry, or `npm run test:browser -- --all` to include
every entry. Selecting the LAN harness starts the owned server with `--lan`.
Manual checks include Windows memory/performance admission, LAN HTTPS,
expensive calculation profiling, and platform-sensitive pixel, tooltip, overlay
and frame-timing checks. Their registry reasons explain the prerequisites or
observed failures; `--all` can therefore fail on a
machine that passes the CI subset. Run a harness directly when supplying its
own fixture/report options or using an explicitly started manual LAN server.

`test:e2e:release` starts a dedicated static server for `.runtime/import2-release`
on `127.0.0.1:3011` and opens `/browserpob/`; it never starts the development server.
The discovered release suite checks native fixture import, editing, recalculation,
export, mocked sharing/link resolution and character import, and save/reload using
the existing native OPFS path, plus immutable asset paths and the candidate's
isolation/cache headers.
External requests are mocked or blocked. The suite ignores development origin
overrides and refuses to reuse an existing server. Run `build:release` again after
source changes before using the candidate suite.
CI runs the complete suite twice with `--repeat-each=2 --retries=0`, using the
same candidate bytes. Long native text uses real clipboard paste; the level
edit retains individual keystrokes and recalculation checks. See the
[browser stall procedure](RELEASING.md#investigating-a-browser-acceptance-stall)
before changing timeouts or repeatedly rebuilding in CI.
CI retains bounded screenshots, error contexts, phase timings, and a suite
summary from these public fixtures as attempt-qualified
`candidate-browser-diagnostics-<sha>-<run>-<attempt>` artifacts for seven days,
on success or failure. Logs report phase start/end immediately; summaries bind
timings to the correct repetition. The test retains its 240-second finite budget;
startup and each functional phase have their own smaller deadline.

The host keeps `PoB Codes Import2 Preview v1` as its configured `userDirectory`
for settings/cloud lookup; that value is not the build root. Native PoB supplies
its authoritative `main.buildPath` through the build-list state bridge. Only a
normalized `/app/user/...` path is translated to the broker's local `/user/...`
mount; cloud and out-of-mount paths are rejected.

Folder snapshot import is broker-owned and serialized with native `/user`
mutations through one origin-scoped Web Lock. It writes files sequentially to
an exclusively reserved final directory, hides the directory from the checked
`BuildListHelpers` scanner with `.pob-codes-import.pending`, and records a
tokened private recovery manifest. Removing the sentinel is the visibility
commit. Recovery deletes only manifest-owned files and empty directories;
unknown entries are preserved and keep the folder quarantined. The Lua/C/worker
bridge exports LIST mode, subpath, native build path, virtual dimensions and UI
scale, and exposes PoB's existing `BuildList()` refresh. Generated boot/Wasm and
packed payload outputs must still be regenerated from these authored sources.

All automated browser runs are headless. Ordinary local tests must not be aimed
at production. `npm run test:e2e:production-smoke` is the explicit live-site
opt-in and is appropriate only for release verification.

### Retained passive-tree drawing improvements

Every build and source refresh must retain both parts of the passive-tree
dragging optimization:

- PoB: `patches/tree-connector-culling.patch`, applied by
  `scripts/patches/tree-connector-culling-patch.mjs` through the packer. The
  `treeConnectorCulling` adapter and `tree-connector-culling` overlay in
  `source-pin.json` lock both `PassiveTree.lua` and `PassiveTreeView.lua`.
- WASM: packed escape colors and bounded drawing capture/replay in
  `upstream/packages/driver/src/c/draw.c`, with texture-generation invalidation
  in `image.c`/`image.h`. Preserve these adaptations when refreshing pob-web.

Normal `npm run pack` automatically applies the PoB patch, validates its hash
and exact source/result identities, and records it in payload provenance.
Native changes require `npm run test:native` to rebuild and test the driver;
packing alone does not rebuild WASM. `npm run build:release` runs both steps.
Do not copy an older interpreter into a newly packed release: the Lua fallback
supports hosts without drawing-cache APIs, but editor releases require them.

For a PoB pin bump, use the drift/identity procedure above to rebase the checked
patch and update its ledger identities. Never patch the prepared source by hand
or bypass a hash failure. Retain the patch until equivalent upstream behavior
is verified and its removal is recorded. Run the source-ledger and tree-patch
unit tests, LuaJIT/Busted tree specs, native tests and DPR 1/2 browser parity
harness from the validation routes above. Check drag release, zoom/resize,
state invalidation, live-drawing fallbacks and cache cleanup as well as pixels.

See [the bundled inventory](BUNDLED_POB_CHANGES.md#pack-time-pob-patches),
[runtime provenance](../upstream/PROVENANCE.md), and
[release requirements](RELEASING.md#required-passive-tree-improvements-in-release-artifacts).

### Retained Power Report relevance pruning and environment reuse

Every source refresh must retain `power-report-relevance-pruning` followed by
`power-report-environment-reuse` from `source-pin.json`, after the five PR
overlays and before pack-time adapters. The independent patches are
`patches/power-report-relevance-pruning.patch` and
`patches/power-report-env-reuse.patch`; their 14-file union is also included
in `patches/pob-pr-composite.patch`. Regenerate the composite and the
`nodePowerDelegation` source/result identities from the actual patch chain.
Do not copy hashes from an edited prepared tree. The source ledger rejects
omission, reordering, or identity drift in either required source layer.

Changes to this integration require the retained Power Report LuaJIT/Busted
regressions, the source-ledger and node-power adapter unit tests,
`npm run test:browser -- --only test-power-report-relevance`, and browser
helper coverage. Check serial and parallel results, Full DPS/minions, defensive
metrics, transformed nodes, and report/build changes. Each helper operation
must create its relevance calculator after selecting the metric; do not reuse
its observer or setup snapshot across operations. Setup reuse must restore
calculation-owned state between candidates and fall back when independence
cannot be proved. The private `PowerBuilder(true)` validation path disables
pruning, setup reuse, and delegation for an unpruned serial reference. Native
LuaJIT benchmark improvements are not browser timing guarantees.

For a source refresh, run `node scripts/test-upstream-compatibility.mjs` after
packing. It extracts hash-verified packaged Lua, stages retained adapter specs,
and runs a nonempty explicit selection in a digest-pinned, network-disabled
upstream LuaJIT/Busted container. `--source-root=<checkout>` must match the pinned
revision; `--payload=<directory>` selects the candidate payload. Headless-only
scaffolding is supplied from that checkout; runtime modules come from packages.

Run `npm run test:browser -- --only test-power-report-preservation` to require
positive packaged pruning, setup reuse and stage-skipping engagement. Each
independent opt-out must remove its own work savings while preserving complete
report and heatmap snapshots and the other optimization paths. For the static
candidate server, set `DESKTOP_POB_ORIGIN=http://127.0.0.1:3011/browserpob/` and run
`node tests/browser/test-power-report-preservation.mjs --cases=scalar,defensive,minion --out-dir=tmp/preservation`.
These are functional engagement checks; calibrated timing trials remain separate.

See [the bundled inventory](BUNDLED_POB_CHANGES.md#required-local-source-patches)
for removal criteria and [release requirements](RELEASING.md).

## Calculation optimization coverage

After preparing, building the native runtime and materializing a candidate,
serve it with `node scripts/release/serve-test-release.mjs`. Run
`node tools/profiles/profile-helper-coverage.mjs --browser=chromium` for the
finite public-fixture matrix: scalar and composite reports, Full DPS/minions,
defensive/transformed metrics, custom/15/All depths, and Timeless/Abyss jewels.
Each case requires exact serial/parallel heatmap and complete report snapshots,
successful helper completion and memory admission. `--case=<name,...>` selects
individual cases; `--out=<directory>` retains the bounded review evidence.

For a specific private input use `profile-heatmap.mjs --build-file=<path>` or
`--build-url=<pob.codes link>`; input text remains in memory and reports contain
hashes. For Firefox use `--browser=firefox` and, if necessary,
`--firefox-executable=<isolated test installation>`. The profiler rejects Juggler
automation that observes Wasm and disables its optimizing compiler. It does not
patch an installed browser. Firefox uses a loopback proxy for deterministic
worker packages; Chromium uses request routing. All runs are headless.

`getRuntimeProfile().samples.powerReport` distinguishes this report's execution
from cumulative helper readiness/work. The sanitized debug export includes the
same mode, reason, metric, depth, counts and handoff evidence. Serial execution
remains expected for small workloads, unavailable/disabled helpers, invalid
contracts and a failed admission or worker request. Never remove those guards
to make a performance trial pass.

The coverage audit keeps optimizations at their owning boundaries:

| Optimization | Applicable work and invariant | Regression evidence |
| --- | --- | --- |
| Node helpers and tail handoff | All native node metrics; exact shared evaluator, immutable snapshot and original merge indices | Coverage matrix; native delegation/cancellation tests |
| Calculation stage skipping | Node evaluator passes each metric's Full DPS/EHP requirements; minion definitions inherit those flags | Stage-skip specs and source contracts; defensive/minion parity |
| Node cache correctness | PoB's context-aware keys retain radius-jewel and cluster modifier distinctions in both execution paths | Pinned PR specs; complete report snapshots |
| Unique-sort helpers and score cache | Uncached candidates for numerical sorts, active weapon set and output revision; item filtering/ranking stays PoB-owned | Helper pool, Lua sort adapter and source-ledger tests; manual helper acceptance |
| GC, compact values and memory admission | Both boot paths use the compact interpreter; node helpers apply pause 100, unique sorts restore their configured policy; per-helper and aggregate limits remain enforced | Native numeric/GC tests and pool memory/failure tests |
| Timeless loading | Sparse seed and inflate adapters apply to packaged jewel data, shared by UI and helpers | Native sparse/inflate tests; Timeless fixture parity |
| Item comparison and calculation-only jewel specs | Exact slot/limit eligibility; skip UI-only paths while preserving calculator distances | Checked adapters, native tooltip tests and jewel comparison harness |
| Numeric edit coalescing and tooltip reuse | Flush exact rebuilds before calculations/exports; invalidate reuse on relevant revisions/context | Native scheduler/tooltip tests and calculation scheduling harness |
| Mouse input coalescing | Keep one motion request in flight and deliver the final cursor position to the completed Lua frame | Input latency harness with `--expect-coalesced`; native input scheduling tests |

This matrix is a coverage contract, not a claim that every browser/build
combination is exhaustively benchmarked. Retained experimental transforms are
not production optimizations unless the source ledger and packer adopt them.

## Release boundary

Follow `docs/RELEASING.md` for the exact-SHA CI gate and candidate artifact
contract. Deployment credentials, predecessor recovery, the deployment lock
and rollback belong to the separate private operator. Its deploy-authorized
handoff reuses the durable private recovery Release rather than creating a
private Actions artifact. This public repository must remain free of production
credentials.

The manual release workflow is a promotion boundary, not a second builder. It
downloads one exact attempt-qualified CI artifact, checks the outer digest and
streams the inner tar against its inventory, then publishes the unchanged inner
tuple as `build-editor-<sha>`. Missing, expired, duplicate, incomplete, or
tampered source evidence fails closed; recovery is a new full CI producer
attempt rather than a promotion-time rebuild.
