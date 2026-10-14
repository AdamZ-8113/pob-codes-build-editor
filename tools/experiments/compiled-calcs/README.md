# Cold calculation opportunity experiment

This local experiment measures the first import of three public builds in the
current Lua/WASM engine. It estimates whether a bounded compiled calculation
kernel has enough removable work to merit implementation. The current command
implements profiling only; it contains no compiled calculation accelerator.

Run from the repository root with prepared payloads, the current normal driver,
installed Node dependencies, Chrome (or the configured Playwright channel), and
the digest-pinned Emscripten Docker image:

```powershell
node tools/experiments/compiled-calcs/run.mjs --mode=profile
node --test tests/unit/compiled-calcs-experiment.test.mjs
```

The runner refuses an existing listener on `127.0.0.1:3010`. It builds a separate
profiling driver from authoritative sources, starts the existing loopback server,
and opens a new headless browser process, disposable profile, worker and Lua state
for each sample. Toolchain dependency downloads can occur during build setup;
browser trial requests are limited to loopback. Existing normal driver, payload
and source-pin hashes are checked before and after the run.

Each fixture gets a coarse-only control and a candidate profile. Hooks precede
the target's first import; there is no target warm-up or discarded calculation.
The default empty-build calculation remains in helper boot. First-result timing
ends before profile diagnostics and wrapper calibration. Calculation time is the
union of outermost `buildOutput` spans, including MAIN and CALCS passes. Natural
GC stays in its enclosing span; the helper's explicit post-import collection is
reported separately and remains inside first-result time.

The two measured candidate regions are `CalcDefence.numberOfHitsToDie` and the
ModStore/ModDB query, filtering and evaluation family. Nested candidate work is
counted once. High-frequency wrappers materially affect total calculation time,
so the gate uses the coarse control's denominator and the raw instrumented
candidate numerator. It reduces the denominator by a further 10% allowance;
this is a conservative decision assumption, not a statistical confidence bound.
A geometric-mean optimistic ceiling below 1.5x must repeat across all three
fixtures before the runner reports a negative opportunity result. Calibration
adjustments and assumed 2x/5x kernel models are diagnostics, not measured gains.
Lua's millisecond timer cannot establish that a zero-duration region does no work.

Reports are retained under `tmp/compiled-calcs-poc/<run-id>/`; isolated binaries
are under `.runtime/compiled-calcs-poc/<build-identity>/`. Reports include source,
fixture, toolchain and binary identities, individual samples, phase/call counts,
candidate bounds and the decision. Source locks fail on drift. Owned temporary
build overlays and browser profiles are removed on success and failure.

Headless first-result time includes local asset transfer, WASM setup, Lua boot,
import and result delivery. It omits the shipped main worker, renderer, fonts,
UI initialization/drawing and normal input/scheduling. The first fixture can
include Vite's initial transforms; server/module and OS caches may be warm for
later samples. These timings do not establish shipped-editor first-import
latency or a cross-arm startup speedup. WASM capacity and Lua allocation figures
are not total process memory. Fixture skill and Full DPS enrollment observations
are included; three builds are not comprehensive mechanic coverage.

`preflight`, `parity`, `bench` and `native-control` modes are deliberately absent
until a useful bounded kernel is selected. Existing Path of Building calculations
and licenses remain authoritative. Removing this experiment and its owned
artifacts is the rollback; normal application entry points import none of it.

## Expanded startup investigation

`expanded/` investigates cold Lua loading and initialization separately from a
calculation-kernel rewrite. Its runner supports fresh-process, alternating-order
comparisons across the three public builds and a checked Full DPS variant:

```powershell
node tools/experiments/compiled-calcs/expanded/run.mjs --mode=profile --variants=baseline,read-ahead,loadf-64k,calc-only-read-ahead --rounds=4 --alternate-order
node tools/experiments/compiled-calcs/expanded/run.mjs --mode=profile --variants=baseline,architecture-profile --rounds=2 --alternate-order --port=80
node tools/experiments/compiled-calcs/expanded/app-smoke.mjs --rounds=3
node tools/experiments/compiled-calcs/expanded/loadf-validate.mjs
node --test tests/unit/compiled-calcs-experiment.test.mjs tests/unit/compiled-calcs-read-ahead.test.mjs tests/unit/compiled-calcs-bootstrap.test.mjs
```

Builds finish before timing. The headless runner disables Vite HMR/watch and
normalizes server transforms by fetching modules without executing the runtime.
Every measured sample has a new browser process/profile, broker, helper worker,
WASM/Lua state, and first target import. The local server and operating-system
caches may be warm. Main-app smoke has a separate excluded preflight and uses
the ordinary local app configuration, including its eager helpers.

`architecture-profile` is a diagnostic-only companion to `baseline`. It adds
phase-scoped nested timings for file compilation and execution, module loading,
`Main:Init`, passive-tree/build/tab constructors, dynamic tree chunks and item
materialization. Its paired baseline bounds observer overhead; the diagnostic
arm is never classified as speed evidence. Lua timing resolution is one
millisecond, so aggregate repeated spans rather than interpreting individual
zero-duration calls as free work.
The optional loopback-only `--port` avoids an unrelated development server;
the runner still refuses to reuse an occupied listener.

The read-ahead candidate caches at most one 256 KiB window per eligible,
broker-authorized immutable Lua file, with a 4 MiB aggregate ceiling. It preserves
explicit offsets and returned-buffer ownership, invalidates on mutations, and
evicts on close. It can transfer extra filesystem RPC bytes; HTTP packages are
unchanged. The control retains the same
accounting wrapper with read-ahead disabled; the separate app smoke compares
against the unwrapped app. `loadf-64k` and `loadf-256k` instead enlarge only Lua's
local file-reading buffer in a checked scratch source overlay; they preserve the
global `luaL_Buffer` ABI and transfer the same file bytes.

`stdio-64k` and `stdio-256k` retain the 16 KiB Lua parser buffer and supply a
separate 64/256 KiB native stdio buffer before the first byte is read. Only owned
filename streams borrow that storage; stdin buffering is unchanged. Binary
reopen uses close-then-open and reapplies the buffer. The stream closes before
the local storage expires. This enlarges the active C stack frame, so the native
suite includes accepted/rejected deep parser syntax under the actual 1 MiB stack,
large inputs, binary/error paths, nested/repeated loads and piped stdin.

```powershell
node tools/experiments/compiled-calcs/expanded/run.mjs --mode=profile --variants=baseline,read-ahead,stdio-64k,stdio-256k --rounds=2 --alternate-order
node tools/experiments/compiled-calcs/expanded/loadf-validate.mjs --output=tmp/compiled-calcs-expanded/new-review/loader-validation
```

The native validator refuses to overwrite a nonempty evidence directory.

To test native buffering in the ordinary app, build a separate driver with the
authoritative helper boot and pass the printed content-addressed directory:

```powershell
node tools/experiments/compiled-calcs/expanded/run.mjs --mode=profile --variants=stdio-256k --build-only --unprofiled-driver
node tools/experiments/compiled-calcs/expanded/app-smoke.mjs --variants=baseline,read-ahead,stdio-256k --rounds=2 --driver-dir=.runtime/compiled-calcs-expanded/<printed-identity-prefix>
```

The app runner rejects a profiling-helper driver for this comparison. Native
stdio applies to the main runtime and eager helpers sharing that binary; the JS
read-ahead app arm changes only the displayed main worker. Both retain normal
HTTP source packages. App output validation compares canonical exported XML and
saved PlayerStats, not compressed build-code bytes or every transient table.
Full runtime-profile collection runs after the timed first import; its payload
snapshot describes post-import state rather than the before-ready state.

Exact-VM bytecode is an offline static-source preprocessing candidate. Prepare
its checked package overlay before timing; host LuaJIT or a 64-bit `luac` is not
compatible with this custom wasm32 Lua VM:

```powershell
node tools/experiments/compiled-calcs/expanded/prepare-bytecode.mjs --output=tmp/compiled-calcs-expanded/example/bytecode --packages=core,timeless-shared,tree-3_19,tree-3_29,tree-legion,tree-3_27_alternate,tree-3_28_alternate,tree-3_28
```

Line/debug metadata, deterministic file-path chunk names and exact-source
fallbacks are retained; unnamed loadstring callers can acquire different debug
source identities. Bytecode may
increase compressed transfer size. Its binary load path additionally requires
the experiment's checked close-then-open correction: ordinary `freopen` leaked
custom WasmFS file ownership, deferring cleanup outside the first-result timing.
Earlier bytecode timings with unbalanced handles are discovery data only.

`calc-only` names a different request contract: it computes the target but returns
before the unique-item catalog finishes loading. It is unsuitable as a general
replacement for ordinary helpers. `bootstrap` defers the default empty build;
most of that work moves into the target import, so only total first-result time
is comparable across that variant.

The shipped nodePower and comparison helper requests already omit this catalog
drain. A calculation-only result therefore demonstrates an experimental request
boundary, not an additional speedup for those existing APIs.

Diagnostics run after the first-result timestamp. The headless oracle compares
exact tagged player/minion MAIN and CALCS output fields, warnings, material
presence, Full DPS enrollment, and documented breakdown representations.
Nonfinite values retain explicit tags. Function values retain type only, and
external item graphs use primitive item identities. Two skill-modification
lists also have a source-backed display-sort projection; ambiguous comparator
ties remain strict. Raw ordering can vary between independent baseline runs;
report those failures separately rather than relaxing numerical comparisons.
App-smoke parity covers canonical exported XML and saved PlayerStats only.

Review reports live under `tmp/compiled-calcs-expanded/<date>/`, and isolated
driver builds under `.runtime/compiled-calcs-expanded/`. The retained decision
report identifies accepted comparisons, discovery-only runs, exact commands,
coverage, and limitations. These prototypes are not imported by production
entry points and do not change the normal source pin, runtime or payload.
