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
- The Liberation Sans and Bitstream Vera Sans Mono font licenses and copyright
  notices are reproduced in `upstream/NOTICE.md`. Fontin is listed below.

Release archives include `LICENSE`, this file, the exact pinned Path of
Building license and provenance, and the detailed pob-web license/provenance
files. Keep those files with redistributed builds.

## Shipped components

The editor's About dialog (`index.html`) lists the same components. Package
versions are the ones locked in `upstream/deno.lock`.

### Path of Building payload

- Path of Building Community, Copyright (c) 2016 David Gowor, MIT License.
- Lua libraries shipped in Path of Building's `runtime/lua`: `base64.lua`
  (Copyright (c) 2009 Alex Kloss, LGPL2 per its header), `dkjson.lua`
  (Copyright (C) 2010-2013 David Heiko Kolf, MIT), `lua-profiler.lua`
  (Copyright (c) 2018-2020 Charles Mallah, MIT; based on ProFi, Copyright (c)
  2012 Luke Perkin, MIT), `sha1` (Copyright (c) 2013 Enrique García Cota, Eike
  Decker, Jeffrey Friedl; Copyright (c) 2018 Peter Melnichenko; MIT) and
  `xml.lua` (Copyright (c) 2016 David Gowor, MIT).

The full texts are in `PATH_OF_BUILDING_LICENSE.md`. Its desktop-only
components (Update.exe's Lua interpreter, Lua-cURL, libcurl, SimpleGraphic,
the Khronos and GLEXT headers, LuaJIT, fmtlib, libsodium, re2, abseil, ANGLE,
stb, libjpeg-turbo and GIFLIB) are not part of this browser build.

### WebAssembly driver (`driver.wasm`)

- Lua 5.2.4, Copyright (C) 1994-2015 Lua.org, PUC-Rio, MIT
  (`upstream/vendor/lua/lua.h`).
- luautf8, Copyright (c) 2018 Xavier Wang, MIT
  (`upstream/vendor/luautf8/LICENSE`).
- Emscripten runtime, system libraries and WasmFS (including the adapted
  `upstream/packages/driver/src/c/wasmfs/` files), Copyright The Emscripten
  Authors, MIT or University of Illinois/NCSA Open Source License:
  <https://github.com/emscripten-core/emscripten/blob/main/LICENSE>.
- musl libc, Copyright Rich Felker, et al., MIT:
  <https://github.com/emscripten-core/emscripten/blob/main/system/lib/libc/musl/COPYRIGHT>.
- LLVM libc++ and libc++abi, Apache License v2.0 with LLVM Exceptions:
  <https://github.com/llvm/llvm-project/blob/main/libcxx/LICENSE.TXT>.
- mimalloc (`-sMALLOC=mimalloc`), Copyright Microsoft Corporation, Daan
  Leijen, MIT: <https://github.com/microsoft/mimalloc/blob/master/LICENSE>.
- zlib (`-sUSE_ZLIB`), Copyright Jean-loup Gailly and Mark Adler, zlib License:
  <https://zlib.net/zlib_license.html>.

### Fonts (`upstream/packages/driver/public/`)

- Liberation Sans, Digitized data copyright (c) 2010 Google Corporation;
  Copyright (c) 2012 Red Hat, Inc.; SIL Open Font License 1.1.
- Bitstream Vera Sans Mono, Copyright (c) 2003 by Bitstream, Inc.; Bitstream
  Vera Fonts license.
- Fontin (Regular, Italic and SmallCaps) by Jos Buivenga (exljbris). The font
  files carry "Copyright (c) Jos Buivenga, 2004. All rights reserved." and no
  license text; this repository does not include a separate license for them.

### Browser JavaScript and CSS bundle

- React 18.3.1, React DOM 18.3.1 and Scheduler 0.23.2, Copyright (c)
  Facebook, Inc. and its affiliates, MIT.
- react-icons 5.7.0, Copyright 2018 kamijin_fanta, MIT. The editor uses icons
  from Circum Icons (MPL-2.0), Heroicons 2 (MIT), Material Design icons
  (Apache License 2.0) and Phosphor Icons (MIT), as listed in react-icons'
  `LICENSE`.
- [ZenFS](https://github.com/zen-fs/core), Licensed under the
  [LGPL 3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html) and
  [COPYING.md](https://github.com/zen-fs/core/blob/main/COPYING.md), Copyright
  © James Prevett and other ZenFS contributors (`@zenfs/core` 2.6.2).
- [@zenfs/dom](https://github.com/zen-fs/dom), Licensed under the
  [LGPL 3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html) and
  [COPYING.md](https://github.com/zen-fs/dom/blob/main/COPYING.md), Copyright
  © James Prevett and other ZenFS contributors (1.2.10).
- [@zenfs/archives](https://github.com/zen-fs/archives), Licensed under the
  [LGPL 3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html) and
  [COPYING.md](https://github.com/zen-fs/archives/blob/main/COPYING.md),
  Copyright © James Prevett and other ZenFS contributors (1.4.0).
- memium 0.4.5 and utilium 3.5.0 by James Prevett, LGPL-3.0-or-later; kerium
  1.4.2 by James Prevett, MIT (package metadata; the package has no license
  file).
- Comlink 4.4.2, Copyright Google LLC, Apache License 2.0.
- fflate 0.8.3, Copyright (c) Arjun Barrett, MIT.
- @bokuweb/zstd-wasm 0.0.22, MIT (package metadata; the package has no
  license file). Its WebAssembly module is built from Zstandard, Copyright (c)
  Meta Platforms, Inc. and affiliates, BSD License:
  <https://github.com/facebook/zstd/blob/dev/LICENSE>.
- texture2ddecoder-wasm 1.2.2, Copyright (c) 2024 K0lb3, MIT, with codecs from
  AssetStudio, mikunyan and FP16 (MIT), Crunch (public domain) and Unity
  Crunch (zlib) as listed in its `LICENSE`.
- Node.js compatibility packages: buffer 6.0.3 (Copyright (c) Feross
  Aboukhadijeh and other contributors, MIT), safe-buffer 5.2.1 (Copyright (c)
  Feross Aboukhadijeh, MIT), ieee754 1.2.1 (Copyright 2008 Fair Oaks Labs,
  Inc., BSD-3-Clause), base64-js 1.5.1 (Copyright (c) 2014 Jameson Little,
  MIT), readable-stream 4.7.0 and string_decoder 1.3.0 (Copyright Node.js
  contributors; Copyright Joyent, Inc. and other Node contributors; MIT),
  events 3.3.0 (Copyright Joyent, Inc. and other Node contributors, MIT),
  process 0.11.10 (Copyright (c) 2013 Roman Shtylman, MIT), eventemitter3
  5.0.4 (Copyright (c) 2014 Arnout Kazemier, MIT) and abort-controller 3.0.0
  (Copyright (c) 2017 Toru Nagashima, MIT).
- missionlog, Copyright (c) 2019-2022 Ray Martone, MIT, adapted in
  `upstream/packages/driver/src/js/logger.ts` with its notice.
- Tailwind CSS 4.3.3, Copyright (c) Tailwind Labs, Inc., MIT; daisyUI 5.7.16,
  Copyright (c) 2020 Pouya Saadeghi, MIT.
- Vite 6.4.3 runtime helpers (module preload and CommonJS interop), Copyright
  (c) 2019-present, VoidZero Inc. and Vite contributors, MIT. Vite's
  `LICENSE.md` also covers the bundled `@rollup/plugin-commonjs` helpers (MIT).
