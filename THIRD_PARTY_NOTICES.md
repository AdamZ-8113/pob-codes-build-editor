# Third-party notices

This project is an adopted and modified browser runtime, not a clean-room
implementation.

- `upstream/` is based on `atty303/pob-web` revision
  `db9fd4a097476039387261e3aabc4cd08d3747a3` under the MIT License. See
  `upstream/LICENSE` and `upstream/PROVENANCE.md`.
- The packaged Path of Building source is fetched from
  `PathOfBuildingCommunity/PathOfBuilding` at the revision in
  `source-pin.json`. `PATH_OF_BUILDING_LICENSE.md` is the exact `LICENSE.md`
  blob from that revision; `PATH_OF_BUILDING_LICENSE.provenance.json` pins its
  source path and SHA-256. Both files are included and verified in every new
  immutable release generation.
- Vendored Lua and luautf8 source retain their embedded licenses under
  `upstream/vendor/`.
- Font licenses and copyright notices are reproduced in
  `upstream/NOTICE.md`.

Release archives include `LICENSE`, this file, the exact pinned Path of
Building license and provenance, and the detailed pob-web license/provenance
files. Keep those files with redistributed builds.
