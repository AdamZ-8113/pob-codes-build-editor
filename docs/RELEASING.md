# Release artifacts and private deployment

This public repository builds and tests release candidates. It does not deploy
production and must not receive Cloudflare API tokens, account credentials, or
other production secrets. Source ownership and deployment authority are separate.

## Build a candidate

1. Select a full reviewed commit on public `main`. Its exact-SHA `ci.yml` push
   run must pass `fast-gates`, `native-and-browser` and `browser-harnesses`.
2. On push/main, `native-and-browser` builds the release tree, inventory, record,
   and tar before running the release-browser suite. It verifies the tree and
   archive both before and after two consecutive browser acceptance runs with
   retries disabled, then publishes the
   seven-day `ci-candidate-<sha>-<run-id>-<attempt>` artifact. Pull request,
   fork, manual, failed, cancelled, and incomplete CI runs cannot publish an
   eligible source candidate.
   Archives explicitly use POSIX PAX format on every platform so long asset
   paths pass the strict streaming verifier without GNU long-link headers.
3. Dispatch the **Build Editor Release Artifact** workflow
   (`.github/workflows/deploy-import2.yml`, retained filename for continuity)
   from `main`, supplying `commit_sha`.
4. The manual workflow selects one completed successful push/main CI run and
   its exact attempt, requires all three jobs, resolves one unexpired candidate
   by immutable artifact ID, and verifies the downloaded outer artifact digest.
   It streams and checks every file in the inner tar against the inventory and
   record before re-uploading the same three inner files. Promotion does not
   install compilers or browsers, rebuild, or rerun tests.
5. Download `build-editor-<full-sha>` or supply the successful promotion run ID and SHA to
   the private deployment operator. The seven-day Actions artifact contains
   one tarball, the complete file inventory, and the release record. The record
   binds the tarball and inventory with SHA-256 hashes. The promotion artifact's
   outer Actions digest is transport provenance and can differ from the CI
   artifact digest; the inner tar, inventory, record, generation, and hashes
   must remain byte-for-byte identical.

If the CI candidate expires, rerun the complete producer workflow attempt so
native, browser, and harness acceptance all execute again and a new
attempt-qualified artifact is created. Do not use an old successful SHA or a
partial rerun as a substitute, and do not fall back to rebuilding inside the
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

Each main push retains one CI candidate for seven days, and each promoted SHA
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
candidates to resolve a timeout. Fresh exact-SHA CI and promotion remain required.

## Deployment boundary

Production deployment belongs to a separate private operator workflow. It must:

- Fetch the candidate by exact public repository, successful workflow run and
  commit, verify GitHub's artifact digest and the complete archive inventory,
  and independently confirm all three required CI jobs, the selected attempt,
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

The private operator owns `/import2*`. The public artifact may include an
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

### Required Power Report optimization in release artifacts

All future candidates must include the `power-report-relevance-pruning`
source overlay and its browser helper integration. Before building, run the
source-ledger/unit checks and follow the affected validation route in
[DEVELOPMENT.md](DEVELOPMENT.md#retained-power-report-relevance-pruning).
`npm run pack` validates the retained patch and composed source identities;
the resulting payload provenance records the overlay. Confirm the candidate's
provenance includes it when reviewing a release or an upstream pin refresh.

Promote the verified exact-SHA artifact through the existing private operator
handoff. Do not apply a patch during deployment or rebuild the artifact there.
Keep carrying this optimization until equivalent upstream behavior is verified
and its removal is recorded in the source ledger and bundled inventory.
