# Release inventory contract

Release-record contract version 2 uses three durable assets:

- `pob-codes-build-editor-<generation>.tar.gz`: reviewed deployable bytes;
- `release-inventory.json`: sorted path, byte count, and SHA-256 for every
  deployable file; and
- `release-record.json`: public commit, generation, predecessor, PoB revision,
  ledger and exact pinned-license identities, driver/payload identities,
  deployment config hash, inventory hash, archive SHA-256, and numeric GitHub
  archive and inventory asset IDs.

`scripts/verify-predecessor.mjs` requires and checks both durable content asset
IDs and all three files before extraction is accepted. Contract-version-1
bootstrap predecessor records remain readable; every newly built record is
version 2 and must carry the pinned Path of Building license identity.
`scripts/verify-release-record.mjs` rejects missing, extra, or changed files.
The archive contains no source checkout, compiler output, credentials, reports,
browser state, raw private builds, captures, or private repository history.
