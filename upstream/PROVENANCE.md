# Vendored pob-web runtime

Source: <https://github.com/atty303/pob-web>

Revision: `db9fd4a097476039387261e3aabc4cd08d3747a3` (retrieved 2026-09-28 UTC).

The driver, DDS reader, game definitions, fonts, and packer are reused implementation
code from that revision. The production pob.cool web application, accounts,
deployment configuration, and asset CDN are not part of this application. The
PoB Codes `/import2` trial packages the vendored runtime as an isolated,
scriptless Cloudflare static-assets deployment.
`LICENSE` contains pob-web's MIT license. `NOTICE.md` preserves the font notices.

Native dependencies are vendored at the source repository's submodule revisions:

- Lua: <https://github.com/atty303/lua>, `a76fc772308d5578634f1a114428d1b1d6c510b3`.
  The MIT license is embedded in `vendor/lua/lua.h`.
- luautf8: <https://github.com/starwing/luautf8>, `f36cc914ae9015cd3045987abadd83bbcfae98f0`.
  See `vendor/luautf8/LICENSE`.

The build uses `emscripten/emsdk:6.0.6`, matching upstream's Emscripten pin.
Generated compiler output and dependency installations are ignored local inputs.
The selected Path of Building revision and overlay ledger are separately pinned
by `../source-pin.json`; the browser bridge is independent of that packaged source.

The ledger carries upstream PRs
[#10360](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10360),
[#10371](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10371),
[#10372](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10372),
[#10373](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10373),
and [#10313](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313)
at their exact recorded heads. Their individual diffs and SHA-256 values are
preserved under `../patches/upstream/`; `../patches/pob-pr-composite.patch`
records the composition onto beta revision
`a431f3a28823270acbdd6864c644f93678581f1e`, including the semantic resolution
where #10371 and #10372 both change `ItemDBControl.lua`, and where #10313 is
applied after #10373 (both change `CalcsTab.lua` and `TestPowerReport_spec.lua`; the
resolution keeps #10373's `useClusterPower` gating and both specs). The composite
SHA-256 is `c8935f99ee79448210d0e47d251e7242e6fec7854a95da38db2927166a8d9cd4`
and its result tree is `c31ecf2001a19ea955c78dbcaefc19681457a53d`.

The maintainer-supplied 2026-09-30 gem-dropdown hover patch is preserved in
`../patches/gem-dropdown-hover-tooltip.patch` (SHA-256
`6df3ff9dff331dbb637fdea199895739cc66da6c541ceb0eec92ce7e529cdd0b`).
The packer applies its three `GemSelectControl.lua` hunks through
`../scripts/patches/gem-hover-patch.mjs`, verifying both source and result blob hashes from the
pin. This caches dropped-list tooltip content and its comparison calculation
until its inputs change. The original source checkout, native bridge and
calculator formulas are unchanged. The patch also retains the supplied upstream
spec changes; browser acceptance and invalidation are exercised separately by
`../tools/profiles/profile-gem-hover.mjs`. Its Lua diagnostics are test-only, appended to
in-memory benchmark archives and never shipped in the payload.

The 2026-10-01 limited-unique item comparison optimization is preserved in
`../patches/limited-unique-item-comparisons.patch` (SHA-256
`27361f45e1b27c127b60ac980dfe9617d35051bdc2225ec987d66dab23f34519`).
`../scripts/patches/item-comparison-patch.mjs` checks the patch and exact source/result blob
hashes before applying it to the in-memory pack input. It checks the already
filtered slots for a filled unique limit and invokes PoB's existing comparison
helper only for matching items. The original eligibility, exact equality, slot
order, passive-tree reconstruction, general sorting and calculator formulas
remain unchanged. The prepared checkout is never edited for this overlay.
Browser acceptance compares complete tooltips and canonical exports, including
native level, flask, weapon-set, item-set and passive-spec edits.

The additional October 1 `../patches/calculation-only-jewel-specs.patch`
(SHA-256 `2c537a136088daf1381bcdf55daeade47f4fa8ad2f6a7cdf0bed3f1d132325e6`)
contains the narrow calculation-only temporary-spec portion of
[PoB PR #9863](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/9863)
at head `5cafb7f4f05299f08f2e68e6aadfd13396c71642`. UI path/highlight work is
skipped only for jewel comparison clones; dependencies, allocation and calculator
socket distances remain authoritative. A separate local addition removes empty
`nodeCopy.power` tables unused by temporary comparison calculations; that addition
is not attributed to the upstream PR. Live specs and heatmaps are unchanged.
`../scripts/patches/jewel-spec-patch.mjs` checks both file inputs/results and the retained patch.
The source pin distinguishes untouched prepared checkout hashes from the
ItemsTab input produced by the preceding limited-unique overlay. Browser
acceptance includes Thread of Hope/Timeless comparisons and Split Personality.

The October 1 `../patches/importtab-host-capabilities.patch` is a checked
pack-time adaptation of `ImportTab.lua`. It gates the OAuth section on the host
capability table, defaults that capability off, removes the disabled section's
layout gap, and leaves public-account plus build-code/file controls intact.
`../scripts/patches/importtab-host-patch.mjs` verifies the exact prepared input, patch SHA-256,
and result blob. The browser host independently refuses OAuth callbacks.

The October 2 `../patches/preferred-export-site.patch` is a second checked
`ImportTab.lua` adaptation applied after the host-capability patch. It selects
PoB's existing `PoBCodes` sharing entry when a browser editor session opens,
without changing the upstream sharing-site list or its alphabetical order.
`../scripts/patches/preferred-export-site-patch.mjs` verifies the patch, chained
input, and exact result blob.

The public configuration bridge adds one narrow native export through
`boot.lua`, `driver.c`, the existing UI worker, and `Driver`. It mutates only
the active `ConfigTab` on the displayed BUILD instance, accepts bounded options
already represented by native controls, snapshots and rolls back atomically,
and invokes PoB's ordinary undo/control/mod-list/build/calculation hooks. The
browser-side transaction owner preserves manual-over-automatic precedence and
restores exact build-code snapshots for undo. It does not embed a second build
engine or infer configuration policy.

Local adaptations: the Deno workspace excludes the production web package and
unneeded dependencies, standalone demo shell, and deployment/release tests; the
local shell supplies assets, host networking/OAuth callbacks, and capability
reporting. Comlink, MessagePorts, SharedArrayBuffer/Atomics, broker/subworkers,
the Lua host ABI, WebGL2 renderer, OffscreenCanvas, and original Lua UI remain
the upstream architecture.

The native filesystem integration test uses the local compiler's `build/release`
output directory. The source pin and packaging adjustments are implemented in
the local packer; `scripts/build/build-runtime.mjs` uses the toolchain image by immutable digest
and the image's Make generator.
The root Deno compiler options match the driver's DOM, JSX, and Emscripten
environment so the surrounding localhost shell can be typechecked together
with its imported bridge and Vite configuration.

`Driver.attachToDOM` accepts an optional external toolbar target. The overlay
portals its existing controls into the localhost shell header and releases the
canvas's old toolbar gutter. The default in-canvas toolbar remains available to
other hosts. Header mode opens zoom controls downward and fullscreen includes
the shell so its exit control remains reachable. Native PoB controls and
calculations are unchanged.

The pinned PoB beta uses `+=` in `Modules/Main.lua`. The vendored Lua lexer and
parser implement that statement directly in Lua bytecode; packaged PoB source is
not rewritten. Native regression tests cover locals, globals, upvalues, captured
table/index targets, RHS mutations, metamethods, precedence, and invalid targets.
The C bridge reports boot failures, and the worker checks both native startup
status and Lua errors caught internally by PoB before reporting a ready session.
Native tests explicitly instantiate Emscripten's exported module factory before
reporting success; importing the generated `.mjs` alone does not run its C main.

Queued Lua input is consumed before replacing held-key or mouse-position state,
so rapid events preserve their modifiers and click coordinates even before the
next animation frame. Mouse-only motion has one RPC in flight plus one replaceable
pending position. Discrete input and resize/visibility messages first flush that
position synchronously, preserving cursor/key ordering. Explicit input flush and
build export wait for the input RPCs and consume pending Lua events. Detach and
destroy discard buffered motion.
Before releasing a held mouse button, a pending final drag position is rendered
under the old held-button state. This preserves complete drags that arrive
between animation frames without forcing synchronous renders for free motion.
The mouse handler captures document-wide releases for buttons pressed inside
PoB, releases them on window blur/document hiding, and reconciles held buttons
against `MouseEvent.buttons` before forwarding movement. This prevents missed
releases from keeping the tree or scrollbars attached to the cursor. Shell-only
releases are ignored and release handling does not steal focus from the shell.

Mouse motion requests one redraw. Other invalidations retain their three-frame
budget, and neither can shorten explicit Lua frame requests. A frame consumes its
budget at entry so requests made by coroutines during that frame remain pending.

Glyph bitmap positions snap to framebuffer pixels while retaining fractional
font advances and kerning for text layout. The surrounding shell also uses an
integer toolbar button line height to avoid a half-pixel canvas boundary.

The WebGL2 context requests `antialias: false`. Chrome 154's default multisampled
framebuffer with blending left sparse bright pixels on the internal triangle
diagonal of solid dark panels, reproducible directly with two overlapping quads
and visible in framebuffer readback. Single-sample rasterization removes those
seams while preserving texture filtering and glyph alpha blending. The standalone
`tests/browser/test-render-seams.mjs` checks reduced opaque/translucent quads and native
Import/Export panels at DPR 1/2; shader precision, Lua, native draw commands,
canvas placement and frame reuse are unchanged.
The harness remains manual while its fixed import-panel sampling region is
investigated against the current UI; the CI registry records that exclusion.

`../tests/browser-harnesses.json` records development CI coverage and manual
acceptance prerequisites. Platform-sensitive framebuffer, tooltip and frame-timing
checks remain manual where Linux shadow runs exposed unstable results. Their
recorded local results are retained; inclusion in the registry does not imply
that every acceptance harness runs in CI.
Native editing/save/reload and render-reuse acceptance also remain manual after
Linux shadow runs exposed reload timeouts and resize/DPR pixel-parity failures.

The renderer rejects wholly offscreen static quads before texture resolution and
GPU submission, preserving boundary geometry and dynamic texture updates. The
embedded `item-tooltip-cache.lua` adapter memoizes up to 64 item-tooltip
comparison operation sequences within the current build/calculator revision.
It invalidates on edits and bypasses unsupported contracts; the original first
calculation and tooltip formatting remain intact. The pinned PoB checkout is
unchanged. Native tests cover cache invalidation and fallback,
and renderer tests cover clipping boundaries and texture-update side effects.
Release linking retains function names with `-g0 -g2` rather than DWARF, which
otherwise limits Emscripten's Binaryen optimization passes. Full source debugging
remains available in the separate Debug build. No fast-math options are enabled.

The native image bridge interns resource IDs by filename and effective sampler
flags. The JavaScript repository coalesces matching in-flight/loaded resources,
shares their GPU texture identity, and supplies a redraw completion only for a
new successfully loaded image. This prevents temporary influence-icon handles
in the original Items tooltip from causing perpetual loads/redraws and growing
image/texture caches. Native and JavaScript tests cover identity, reloads, flags,
concurrency and failures; a selected-item browser check covers stable caches and
idle redraws without altering packaged PoB source.

The native draw bridge now caches device scale per frame, retains geometrically
grown command storage, checks overflow/allocation failure, and appends string
headers/text without a temporary allocation. Shutdown releases native storage.
The image index is dynamically allocated, validated, sorted and binary searched;
interned resources retain dimensions and notify JavaScript only once. Native
regressions cover serialized bytes, DPR changes, allocation failure, long lines,
malformed/duplicate records, and more than 1,024 image records.

The October 1 native text-width cache avoids repeated Lua/Wasm-to-JavaScript
measurements for identical effective font heights, font indices and UTF-8 bytes.
It owns strings in a collision-checked LRU capped at 4,096 entries and 1 MiB of
text. Original JavaScript measurements remain authoritative on misses; physical
widths are converted using the current device scale. Null strings and scaled
heights at or below two bypass caching, preserving the original bridge behavior.
Initialization/shutdown and an explicit font-change invalidation export clear
entries. Native regression tests and the headless DPR/zoom pixel oracle cover
ownership, collisions, bounds, allocation failures, DPI and all loaded fonts.
The native draw profile exposes hits, misses, crossings and retained bytes;
`?textWidthCache=off` provides the local same-binary comparison mode.
The generic native implementation is submitted upstream in
[pob-web PR #226](https://github.com/atty303/pob-web/pull/226).

Driver startup overlaps broker preparation, the generated Emscripten streaming
loader (including its ArrayBuffer fallback), and six font fetches. Lua starts
only after all prerequisites. The native HTTP helper uses `pob_http_fetch` so its
EM_JS name cannot shadow the generated loader's browser `fetch`. Both streaming
and buffer instantiation retain debug-image registration. Browser regression
checks real streaming success and deliberately forced wrong-MIME fallback.
Successful static image completion requests one
frame; explicit Lua budgets remain authoritative. `runtime-profile.lua`, embedded
beside the existing tooltip adapter, records bounded opt-in calculation/heatmap
timings. Worker diagnostics count bridge calls, retained draw-buffer growth,
observed Wasm capacities, startup phases, image decode costs and broker operations.
An opt-in bounded filesystem trace contains only read-only payload paths. Wasm
capacity and Lua allocation samples are not total process or live-object memory.

The explicit calculation adapter extracts the original pinned `Build:OnFrame`
rebuild block into `DesktopEnsureOutputs`; source hashes and exact anchor counts
reject drift. `calculation-scheduler.lua` stages only known numeric-control change
callbacks, keeping original notification order and undo states. It flushes before
save/export, discrete changes, focus loss, comparison/calculator consumers and
active power work. The model and outputs retain a coherent completed revision
while text is pending. MAIN and CALCS remain together; their arithmetic is intact.
`?synchronousCalculations=1` disables staging. Native tests cover notification order,
all consumer boundaries, bounded queues/waits, cancellation and errors; browser
tests compare semantic XML and undo/redo with synchronous behavior.

`unique-comparison-delay.lua` wraps only the unique database tooltip/control.
It retains base text and delays exact stat differences until a stable 150 ms hover;
wheel, row, revision, modifier or screen changes cancel/restart pending work. It
invalidates PoB's cached pending tooltip when ready and then calls the original
comparison/cache. Native and browser regressions cover stationary completion,
wheel boundaries, focus-routed wheel input, cancellation and exact tooltip reuse.

Native compression moved to a checked allocation/cleanup helper with GC retry,
full GC before large Timeless inflation and protected Lua result allocation.
The pinned Timeless loader adapter rejects failed inflation before opening a
cache file. The Glorious Vanity seed adapter preserves original binary decoding
and readLUT/remapping, but materializes requested records with 32 cached strings
per node and checkpoints every 256 seeds. Exact source hashes/anchor counts,
exhaustive forward/reverse synthetic seed parity and real-family browser checks
guard updates. The filesystem directory finalizer now tolerates a previously
closed handle, covered by native integration collection tests.

Renderer reuse compares all command bytes plus image/glyph generations, retaining
at most 8 MiB. It skips renderer compilation/submission only, never Lua execution.
Resize, resource, layer and backend changes invalidate it; `?renderReuse=0` disables
it. Unit resource-generation checks and browser pixel/stat/pan comparisons protect
the existing dynamic texture and culling behavior. The standalone runtime probes
are test programs only; they introduced no worker pool, bytecode payload,
decode worker, allocator switch or memory-size change. The later unique-sort
worker integration is documented below.

Desktop archive schema 2 reuses production Browser-PoB's content identity and
complete tree-family principles, not its per-file schema or source pin:

| Desktop field | Meaning relative to production packaging |
| --- | --- |
| `sourceRevision` | Independent desktop beta source SHA, with PR identity recorded in preparation provenance |
| package `id` | Core, complete tree version (including Ruthless/alternate), or reviewed Timeless archive identity |
| package `startup` | Source-derived boot requirement (`core` and PoB's declared latest tree); schema 1 reads as eager |
| `sha256`, `bytes`, `uncompressedBytes` | Compressed archive content hash and compressed/expanded sizes |
| package `files[].path`, `bytes` | Exact archive membership, relative to read-only `/root` |
| `directories` | Explicit directory namespace, including empty directories |

`payload-manifest.ts` validates classification, path safety, sizes, uniqueness and
file/directory collisions. The packer uses deterministic calendar fields/order,
publishes verified content-addressed ZIPs before the mutable manifest, and retains
one predecessor generation. Cleanup accepts only validated hashes owned by an
older manifest. `scripts/build/pack.mjs` fingerprints generator inputs, manifest and archives.
The generated-output verifier checks every legacy file byte and directory.

The broker builds the complete immutable namespace from manifest metadata, then
validates and mounts only startup packages before Lua begins. The first open of
a lazy file coalesces one streamed fetch, size/SHA-256/exact-membership checks,
and mount; synchronous reads of lazy sources are forbidden. One post-ready idle
lane prefetches remaining trees before Timeless data. The driver forwards
byte/verification progress to a shell overlay derived from the PoB Codes
Analyzer tokens.

Transport failures retry with bounded no-progress and total-demand deadlines;
integrity failures are terminal immediately. On terminal demand failure the
broker stops subscript workers, the driver terminates the Lua worker, and the
blocked filesystem RPC never returns an errno to PoB. The native bridge also
traps a timed-out manifest-owned root operation. This preserves the original
reason eager loading was chosen: failed asset reads cannot enter tree or
Timeless regeneration paths. Legacy ZIP loading is explicit or selected by a
manifest 404, never by a corrupt manifest/package. Image transport and Lua
virtual paths remain unchanged. Production packaging uses release-relative
asset URLs so `/import2` never falls through to the main web Worker.

The unique-sort worker integration uses PoB beta
`a431f3a28823270acbdd6864c644f93678581f1e` after the four-PR composite and
gem-hover patch. PR #10371 supplies the evaluator visibility boundary and PR
#10372 supplies PoB's cache; the local delegation adapter only supplies the
browser batch hook used by helper workers.

`../patches/unique-sort-delegation.patch` (SHA-256
`c220a02dc8f792799efb96bdc857ab7aab2567f1e9e466437bff146fa3f73e64`)
extracts the unchanged candidate/slot evaluation loop from
`ItemDBControl:ListBuilder` into `EvaluateItemPower` and adds an optional
batch evaluator with serial fallback. Input blob
`550943265ac25fbe3d4c8ea02e3ef40481840deb` becomes
`e2cbeb9e1ab969f9769c1493b8152c733e5d72e7`.
The pinned source had no callable per-candidate boundary; an external wrapper
alone would have duplicated that loop or replaced ListBuilder. This isolated,
checked hook is the permitted narrow source adaptation. Filtering, slot
eligibility, calculator code and final comparison/order remain PoB-owned.
The patch includes focused upstream specs for absent/partial/full delegation,
zero and invalid-slot values. Those specs were run in a disposable patched
checkout, separately from browser tests.

The driver owns up to three headless workers, starts them sequentially after
readiness, and delegates immutable XML build snapshots plus active weapon set,
sort mode and exact candidate raw data. Build lifetime/revision and operation
generations reject stale replies. The UI worker computes an equal share
through the same evaluator, yielding approximately every 35 ms. Helpers use
25-candidate initial/large-heap chunks, otherwise 100, with a 15-second deadline
per import/chunk request. Parsed candidate reuse is bounded by database keys;
calculated scores are never cached by this integration. Scores use 17-digit
strings across JSON to retain full double precision.

Each helper gets a dedicated broker port restricted to immutable root reads
and its own file descriptors. Shared verified lazy archives are reused;
helper RPC retains one reusable SharedArrayBuffer instead of allocating one
for every read. Helpers have no user storage, network, clipboard, OAuth or
subscript access. Crash, timeout, stale work and memory retirement return to
the original serial path. Import can restart retired helpers; terminal payload
integrity failures close the whole pool and preserve the existing session
failure behavior.

Whole-browser acceptance uses a 6 GiB hard budget and 5.5 GiB admission ceiling.
Conservative runtime guards reserve space beyond observed Wasm capacities;
they are not an OS process-memory limiter. Mobile, low-core/low-memory devices
and unadmitted UI heaps remain serial. `?helpers=0` forces serial comparison.
Future source updates repack with checked patch/hash evidence and rerun
equivalence, memory and affected regressions; a changed callable contract
requires adapter maintenance. An equivalent upstream hook can replace the
carried patch during normal maintenance. No upstream merge is required.

`../scripts/lib/process-memory.mjs` samples Windows private commit for a dedicated browser
process tree, validating process creation times on parent/child edges.
Initial parent-ID-only results adopted unrelated processes after PID reuse
and were rejected. `../tools/profiles/profile-unique-memory.mjs` adds diagnostics only to
in-memory acceptance archives; it never changes packaged PoB. The finite
`../tests/browser/test-helper-workers.mjs` entry point compares full-precision scores,
ordering and complete canonical exports, exercises all Timeless families and
reimports, and checks cancellation, failures, containment and mobile serial
mode. Reports identify the exact Wasm, runtime sources, fixtures, harnesses,
browser and machine; headless/sub-interval memory limits are explicit.
This is manual Windows-only acceptance evidence; it is excluded from the
development browser CI subset in `../tests/browser-harnesses.json`.

Helper startup remains eager by default. The October 1 opt-in `helperStart=lazy`
policy advertises eligible capacity without creating interpreters until a sort
delegates work. Pool profiling distinguishes armed capacity, booting and ready
workers, recording start count and startup duration. Both policies preserve
admission, cancellation, failure fallback and exact sort/export equivalence;
lazy startup reduces pre-sort allocations but adds first-sort latency.

The item-hover experiment replaces the raw calculator-output cache with a bounded
cache of exact comparison `AddLine`/`AddSeparator` calls. It wraps only
`ItemsTab:AddItemStatDifferences`, retaining PoB's calculations, special-jewel
spec reconstruction and tooltip layout. It invalidates on build/calculator,
item, slot, view and formatting changes and bypasses unsupported contracts.
The former cache copied complete output graphs, including requirement-source
item/gem references, on both misses and hits. Diagnostic switches retain the
former cache and an uncached path for comparison; aggregate copy/cache counters
retain no build or item strings. `../tools/profiles/profile-item-hover.mjs` appends diagnostics
only to hash-verified in-memory acceptance packages, compares full tooltip text
and complete canonical exports, and records frame CPU rather than GPU latency.
The operation cache requires no pinned PoB source or calculator arithmetic changes.

The runtime-memory adaptation embeds `gc-policy.lua` before both boot paths.
The driver supplies role-specific pause values (UI 100, helper 400); choosing
400 leaves `collectgarbage` unwrapped. Other values intercept only `setpause`,
forwarding every other GC operation and preserving existing explicit collections
and native allocation-failure recovery. The actual policy is in runtime diagnostics.

`CMakeLists.txt` enables the vendored Lua implementation's existing `LUA_NANTRICK`
and little-endian mode, without editing Lua or PoB source. Tagged values occupy
8 bytes on wasm32, preserving double-precision numbers. The root wrapper's
`--compact-values=off` restores 16-byte values. Common compile flags apply to
the driver and every Lua-containing native test; those tests also use the same
growable mimalloc heap. Static layout assertions and numeric/table/GC tests
cover both representations, including NaN, infinities, signed zero, subnormals,
large exact numbers and the existing += parser behavior. The 2 GiB ceiling,
string settings and exception mode are unchanged. The measured dlmalloc
alternative was rejected and its experimental switch removed.

The finite `../tests/browser/test-runtime-memory.mjs` comparison composes the existing profiler,
sampler and full-export canonicalizer. Saved baseline binaries are routed only
to the isolated test browser. It checks five fresh-build sorts, all retained
Timeless families, a completed heatmap, exact full-precision scores/order and
complete exports. Original-policy memory retirement is retained in memory
evidence but cannot inflate the speed comparison; the candidate must never
retire. Local acceptance and final-build candidate remeasurement recorded 15.3%
lower median private-commit peak, 10.2% faster warm sorts and 2.1% faster heatmaps. Detailed figures,
reproduction and update requirements are in `../README.md`.
This comparison is manual Windows-only acceptance evidence and is excluded
from the development browser CI subset. The recorded results above are retained.

The October 6 browser node-power adapter is retained in
`../patches/node-power-delegation.patch` and checked by
`../scripts/patches/node-power-patch.mjs`. The pin records its patch and exact
CalcsTab source/result identities. Every pack and release includes it; the
prepared desktop checkout and composite remain unchanged. It shares the
existing bounded helper pool, preserving PoB calculation functions, cache
keys and result merge order. Eligible release sessions enable it by default;
`?nodePowerHelpers=0` forces serial calculation for diagnostics.

The October 6 compact-status-text adapter is retained in
`../patches/compact-status-text.patch` and checked by
`../scripts/patches/status-text-patch.mjs`. It reduces only the Timeless Jewel
league notice, the gem dropdown's sorting progress, and the power-report
progress toast to PoB's ordinary 16-unit control text. Other toast headings and
control typography are unchanged. Exact source/result identities keep this
browser-only presentation adjustment separate from the prepared checkout.

Delegation supports Hit DPS at the standard depths 5, 10, 15 and All, with at
least 200 evaluation items. The October 7 extension admits Glorious Vanity
(`vaal`) jewels; other Timeless families, other depth values and other metrics remain
serial. Failed or unavailable helpers also return to serial calculation. Helpers
retain the existing desktop CPU/memory admission checks and keep build inputs
only in memory. This is a browser-owned adaptation, not a desktop PoB contribution.

Node-power helper jobs now select GC pause 100 before importing their build,
avoiding transient heap growth that could retire an otherwise eligible helper.
Unique-item work restores its configured pause (400 by default), including the
original unwrapped collector at 400. Explicit collections and allocation-failure
recovery are unchanged. `runtimeGCPolicy.pause` is the active policy;
`configuredPause` and the pool's `gcPause` retain the configured startup setting.
The UI's share of delegated work yields between complete evaluations after
approximately 20 ms. The 2 GiB Wasm ceiling, per-helper retirement threshold and
whole-browser admission budget have not increased. Pool diagnostics preserve the
last retired workers' capacities so a fallback's memory cause remains inspectable.

`../tools/profiles/profile-heatmap.mjs` checks exact heatmap and full-report
snapshots and records report time, bounded worker-response samples, frame CPU
time and completed-frame gaps. Response samples include worker/broker queueing;
they are not input-to-paint measurements. Restart trials check superseded jobs
against fresh imports, including intentional serial fallback for unsupported
metrics. Firefox performance experiments require automation that leaves Wasm
optimization enabled; a debugger that observes Wasm can distort the comparison.
