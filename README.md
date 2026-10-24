# PoB Codes Build Editor

Path of Building's original interface and calculation engine, running locally
in your browser. Built on [atty303/pob-web](https://github.com/atty303/pob-web)
with additional editing, rendering, and performance improvements.

**[Open the editor →](https://pob.codes/browserpob/)**

## What this fork improves

- Easier editing across the tree, skills, items, calcs, and import/export screens.
- Faster item sorting, tooltips, and Power Reports, with calculation and cache fixes.
- Sharper text, smoother input, faster loading, and less rendering and memory overhead.

PoB's original UI and calculation rules remain authoritative. See the
[bundled PoB changes](docs/BUNDLED_POB_CHANGES.md) and
[performance findings](docs/performance/README.md) for details.

<details>
<summary>Upstream contributions</summary>

Work from this project has also been submitted upstream:

- **Path of Building:**
  [editing and layout](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10360),
  [item-stat sorting](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10371),
  [unique-item caching](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10372),
  [cluster power calculations](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10373),
  [power-report calculations](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313),
  and [power-report cache fixes](https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10381).
- **pob-web:**
  [sharper fonts](https://github.com/atty303/pob-web/pull/220),
  [image reuse](https://github.com/atty303/pob-web/pull/221),
  [off-screen culling](https://github.com/atty303/pob-web/pull/222),
  [frame reuse](https://github.com/atty303/pob-web/pull/223),
  [parallel loading](https://github.com/atty303/pob-web/pull/224),
  [lower Lua memory use](https://github.com/atty303/pob-web/pull/225),
  and [text-measurement caching](https://github.com/atty303/pob-web/pull/226).

</details>

## Local setup

You need Node.js 22, Deno 2.7.12, Docker, and Chrome. Docker supplies Emscripten 6.0.6.

```text
npm ci
npm run prepare
npm run test:native
npm run pack
npm run dev
```

Open <http://127.0.0.1:3010>. The server is loopback-only by default; use
`node scripts/dev/dev.mjs --lan` for private-LAN HTTPS. On Windows, use
`npm.cmd` if PowerShell blocks `npm`.

Common checks:

```text
npm run check
npm run test:unit
npm run test:e2e
```

See the [development guide](docs/DEVELOPMENT.md) for task-specific checks and the
[release guide](docs/RELEASING.md) for publishing. Keep generated files,
dependencies, browser profiles, reports, credentials, and private build data untracked.

## Imports and storage

The hosted editor supports build codes, build files, public-account character
imports, and build links supported by PoB Codes. Link imports, character imports,
and the `Open Build` / `Desktop PoB` actions use the PoB Codes API. These network
integrations are disabled in local development. The hosted editor does not include
Path of Exile account login. Optional telemetry is disabled unless configured.

**Import Folder** copies lower-case `.xml` builds and their folder layout into
browser-local storage. Files stay on this device and browser profile, even if
the browser calls folder selection an upload. The copy does not sync with the
original folder or other devices.

## License and attribution

Distributed under the [MIT License](LICENSE), with third-party code and fonts
under their respective licenses. Keep the [third-party notices](THIRD_PARTY_NOTICES.md),
[Path of Building license](PATH_OF_BUILDING_LICENSE.md), and vendored notices
with redistributed builds. Exact sources and patch hashes are recorded in
[`source-pin.json`](source-pin.json) and [provenance](upstream/PROVENANCE.md).

PoB Codes is an unofficial fan-made Path of Exile tool. Path of Exile and related
assets are © Grinding Gear Games. Not affiliated with or endorsed by Grinding
Gear Games. [Privacy](https://pob.codes/content/privacy) ·
[Terms](https://pob.codes/content/terms)
