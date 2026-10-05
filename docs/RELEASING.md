# Release artifacts and private deployment

This public repository builds and tests release candidates. It does not deploy
production and must not receive Cloudflare API tokens, account credentials, or
other production secrets. Source ownership and deployment authority are separate.

## Build a candidate

1. Select a full reviewed commit on public `main`. Its exact-SHA `ci.yml` push
   run must pass both `fast-gates` and `native-and-browser`.
2. Dispatch the **Build Editor Release Artifact** workflow
   (`.github/workflows/deploy-import2.yml`, retained filename for continuity)
   from `main`, supplying `commit_sha`.
3. The workflow prepares, checks, tests, builds and packages one generation.
   It verifies the release and runs the materialized editor's headless tests.
   `npm run test:e2e:release` serves those candidate bytes on loopback at
   `/import2/`, including their static headers. The gate exercises native editing,
   recalculation, export, save/reload using the existing native OPFS layout and
   mocked network integrations. No test request reaches production.
4. Download `build-editor-<full-sha>` or supply the successful run ID and SHA to
   the private deployment operator. The seven-day Actions artifact contains
   one tarball, the complete file inventory, and the release record. The record
   binds the tarball and inventory with SHA-256 hashes.

The workflow has read-only GitHub permissions apart from its own artifact
upload capability. It has no production environment, deployment step, or
Cloudflare secrets. Forks can build their own copies without production access.

## Deployment boundary

Production deployment belongs to a separate private operator workflow. It must:

- Fetch the candidate by exact public repository, successful workflow run and
  commit, verify GitHub's artifact digest and the complete archive inventory,
  and independently confirm the required CI jobs.
- Treat public archives as data. Reject traversal, duplicate paths, links,
  special files, unexpected roots and oversized entries before extraction.
- Use private verification code, deployment tools, static headers, redirects
  and fixed-target configuration. Never execute public release scripts or use
  public deployment configuration in a runner that can access production secrets.
- Recover the complete exact live predecessor without rebuilding it. Retain
  its immutable generation alongside the candidate, and archive the exact
  deployable bytes privately before changing the live pointer.
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
as durable private GitHub Release assets. Each includes every deployed static
file and a complete inventory. Restore exact bytes rather than rebuilding an
old source revision. Retain the interrupted live generation during rollback so
its already-open sessions keep their immutable assets.

For the first handoff, recover and verify the exact current deployed static
tree. A locally rebuilt tree, matching generation name alone, or retained
immutable folder without its original root controls is insufficient evidence.
If recovery is incomplete, keep the live pointer and finish recovery first.

Existing local materialization, release-record, predecessor and emergency-page
helpers remain available for artifact development. They confer no production
authority. Production credentials stay exclusively with the private operator.

Every generation carries the pinned Path of Building license and provenance.
Keep those bytes and their identities in the complete release inventory.
