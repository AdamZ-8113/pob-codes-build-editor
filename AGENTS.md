# Build Editor agent guidance

These instructions apply to the whole repository.

## Runtime invariants

- Preserve the standalone loopback default on `127.0.0.1:3010`, strict Host
  checks, and the explicit private-LAN HTTPS mode. Account OAuth remains
  loopback-only.
- The public deployment is static assets at `/import2/` under the existing
  `pob-codes-import2` Cloudflare resource. Do not add a Worker script, bindings,
  secrets, or Worker-first routing.
- Keep the production browser storage namespace
  `PoB Codes Import2 Preview v1` until an explicit migration is implemented.
- Do not weaken source, patch, package, payload, release, or predecessor hash
  checks. Never hand-edit generated payloads.
- Keep compiler output, dependencies, source checkouts, browser state, reports,
  credentials, private build codes, and captures untracked.

## Source ownership

`source-pin.json` and `upstream/PROVENANCE.md` are the authoritative source and
adaptation ledger. The original PoB calculations and Lua UI remain
authoritative. Browser compatibility and performance work belongs in the
driver/renderer or explicit checked adapters.

Official PoB updates are performed in this repository: update the pin, review
every overlay for drift or absorption, rebuild, and run the native/export/
browser gates. There is no automated or scheduled pob-web synchronization.

## Validation and release

Run `npm run check` and `npm run test:unit` for ordinary changes. Runtime,
payload, or release changes also require the applicable native, browser, and
release commands documented in `README.md`. Browser runs are always headless.

Deployments are maintainer-dispatched exact-SHA releases. The credentialed job
may deploy only the verified same-run artifact. A predecessor must come from a
durable release asset and pass full archive/inventory/config verification; do
not rebuild a predecessor or deploy when its bytes cannot be recovered.
