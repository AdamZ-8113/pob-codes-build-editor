# PoB Codes Build Editor

PoB Codes Build Editor runs Path of Building's original Lua interface and
calculation engine locally in a browser worker. The public build is available at
[pob.codes/import2](https://pob.codes/import2/).

This project is a fork of [atty303/pob-web](https://github.com/atty303/pob-web),
not a clean-room implementation. It combines that browser runtime with a pinned
Path of Building revision, reviewed PoB patches, and additional browser-focused
performance, rendering, and interaction work. Exact source revisions and patch
hashes are recorded in [`source-pin.json`](source-pin.json) and
[`upstream/PROVENANCE.md`](upstream/PROVENANCE.md).

## What this fork improves

### Path of Building changes

The packaged PoB source currently carries these PRs submitted by this project's
maintainer:

- [PoB #10360](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10360)
  improves layout and everyday editing across the tree, skills, items, calcs,
  configuration, and import/export screens.
- [PoB #10371](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10371)
  fixes item-stat sorting so hidden equipment slots cannot distort results, while
  also avoiding calculations for those slots.
- [PoB #10372](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10372)
  caches unique-item sort results until the build changes, making repeated sorts
  and search-filter updates much faster.
- [PoB #10373](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10373)
  skips cluster-passive work that Offence/Defence power mode never uses, reducing
  calculation time without changing power values.
- [PoB #10313](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313)
  skips the Full DPS and eHP stages of power-report calculations whose selected
  metric never reads them, without changing any reported value.
- [PoB #10381](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10381)
  fixes power-report cache correctness for radius jewels, masteries, cluster
  passives, tattoos, Timeless/conquered nodes, and structured modifiers.

The fork also carries focused PoB optimizations for gem-hover tooltips,
limited-unique comparisons, and radius-jewel comparisons (the calculation-only
portion of [PoB #9863](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/9863)).
These patches preserve PoB's calculation rules and are applied with exact source
and result checks. The complete maintained inventory is in
[`docs/BUNDLED_POB_CHANGES.md`](docs/BUNDLED_POB_CHANGES.md).

Power Reports also include the retained **relevance-pruning optimization**:
node additions that cannot affect the selected metric avoid a redundant
calculation. It applies to serial reports and browser helpers. The
[bundled change inventory](docs/BUNDLED_POB_CHANGES.md) records this required
local patch and the rules for carrying it through future bundles and releases.

### Improvements submitted to pob-web

The browser-runtime work developed here has also been submitted back to
`pob-web`:

- [pob-web #220](https://github.com/atty303/pob-web/pull/220) makes fonts sharper
  by aligning glyph bitmaps to physical pixels without changing text layout.
- [pob-web #221](https://github.com/atty303/pob-web/pull/221) reuses identical
  image resources, preventing repeated loads, idle redraws, and cache growth.
- [pob-web #222](https://github.com/atty303/pob-web/pull/222) avoids sending
  fully off-screen graphics to the GPU, especially when viewing the passive tree.
- [pob-web #223](https://github.com/atty303/pob-web/pull/223) reuses an unchanged
  rendered frame instead of rebuilding and resubmitting the same draw commands.
- [pob-web #224](https://github.com/atty303/pob-web/pull/224) starts independent
  font, data, and WebAssembly loading together and restores streaming startup.
- [pob-web #225](https://github.com/atty303/pob-web/pull/225) uses a more compact
  representation for Lua values, reducing memory used by tables and stack slots.
- [pob-web #226](https://github.com/atty303/pob-web/pull/226) caches repeated text
  measurements before they cross from WebAssembly into JavaScript.

This repository also adds more reliable high-frequency mouse input, lazy and
integrity-checked data loading, bounded helper workers for large unique-item
sorts, and targeted tooltip/calculation scheduling. These
changes keep the original PoB UI and math authoritative; technical details and
validation evidence live in [`upstream/PROVENANCE.md`](upstream/PROVENANCE.md).

## Local setup

You need Node.js 22, Deno 2.7.12, Docker, and Chrome. Docker supplies the pinned
Emscripten 6.0.6 toolchain, so a separate Emscripten installation is not needed.

```text
npm ci
npm run prepare
npm run test:native
npm run pack
npm run dev
```

Open <http://127.0.0.1:3010>. The development server is loopback-only by default;
`node scripts/dev/dev.mjs --lan` enables the explicit private-LAN HTTPS mode.
On Windows, use PowerShell and `npm.cmd` if the npm PowerShell shim is blocked by
script-execution policy.

The most useful validation commands are:

```text
npm run check
npm run test:unit
npm run test:e2e
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the repository map and
task-specific checks, and [`docs/RELEASING.md`](docs/RELEASING.md) for the
release process. Generated builds, prepared source, dependencies, browser
profiles, reports, credentials, and private build data must remain untracked.

## Current boundaries

Production is a static browser application. Build-code paste, build-file import,
public-account character import, and the build-link sources accepted by the
PoB Codes `/b/` importer are supported. Link imports and the one-click
`Launch in PoB.Codes` action use the existing guarded PoB Codes API; local
development keeps those network calls disabled. Character requests also go only
to existing guarded PoB Codes routes, which apply request bounds, rate limits,
cooldowns, and upstream error handling. The full `pob-web` application has an
Auth0-backed bridge for Path of Exile OAuth, but that application and its login
session are not part of this isolated static editor. Optional telemetry remains
disabled unless explicitly configured.

## License and attribution

The project is distributed under the [MIT License](LICENSE). It includes work
from `pob-web`, Path of Building, Lua, luautf8, and bundled fonts under their
respective licenses and notices. Keep [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md),
[`PATH_OF_BUILDING_LICENSE.md`](PATH_OF_BUILDING_LICENSE.md), and the vendored
notices with redistributed builds.

PoB Codes is an unofficial fan-made Path of Exile tool. Path of Exile and related
assets are © Grinding Gear Games. Not affiliated with or endorsed by Grinding
Gear Games. [Privacy](https://pob.codes/content/privacy) ·
[Terms](https://pob.codes/content/terms)
