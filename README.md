# PoB Codes Build Editor

This repository contains the standalone PoB Codes browser build of Path of
Building. It preserves the original Lua interface and calculation engine while
running locally in a browser worker. The public static release is served at
`https://pob.codes/import2/`.

This is adopted code, not a clean-room rewrite. The browser runtime began from
`pob-web`; Path of Building source is fetched at an exact revision and receives
the reviewed overlays in `source-pin.json`. See `THIRD_PARTY_NOTICES.md` and
`upstream/PROVENANCE.md` for ownership and modification details.

## Requirements

- Node.js 22 and npm
- Deno 2.7.12
- Docker for the pinned Emscripten 6.0.6 native build
- Chrome for browser acceptance

On Windows, use PowerShell and `npm.cmd` if script execution policy blocks the
PowerShell npm shim. Linux uses the same npm commands.

## Setup and local development

```text
npm ci
npm run prepare
npm run test:native
npm run pack
npm run dev
```

Open `http://127.0.0.1:3010`. The default server is loopback-only, rejects
unapproved Host headers, and uses port 3010. `node dev.mjs --lan` is an explicit
private-LAN HTTPS mode; it does not enable account OAuth away from loopback.

Compiler outputs, the prepared PoB checkout, payload packages, dependencies,
browser profiles, reports, private builds, and credentials stay local and are
ignored by Git.

## Commands

- `npm run prepare` installs the frozen Deno dependency graph.
- `npm run dev` starts the loopback application on port 3010.
- `npm run check` runs the fast Node/TypeScript/public-boundary gate.
- `npm run test:unit` runs every registered Node and Deno unit test.
- `npm run test:native` builds with Emscripten 6.0.6 and runs native tests.
- `npm run test:e2e` discovers Playwright tests and starts the local app.
- `npm run bench` records the public interaction benchmark recipe.
- `npm run build:release` builds, packages, materializes, inventories, and
  archives a release.
- `npm run verify:release` verifies every release byte and deployment contract.
- `npm run test:e2e:production-smoke` runs the explicit live `/import2/` smoke.

The production smoke targets `https://pob.codes/import2/` unless
`IMPORT2_ORIGIN` names an approved local preview. Ordinary local e2e must not be
pointed at production.

## Public configuration

Static production builds accept these non-secret environment values:

- `PUBLIC_BASE_PATH` (default `/import2`)
- `PUBLIC_SITE_ORIGIN` (default `https://pob.codes`)
- `PUBLIC_PRODUCT_NAME`
- `PUBLIC_REPOSITORY_URL`
- `PUBLIC_API_BASE_URL` and `PUBLIC_TELEMETRY_ENDPOINT`

API and telemetry endpoints default to empty and remain disabled. The current
release deliberately keeps network-backed PoB features unavailable. Do not put
tokens or ingestion credentials in these variables or in a browser bundle.

## Source updates

`source-pin.json` pins the Path of Building revision, upstream PR evidence,
local overlays, exact patch hashes, and result hashes. `node pack.mjs` prepares
an owned checkout from public inputs and refuses source or overlay drift. On an
update, classify every overlay as absorbed, still required, partially absorbed,
or head changed, then regenerate the composite and result hashes together.

The adopted pob-web revision is immutable unless a deliberate source import is
requested. Carry every adaptation listed in `upstream/PROVENANCE.md` forward
when that happens.

## Fixtures and privacy

`fixtures/` contains reviewed public build fixtures only. `fixture-loader.mjs`
implements the small decoder/composer needed by browser tests without importing
private application helpers. Private build benchmarks are optional caller inputs
and must never be committed or included in reports; reports retain only hashes
and aggregate measurements.

## Releases and rollback

See `docs/RELEASING.md`. Each generation has a complete per-file SHA-256
inventory, public commit, PoB ledger, binary/payload identities, deployment
contract, and predecessor identity. Durable GitHub Release assets, not expiring
Actions artifacts, are the recovery source. A deploy fails before upload if the
predecessor is missing, expired, mismatched, or stale relative to the live
identity.

The Cloudflare resource remains `pob-codes-import2` and owns only
`pob.codes/import2*`. Shell pointers revalidate; generation assets are
content-addressed and immutable. COOP/COEP/CORP and static 404 boundaries remain
mandatory.

## Benchmarking

The public recipe in `docs/BENCHMARKING.md` covers cold/warm startup, item and
gem hover, unique sorting, tree movement, and retained memory. Record exact
fixture, source, binary, browser, and viewport identities; alternate variants;
report medians and tails; verify tooltips, canonical exports, and pixels when
rendering changes. Frame callbacks measure CPU work, not GPU presentation.
