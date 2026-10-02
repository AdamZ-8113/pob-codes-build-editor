# Build Editor agent template

Copy this file to `AGENTS.md` for local agent use. The local file is ignored by
Git; keep durable contributor rules in tracked docs.

These instructions apply to the whole repository.

## Intent and scope

- Treat questions as requests to investigate and explain. Treat explicit action
  words such as fix, change, add, remove, implement, or update as permission to
  edit within the named scope.
- Preserve unrelated work in a dirty checkout. Do not reset, discard, stage, or
  commit changes that do not belong to the active task.
- Use `README.md` for ordinary setup and commands, `docs/DEVELOPMENT.md` for the
  repository map and validation routing, `docs/RELEASING.md` for release or
  deployment work, and `upstream/PROVENANCE.md` for adopted-runtime changes.
  Read only the documents relevant to the task.

## Source authority

- Path of Building's Lua UI and calculations remain authoritative. Prefer
  browser compatibility changes in the driver, renderer, or an explicit,
  hash-checked adapter rather than changing calculation behavior.
- `source-pin.json` and `upstream/PROVENANCE.md` own the upstream revisions,
  overlays, result hashes, licenses, and local adaptations. Review every
  overlay for drift or upstream absorption when a pin changes.
- Do not edit prepared source, generated payloads, compiler output, or generated
  Path of Building data. Change the source/generator or checked adapter and
  regenerate the derived output.
- Avoid loading large generated Data, TreeData, payload, manifest, report, or
  asset trees wholesale. Prefer focused searches, ledgers, generators, and
  representative fixtures.

## Runtime and privacy boundaries

- Preserve the loopback default on `127.0.0.1:3010`, strict Host checks, and the
  explicit private-LAN HTTPS mode. Account OAuth remains loopback-only.
- Production is static assets under the `pob-codes-import2` Cloudflare resource.
  Do not add a Worker script, binding, secret, runtime relay, or Worker-first
  route without an explicitly reviewed architecture change.
- Keep the storage namespace `PoB Codes Import2 Preview v1` until an explicit
  migration is implemented.
- Keep dependencies, `.runtime/`, prepared source, browser state, reports,
  credentials, captures, and private build/account/character data untracked.

## Validation and completion

- Local tests use disposable public fixtures and have no production access.
  Run affected tests, fix failures caused by the task, and rerun them without
  asking for approval at every step.
- Ordinary changes run `npm run check` and `npm run test:unit`. Native, payload,
  browser, performance, and release changes add the applicable commands from
  `docs/DEVELOPMENT.md`. Browser automation is headless.
- When changing imported Path of Building behavior, preserve upstream test
  expectations and use focused LuaJIT/Busted evidence when the affected logic
  is covered upstream.
- This public repository produces exact-SHA release artifacts and must not
  receive production credentials. A separate private operator owns deployment,
  predecessor recovery, fixed-target configuration and live verification. Never
  execute public-repo code in a credentialed deployment runner or rebuild a
  predecessor. Follow `docs/RELEASING.md` for the artifact handoff.
