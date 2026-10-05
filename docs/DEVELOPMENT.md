# Development guide

This repository combines adopted Path of Building and pob-web code with a small
owned host, checked source adapters, build tooling, and release controls.

## Repository map

- `src/`: owned browser host contracts, UI entry point, and styles.
- `upstream/`: adopted pob-web driver, renderer, and packer source. Preserve the
  recorded adaptations in `upstream/PROVENANCE.md` when refreshing it.
- `patches/`: exact, hash-ledgered Path of Building overlays.
- `scripts/build/`: native build, payload pack, and source-ledger entry points.
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

## Validation routing

- Documentation or narrow host changes: `npm run check` and affected unit tests.
- Ordinary code changes: `npm run check` and `npm run test:unit`.
- Native driver changes: add `npm run test:native`.
- Payload, adapter, or pinned-source changes: add `npm run pack` and relevant
  `tests/browser/` harnesses.
- Browser UI or integration changes: add `npm run test:e2e`.
- Release-path changes: run `npm run build:release` followed by
  `npm run verify:release`, `npm run test:e2e:release`, and the release safety tests.

Install the browser for candidate checks with `npx playwright install chromium`.
`test:e2e:release` starts a dedicated static server for `.runtime/import2-release`
on `127.0.0.1:3011` and opens `/import2/`; it never starts the development server.
The discovered release suite checks native fixture import, editing, recalculation,
export, mocked sharing/link resolution and character import, and save/reload using
the existing native OPFS path, plus immutable asset paths and the candidate's
isolation/cache headers.
External requests are mocked or blocked. The suite ignores development origin
overrides and refuses to reuse an existing server. Run `build:release` again after
source changes before using the candidate suite.

The host keeps `PoB Codes Import2 Preview v1` as its configured `userDirectory`
for settings/cloud lookup. Native PoB currently writes browser saves under the
OPFS directory `Path of Building/Builds`; the candidate test preserves and checks
that existing layout. Any future directory correction requires an explicit
migration of users' saved files.

All automated browser runs are headless. Ordinary local tests must not be aimed
at production. `npm run test:e2e:production-smoke` is the explicit live-site
opt-in and is appropriate only for release verification.

## Release boundary

Follow `docs/RELEASING.md` for the exact-SHA CI gate and candidate artifact
contract. Deployment credentials, predecessor recovery, the deployment lock
and rollback belong to the separate private operator. This public repository
must remain free of production credentials.
