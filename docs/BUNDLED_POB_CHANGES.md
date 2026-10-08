# Bundled Path of Building changes

This document is the human-readable inventory of Path of Building changes that
the Build Editor packages on top of its pinned desktop PoB base. The machine
authority is [`source-pin.json`](../source-pin.json): it records the immutable
base revision, overlay order, patch hashes, and exact source/result identities.
Update this document whenever that ledger changes.

## Base

- Repository: [PathOfBuildingCommunity/PathOfBuilding](https://github.com/PathOfBuildingCommunity/PathOfBuilding)
- Branch: `beta`
- Revision: `a431f3a28823270acbdd6864c644f93678581f1e`

An upstream PR remains bundled at its recorded head until the pinned base is
updated to include it or the overlay is deliberately removed. GitHub merge
status is informational; it does not alter a released build by itself.

## Upstream PR overlays

These exact diffs are composed in the listed order before browser-specific
pack-time adaptations run.

| Ledger identity | Change carried by the build |
| --- | --- |
| `10360` — [PoB #10360](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10360) | Broad UI and editing improvements across the passive tree, skills, items, calculations, configuration, and import/export screens. |
| `10371` — [PoB #10371](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10371) | Excludes hidden equipment slots from item-stat sorting and avoids calculating those slots. |
| `10372` — [PoB #10372](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10372) | Caches unique-item sort results until the build changes. |
| `10373` — [PoB #10373](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10373) | Skips cluster-passive work that Offence/Defence power mode does not consume. |
| `10313` — [PoB #10313](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313) | Skips Full DPS and eHP stages when the selected power-report metric cannot read them. |
| `10381` — [PoB #10381](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10381) | Fixes power-report cache correctness by separating radius-jewel, tattoo, Timeless/conquered, mastery, structured, and post-parsing modifier contexts. |

The composite resolves overlapping files semantically. In particular, the
power-report result keeps #10373's cluster gating, #10313's calculation-stage
options, and #10381's context-aware cache keys and regression coverage.

## Required local source patch

`power-report-relevance-pruning` is retained in
[`power-report-relevance-pruning.patch`](../patches/power-report-relevance-pruning.patch).
It is composed **after all six PRs and before the browser adapters**, using the
`source-composite` stage. It has not yet been submitted as a PoB PR.

For each Power Report, a recording calculation identifies which modifiers the
selected metric reads. Simple node additions that provably cannot affect those
reads reuse the unchanged result. A zero result alone never makes a node safe
to skip. Removals, mixed changes and uncertain interactions use normal
calculations; unsafe cached calculations disable pruning for that report.

The browser's serial path and each helper operation create their own observer
and relevance memo. Importing a build or starting another report creates fresh
state. The retained patch includes the desktop regression tests; the browser
adapter preserves traversal, cache keys, result order and fallback behavior.

**Carry this patch in every future bundle and deployment.** Source-ledger
validation rejects its absence or a broken composition. On an upstream pin
refresh, review the retained patch alongside the six PRs. Remove it only after
verifying equivalent upstream behavior and updating the ledger, regressions and
this inventory together. An upstream merge by itself does not update a bundle.

## Pack-time PoB patches

These patches are applied after the upstream-plus-local source composite, in this order.

| Ledger identity | Change carried by the build |
| --- | --- |
| `gem-dropdown-hover` (`gemDropdownHover`) | Caches gem-dropdown hover tooltip content and its comparison calculation until the inputs change. |
| `limited-unique-item-comparisons` (`limitedUniqueItemComparisons`) | Stops unique-item comparison work once the already-filtered slot limit is full. |
| `importtab-host-capabilities` (`importTabHostCapabilities`) | Hides unsupported OAuth UI according to host capabilities while preserving public-account and code/file import. |
| `preferred-export-site` (`preferredExportSite`) | Selects PoB Codes as the existing sharing-site choice for browser editor sessions. |
| `calculation-only-jewel-specs` (`calculationOnlyJewelSpecs`) | Carries the calculation-only temporary jewel-spec portion of [PoB #9863](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/9863), plus the local omission of unused `nodeCopy.power` tables in those temporary clones. |
| `node-power-delegation` (`nodePowerDelegation`) | Adds the checked batch seam used by bounded browser helpers while retaining serial fallback, PoB calculations, context-aware cache keys, and merge order. |
| `compact-status-text` (`compactStatusText`) | Fits three browser-constrained status messages into PoB's ordinary control text without changing other typography. |

## Other checked PoB source adapters

These browser-owned adaptations are also part of the packaged PoB source. They
are tracked as adapters rather than ordered overlays because some are exact
result locks or build transforms instead of standalone patch files.

| Adapter identity | Change carried by the build |
| --- | --- |
| `calculationScheduling` | Stages eligible numeric-control rebuilds and flushes at every calculation/export boundary; synchronous mode remains available. |
| `browserUiDefaults` | Defaults Show Animations off for new browser sessions while preserving the saved setting and upstream desktop default. |
| `uniqueComparisonDelay` | Delays expensive unique-item stat differences until a stable hover and cancels on input or revision changes. |
| `sparseTimelessSeeds` | Materializes requested Timeless records sparsely while preserving PoB's binary decoding and remapping. |
| `uniqueSortDelegation` | Adds the checked per-candidate batch hook used by bounded helper workers, with PoB's filtering, scoring, and final order unchanged. |

Runtime, renderer, loading, and WebAssembly improvements that do not modify the
packaged PoB source are outside this ledger. Glorious Vanity eligibility for
parallel power reports, workload-specific garbage collection, and shorter UI
work slices are browser-driver features shipped as part of the application;
they are not additional PoB overlays. Runtime adaptations are documented in
[`../upstream/PROVENANCE.md`](../upstream/PROVENANCE.md); the repository
[`README`](../README.md) also tracks improvements submitted upstream.
