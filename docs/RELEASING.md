# Release artifacts and private deployment

This public repository builds and tests release candidates. It does not deploy
production and must not receive Cloudflare API tokens, account credentials, or
other production secrets. Source ownership and deployment authority are separate.

## Build a candidate

1. Select a full reviewed commit on public `main`. Its exact-SHA `ci.yml` push
   run must pass `fast-gates`, `native-and-browser`, both named jobs
   `browser-harnesses-comparisons` and `browser-harnesses-interaction-and-loading`,
   and the final `browser-harnesses` aggregate in one complete attempt.
2. On push/main, `native-and-browser` builds the release tree, inventory, record,
   and tar before running the release-browser suite. It verifies the tree and
   archive both before and after two consecutive browser acceptance runs with
   retries disabled, then publishes the
   seven-day `ci-candidate-<sha>-<run-id>-<attempt>` artifact. Pull request,
   fork, manual, failed, cancelled, and incomplete CI runs cannot publish an
   eligible source candidate.
   Archives explicitly use POSIX PAX format on every platform so long asset
   paths pass the strict streaming verifier without GNU long-link headers.
3. Supply the exact CI run ID, attempt, immutable artifact ID and full public
   SHA to the private deployment operator. Its own verifier checks the public
   repository/workflow identity, required jobs, digest and complete inventory.
   Direct CI intake is the normal handoff; no public promotion or separate
   private dry run is required. The candidate remains data on the upload runner.
4. For a consumer that explicitly needs legacy promotion transport, dispatch
   **Build Editor Release Artifact** (`.github/workflows/deploy-import2.yml`)
   from `main` with `commit_sha`. It independently verifies the complete CI
   attempt and one unexpired candidate, then republishes the unchanged tar,
   inventory and record as `build-editor-<full-sha>` without building or testing.
   A different outer ZIP digest is transport provenance; all inner bytes and
   generation identities must remain identical. Invalid direct-CI evidence
   must never silently fall back to this compatibility path.

If the CI candidate expires, rerun the complete producer workflow attempt so
native, browser, and harness acceptance all execute again and a new
attempt-qualified artifact is created. Do not use an old successful SHA or a
partial rerun as a substitute. Even a successful "re-run failed jobs" is not
release-eligible if the native producer or any required job remains in an older
attempt. Use a complete rerun after diagnosing a transient runner/service
failure; it repeats native and browser acceptance and their compute cost.
Assertion failures require a repair commit. Do not fall back to rebuilding inside the
promotion workflow.

The workflow has read-only GitHub permissions apart from its own artifact
upload capability. It has no production environment, deployment step, or
Cloudflare secrets. Forks can build their own copies without production access.

Workflow summaries distinguish build provenance (source CI run, attempt,
artifact ID and digest) from promotion transport provenance (destination run,
artifact ID and digest). Release-browser summaries identify each test,
repetition and attempt, with individual phase durations and budget utilization.
CI requires both repetitions to pass without retries before uploading a candidate.
Bounded synthetic-fixture diagnostics are retained for seven days on success or
failure; older or manually retried reports still identify flaky successes.
Failed browser acceptance also prints the last 100 console messages, truncated
to 1,000 characters each, pending fixture requests, and startup state so stalls
can be diagnosed from the job log before Playwright finalizes the test status.
The failure capture also requests a bounded Chromium worker stack snapshot and
immediately resumes paused workers. A headless regression checks that a busy
worker is captured and continues running; candidate bytes and phase budgets are
unchanged by this diagnostic.
Diagnostics include worker heap sizes, document visibility and device memory.
On browser failure a separate `failed-native-interpreter` artifact retains the
generated native interpreter glue and WebAssembly bytes, with failed-run input
hashes in the job log, for exact local reproduction.
These diagnostic files remain subject to the successful-candidate eligibility
requirements above and do not confer release eligibility on a failed run.

Release acceptance enters long native text fields through the browser clipboard
and Ctrl+V, then drains native input before using dependent controls. The level
edit still uses individual keystrokes and verifies recalculation. Zero-delay
typing of entire notes, filenames and account fields forces many native input
frames; software WebGL rendering on Linux can keep those draws queued across
navigation and delay the new interpreter. Native save/reopen, padded export,
sharing and character-import assertions retain their existing phase deadlines
and fail-closed external request routing.

Each main push retains one CI candidate for seven days. Direct private intake
creates no second public transport copy; each explicitly promoted SHA
retains a second transport copy for seven days. With the current roughly
0.57-GiB inner archive, that is about 4 GiB-days per CI candidate and another
4 GiB-days for a promoted copy. The promotion summary records the actual source
artifact bytes and verified download time; Actions step timing records upload
and total promotion duration. These repository measurements do not establish
an account-wide billing balance.

### Investigating a browser acceptance stall

Phase start/end messages appear immediately in the job log. The reload phase
also records separate document-navigation and native-readiness steps. Check
which operation stalled before changing the runtime or its deadlines.

1. Replay the exact failed interpreter and candidate locally with the pinned
   Playwright browser. Preserve the retained bytes before rebuilding. Keep
   fixture routing fail-closed and use the existing phase budgets.
2. Inspect process and thread CPU use as well as worker state. Software WebGL
   can compete with Lua startup even when worker snapshots show parsing,
   decompression or filesystem waits. Debugger attachment deoptimizes Wasm;
   failure-only stacks are diagnostic clues, not performance measurements.
3. Use real paste for long native text fields and retain focused keystroke
   assertions for keyboard behavior. Do not make an acceptance scenario an
   accidental zero-delay typing stress test. Await native input consumption
   before clicking dependent controls.
4. Compare the old and fixed behavior under the same CPU/memory limits, then
   run the unchanged assertions repeatedly without retries. Build and push only
   after local evidence supports the fix; repeated remote rebuilds are not a
   substitute for a controlled reproduction.

The repeated CI suite adds one acceptance run without rebuilding the candidate.
Do not increase phase deadlines, remove assertions, or promote failed or flaky
candidates to resolve a timeout. Fresh exact-SHA CI remains required; promotion
is optional transport.

### Browser harness scheduling

The six required development harnesses run in two isolated Ubuntu 24.04 jobs:
item comparisons plus unique database, and the four input/loading harnesses.
Each job builds the interpreter without rerunning the native test targets;
`native-and-browser` remains their authority. Group membership is an exact
partition of the required registry. A skipped or failed group fails release
eligibility even if another job or aggregate is green. Separate runners avoid
contending native browser workers on one machine.

Search strings use real clipboard paste and native input draining. A short
typed edit, input-latency harness and release-level edit retain keystroke
coverage. All item/tooltip parity, stale/failure/retry cases, eleven jewel
families, stats and UI-worker loading invariants remain. The 120-scroll traversal
is retained: its local baseline was only 2.5 seconds. Phase timings isolate
startup, input, comparisons and scrolling rather than adding timing thresholds.

Choose parallelism against post-input-fix timings and the native lane's critical
path, not historical typing cost alone. Two groups also isolate the four other
harnesses' observed 190-second Linux duration. Reassess balance from the next
normal CI run; do not create benchmark deployments or assert a Linux speedup
from a warm Windows run. Sharing large intermediate runtime archives is deferred.

## Deployment boundary

For an authorized release, the private operator's normal entry point is:

```powershell
npm.cmd run deploy:editor -- --sha <full-public-commit> --expected-live <generation> --predecessor-tag <recovery-tag> --predecessor-sha256 <archive-hash>
```

Run this from a clean private operator checkout matching its remote `main`.
Obtain the live generation and exact recovery hash from verified live/recovery
evidence, not an old example or a rebuilt predecessor. The command selects the
successful exact-commit CI attempt, verifies its immutable package and deploys
once. Keep the printed run ID: resume it with `--resume-run <id>`; if upload
succeeded but verification failed, add `--verify-only` instead of uploading again.
The private operator's deployment runbook owns the full procedure and credentials.
Completion requires its live identity/isolation checks and production browser smoke.

Production deployment belongs to a separate private operator workflow. It must:

- Fetch the candidate by exact public repository, successful workflow run and
  commit, verify GitHub's artifact digest and the complete archive inventory,
  and independently confirm every required CI job and browser group, the selected attempt,
  public producer artifact, repository/head repository, workflow, event, and
  source SHA. Private verification must be aligned to these producer checks
  before the optimized path is treated as fully rolled out.
- Treat public archives as data. Reject traversal, duplicate paths, links,
  special files, unexpected roots and oversized entries before extraction.
- Use private verification code, deployment tools, static headers, redirects
  and fixed-target configuration. Never execute public release scripts or use
  public deployment configuration in a runner that can access production secrets.
- Recover the complete exact live predecessor without rebuilding it. Retain
  its immutable generation alongside the candidate, and archive the exact
  deployable bytes privately before changing the live pointer.
- For an authorized deploy, publish that digest-pinned recovery archive as the
  durable private GitHub Release before entering the credentialed upload job,
  then restore the same Release there. Verification-only runs persist nothing
  privately, and private Actions artifacts are not used as a handoff.
- Recheck the live predecessor under a non-cancelling deployment lock and upload
  only the verified static directory to the dedicated scriptless deployment.
- Verify the live generation and isolation headers, then run committed headless
  production smoke on a separate runner without deployment credentials.

The private operator owns `/browserpob*` and the legacy `/import2*` route.
The canonical document is `/browserpob/`; `/import2` and `/import2/` return
HTTP 308 to it. The private operator retains exact predecessor generation bytes
and maps only verified immutable generation paths across prefixes. Never use an
unproven blanket wildcard redirect or relabel an old recovery archive.
Boundary misses such as `/browserpob0` and `/import20` remain static 404s. The public artifact may include an
`/import/` landing asset for future integration; its presence does not authorize
publishing that route or changing the main application.

## Recovery and rollback

Actions artifacts are short-lived candidate transfer, not production recovery.
The private operator retains complete recovery archives and their exact hashes
as durable private GitHub Release assets. For deploy-authorized runs, that
already-required Release also transfers the verified bytes between the private
preparation and credentialed upload runners, avoiding a second billed Actions
artifact. Each Release includes every deployed static file and a complete
inventory. Restore exact bytes rather than rebuilding an old source revision.
Retain the interrupted live generation during rollback so its already-open
sessions keep their immutable assets.

For the first handoff, recover and verify the exact current deployed static
tree. A locally rebuilt tree, matching generation name alone, or retained
immutable folder without its original root controls is insufficient evidence.
If recovery is incomplete, keep the live pointer and finish recovery first.

Existing local materialization, release-record, predecessor and emergency-page
helpers remain available for artifact development. They confer no production
authority. Production credentials stay exclusively with the private operator.

Every generation carries the pinned Path of Building license and provenance.
Keep those bytes and their identities in the complete release inventory.

### Required passive-tree improvements in release artifacts

All future candidates must include the `tree-connector-culling` PoB overlay
and its companion WASM drawing cache and packed escape-color implementation.
Follow the affected checks and source-refresh procedure in
[DEVELOPMENT.md](DEVELOPMENT.md#retained-passive-tree-drawing-improvements).
`npm run build:release` and the CI candidate build compile the native driver
and pack the hash-checked PoB patch. Packing alone is insufficient after native
source changes.

When reviewing a candidate or upstream refresh, confirm that its
`payload/provenance.json` records the `treeConnectorCulling` adapter and
`tree-connector-culling` overlay with the identities from `source-pin.json`.
The release record binds the source ledger, native binaries and payload provenance
to the exact candidate. The source-ledger checks reject a missing overlay or
adapter; patch application rejects changed source or result bytes.

Promote and deploy the verified exact-SHA static package through the existing
private operator handoff. These changes are already bundled; deployment must
not apply another patch or rebuild them. Keep carrying both parts until
equivalent upstream behavior is verified and the source ledger, provenance,
bundled inventory and regression coverage are updated together.

### Required Power Report optimization in release artifacts

All future candidates must include the `power-report-relevance-pruning` and
`power-report-environment-reuse` source overlays and their browser helper
integration. Before building, run the
source-ledger/unit checks and follow the affected validation route in
[DEVELOPMENT.md](DEVELOPMENT.md#retained-power-report-relevance-pruning-and-environment-reuse).
`npm run pack` validates the retained patches and composed source identities;
the resulting payload provenance records both overlays. Confirm the candidate's
provenance includes them when reviewing a release or an upstream pin refresh.

Promote the verified exact-SHA artifact through the existing private operator
handoff. Do not apply a patch during deployment or rebuild the artifact there.
Keep carrying this optimization until equivalent upstream behavior is verified
and its removal is recorded in the source ledger and bundled inventory.
