# Release inventory contract

Contract version 1 uses three durable assets:

- `pob-codes-build-editor-<generation>.tar.gz`: reviewed deployable bytes;
- `release-inventory.json`: sorted path, byte count, and SHA-256 for every
  deployable file; and
- `release-record.json`: public commit, generation, predecessor, PoB revision
  and ledger, driver/payload identities, deployment config hash, inventory hash,
  archive SHA-256, and numeric GitHub asset IDs.

`scripts/verify-predecessor.mjs` checks all three before extraction is accepted.
`scripts/verify-release-record.mjs` rejects missing, extra, or changed files.
The archive contains no source checkout, compiler output, credentials, reports,
browser state, raw private builds, captures, or private repository history.
