# Release, deployment, and predecessor recovery

Deployments are manual and exact-SHA. Builds and tests use no secrets. The
credentialed `production` environment receives only the verified artifact from
that workflow run. The concurrency queue never cancels an in-progress editor
deployment.

## First public handoff

The first predecessor is the exact currently deployed private-built static
tree. Recover its complete bytes and trusted inventory without rebuilding it.
Run the public verifier against the recovered directory, create a bootstrap
archive/inventory/record with the scripts in this repository, scan the contents,
and publish those three files as durable assets of a bootstrap GitHub Release.
The finalized record must contain the numeric archive and inventory asset IDs,
archive SHA-256, generation, complete per-file inventory, and deployment config.

If the currently deployed bytes cannot be recovered and verified, stop. Keep
the old deployment owner and live pointer. A new build is not proof of identical
predecessor bytes.

## Normal release

1. Wait for the selected exact public `main` SHA's `ci.yml` push run to finish
   successfully, including both `fast-gates` and `native-and-browser`. Dispatch
   `.github/workflows/deploy-import2.yml` with that SHA, mode, and the pinned
   predecessor release tag, generation, archive asset ID, and inventory asset
   ID. The release workflow fails closed when that exact CI evidence is absent.
2. The build job resolves the requested GitHub Release, downloads the archive
   and inventory through those exact numeric asset IDs, downloads the unique
   record asset from the same release, and verifies their recorded IDs, archive
   SHA, generation, deployment configuration, and every file. Only then does it
   pass the recovered directory to
   `node scripts/release/materialize-import2.mjs --retain`.
3. Native, unit, browser, release, and exact-inventory checks run without
   deploy credentials. Candidate archive/inventory assets are published before
   any pointer switch and a finalized release record pins their GitHub asset
   IDs.
4. Under the protected production environment, recheck the live generation
   while the deploy lock is held. It must equal the recorded predecessor.
5. Upload only the verified same-run directory. Run the production smoke and
   confirm headers, generation, edited export, immutable assets, and static
   misses.

Actions artifacts are short-lived transfer only. GitHub Release assets are the
recovery source.

Every new generation includes the exact Path of Building `LICENSE.md` blob at
the revision in `source-pin.json`, plus its source-path/revision/hash provenance.
The generation identity and release-record verifier cover those legal bytes,
all shell inputs, all payload bytes, the materializer contract, and the resolved
`PUBLIC_*` configuration.

## Rollback

Download and verify the predecessor archive again; never recompile it. Publish
its shell pointer while retaining both its generation and the failed candidate
generation so sessions opened during either release keep immutable assets.
Verify the rollback with the production smoke before ending the lock.

Keep release archives until no live pointer, rollback path, or supported open
session references them. Capacity evidence, not Actions expiration, controls
cleanup. A missing or tampered archive, stale live identity, changed deployment
config, or unverified asset ID fails before upload.

For a scriptless emergency disable, the workflow runs the same exact-SHA CI
eligibility gate, materializes the standalone recovery page, and executes the
ordinary release verifier against the disabled output before any upload.

## Protected settings

The repository owner configures the `production` environment, required reviews,
least-available Cloudflare token, main-branch protection, and release retention.
Do not store Cloudflare values in source, artifacts, Pages, logs, or public
configuration variables.
